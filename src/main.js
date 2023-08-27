const moduleName = "pf2e-dying";

function hasCondition(actor, con) {
    return actor?.itemTypes?.condition?.find((c => c.type === "condition" && con === c.slug))
}

function criticalSuccessMessageOutcome(message) {
    return "criticalSuccess" === message?.flags?.pf2e?.context?.outcome;
}

function criticalFailureMessageOutcome(message) {
    return "criticalFailure" === message?.flags?.pf2e?.context?.outcome;
}

function isDamageNonLethal(uuid) {
     const lDam = game.messages.contents.slice(-10)
        .findLast(m=>m?.flags?.pf2e?.context?.type === "damage-roll" && m?.flags?.pf2e?.context?.sourceType === "attack" && m?.flags?.pf2e?.context?.target?.actor === uuid);
     if (lDam) {
        return (Number(lDam.content) > 0) && lDam?.item?.traits?.has('nonlethal')
     }
     return false;
}

function totalDamage(actorId, uuid) {
    return game.messages.contents.slice(-15).findLast(m=>
        (m?.flags?.pf2e?.context?.type === "damage-roll" && m?.flags?.pf2e?.context?.sourceType === "attack" && m?.flags?.pf2e?.context?.target?.actor === uuid)
        || (m?.flags?.pf2e?.context?.type === "saving-throw" && m?.flags?.pf2e?.context?.actor === actorId))?.rolls?.[0]?.total ?? 0;
}

function isDamageCrit(actorId, uuid) {
     const lDam = game.messages.contents.slice(-15).findLast(m=>
        (m?.flags?.pf2e?.context?.type === "damage-roll" && m?.flags?.pf2e?.context?.sourceType === "attack" && m?.flags?.pf2e?.context?.target?.actor === uuid)
        || (m?.flags?.pf2e?.context?.type === "saving-throw" && m?.flags?.pf2e?.context?.actor === actorId));
     if (lDam) {
        if (lDam.flags.pf2e.context.type === "damage-roll") {
            return criticalSuccessMessageOutcome(lDam);
        }
        return criticalFailureMessageOutcome(lDam);
     }
     return false;
}

async function setMaxDying(actor) {
    await actor.increaseCondition('dying', {'value': actor.attributes.dying.max});
    ChatMessage.create({
        flavor: `${actor.name} is dead because of damage`,
        speaker: ChatMessage.getSpeaker({ actor }),
    }).then();
}

Hooks.once("init", () => {
    game.settings.register(moduleName, "addDeathCondition", {
        name: "Add dying condition at zero hp",
        hint: "Add dying condition (for PC + familiar)",
        scope: "world",
        config: true,
        default: false,
        type: Boolean,
    });
    game.settings.register(moduleName, "addUnconsciousZeroHP", {
        name: "Add unconscious condition at zero hp",
        hint: "Auto add unconscious if dying is removed but still at zero hp (for all actor)",
        scope: "world",
        config: true,
        default: false,
        type: Boolean,
    });
    game.settings.register(moduleName, "removeUnconsciousWhenHeal", {
        name: "Remove unconscious when actor is healed",
        hint: "Auto remove unconscious if healed above 0 hp (for all actor)",
        scope: "world",
        config: true,
        default: false,
        type: Boolean,
    });
    game.settings.register(moduleName, "addWounded", {
        name: "Add wounded when dying is removed",
        hint: "Auto increase wounded condition when dying is removed",
        scope: "world",
        config: true,
        default: false,
        type: Boolean,
    });
    game.settings.register(moduleName, "checkNonLethal", {
        name: "Check  Non-lethal damage",
        hint: "Non-lethal damage doesn't add dying but unconscious when set to 0 hp",
        scope: "world",
        config: true,
        default: false,
        type: Boolean,
    });
});

Hooks.on('updateActor', async (actor, data, diff, id) => {
    if (data?.system?.attributes?.hp?.value > 0 && hasCondition(actor, "dying")) {
        await actor.toggleCondition('dying')
        if (hasCondition(actor, "unconscious")) {
            await actor.decreaseCondition('unconscious');
        }
    }
});

Hooks.on('updateActor', async (actor, data, diff, id) => {
    if (data?.system?.attributes?.hp?.value === 0 && "npc" === actor?.type) {
            await actor.combatant?.toggleDefeated();
//        if (!hasCondition(actor, "dying")) {
//            await actor.toggleCondition('dying');
//        }
    }
});

Hooks.on('createChatMessage', async (message) => {
    if ('appliedDamage' in message.flags.pf2e && message.flags.pf2e.appliedDamage === null
        && message.content?.includes("damage-taken") && message.content?.includes("0 damage")) {
        const {actor} = message;
        if (actor && actor.system.attributes.hp.value === 0) {
            if (game.settings.get(moduleName, "checkNonLethal") && isDamageNonLethal(actor.uuid)) {
                return;
            }
            if (totalDamage(actor.id, actor.uuid) >= (actor.attributes.hp.temp + actor.attributes.hp.max*2)) {
                setMaxDying(actor);
            } else {
                const dyingValue = actor.getCondition("dying")?.value ?? 0;
                await actor.increaseCondition('dying',{'value': dyingValue + (isDamageCrit(actor.id, actor.uuid) ? 2 : 1) })
            }
        }
    }
});

Hooks.on('updateActor', async (actor, data, diff, id) => {
    if (!game.settings.get(moduleName, "addDeathCondition")) {return;}
    if (data?.system?.attributes?.hp?.value === 0 && ["character", "familiar"].includes(actor?.type) && !hasCondition(actor, "dying")) {
        if (game.settings.get(moduleName, "checkNonLethal") && isDamageNonLethal(actor.uuid)) {
            if (!hasCondition(actor, "unconscious")) {
                await actor.increaseCondition('unconscious');
            }
            return;
        }
        if (totalDamage(actor.id, actor.uuid) >= (actor.attributes.hp.temp + actor.attributes.hp.max*2)) {
            setMaxDying(actor);
        } else {
            await actor.increaseCondition('dying',{'value': (actor.getCondition("wounded")?.value ?? 0) + 1})
        }
    }
});

Hooks.on('updateActor', async (actor, data, diff, id) => {
    if (!game.settings.get(moduleName, "removeUnconsciousWhenHeal")) {return;}
    if (data?.system?.attributes?.hp?.value > 0 && (data.system.attributes.hp.value + diff.damageTaken) === 0) {
        if (hasCondition(actor, "unconscious") && !hasCondition(actor, "dying")) {
            await actor.toggleCondition('unconscious')
        }
    }
});

Hooks.on('deleteItem', async (item, data, diff, id) => {
    if (!game.settings.get(moduleName, "addUnconsciousZeroHP")) {return;}
    if (item.slug != 'dying'){return;}
    if (item.actor?.system?.attributes?.hp?.value === 0 && !hasCondition(item.actor, "unconscious")) {
        await item.actor.increaseCondition('unconscious');
    }
});

Hooks.on('deleteItem', async (item, data, diff, id) => {
    if (!game.settings.get(moduleName, "addWounded")) {return;}
    if (item.slug != 'dying'){return;}
    await item.actor.increaseCondition('wounded',{'value': (item.actor.getCondition("wounded")?.value ?? 0) + 1})
});