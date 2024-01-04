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

function isInstaKill(actor) {
    const lMes = lastDamageMessage(actor);
    if (!lMes) {return false;}
    const totalDamage = lMes?.rolls?.[0]?.total ?? 0;

    return totalDamage >= (actor.attributes.hp.temp + actor.attributes.hp.max*2)
        || (actor.attributes.hp.value === 0 && lMes?.item?.traits?.has('death'));
}

function lastDamageMessage(actor) {
    return game.messages.contents.slice(-15).findLast(m=>
        (m?.flags?.pf2e?.context?.type === "damage-roll" && m?.flags?.pf2e?.context?.sourceType === "attack" && m?.flags?.pf2e?.context?.target?.actor === actor.uuid)
        || (m?.flags?.pf2e?.context?.type === "saving-throw" && m?.flags?.pf2e?.context?.actor === actor.id)
         || (m?.flags?.pf2e?.context?.type === "damage-roll" && m?.flags?.pf2e?.context?.sourceType === "save" ));
}

function isDamageCrit(actor) {
     const lDam = lastDamageMessage(actor);
     if (lDam) {
        if (lDam.flags.pf2e.context.type === "damage-roll") {
            return criticalSuccessMessageOutcome(lDam);
        }
        return criticalFailureMessageOutcome(lDam);
     }
     return false;
}

async function setMaxDying(actor, isMax=false) {
    await actor.increaseCondition('dying', {'value': actor.attributes.dying.max});
    ChatMessage.create({
        flavor: isMax ? `${actor.name} is dead because of max dying condition` : `${actor.name} is dead because of damage`,
        speaker: ChatMessage.getSpeaker({ actor }),
    }).then();
}

async function heroicRecovery(actor) {
    const dying = hasCondition(actor, "dying");
    if (!dying) {
        ui.notifications.info("Need to have Dying condition"); return;
        return;
    }
    if (actor.system.resources.heroPoints.value === 0) {
        ui.notifications.info("Need to have at least 1 Hero Point"); return;
        return;
    }
    await actor.update({ "system.resources.heroPoints.value": 0 });

    await dying.setFlag(moduleName, "heroicRecovery", true);
    await dying.delete();

    ui.notifications.info("Hero was recovered!");
}

function rotateActor(actor, isDead=true) {
    if (!game.settings.get(moduleName, "rotate")) { return }
    let tokens = actor.getActiveTokens(true, false)

    for (const t of tokens) {
        t.rotate(isDead ? -90 : 0)
    }
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
    game.settings.register(moduleName, "rotate", {
        name: "Rotate Token when has Dying Unconscious",
        scope: "world",
        config: true,
        default: false,
        type: Boolean,
    });

    game.pf2eDying = mergeObject(game.pf2eDying ?? {}, {
        "heroicRecovery": heroicRecovery,
    })
});

Hooks.on('createChatMessage', async (message) => {
    if (!game.user.isGM) {return}
    if ('appliedDamage' in message.flags.pf2e && message.flags.pf2e.appliedDamage === null
        && message.content?.includes("damage-taken") && message.content?.includes("0 damage")) {
        const {actor} = message;
        if (actor && actor.system.attributes.hp.value === 0) {
            if (game.settings.get(moduleName, "checkNonLethal") && isDamageNonLethal(actor.uuid)) {
                return;
            }
            if (isInstaKill(actor)) {
                setMaxDying(actor);
            } else {
                const dyingValue = actor.getCondition("dying")?.value ?? 0;
                let val = dyingValue + (isDamageCrit(actor) ? 2 : 1);
                if (val > actor.attributes.dying.max) {
                    val = actor.attributes.dying.max;
                }
                if (val === actor.attributes.dying.max) {
                    setMaxDying(actor, true);
                    return
                }
                await actor.increaseCondition('dying',{'value':  val})
            }
        }
    }
});

Hooks.on('updateActor', async (actor, data, diff, id) => {
    if (!game.user.isGM) {return}
    if (data?.system?.attributes?.hp?.value === 0 && "npc" === actor?.type) {
        await actor.combatant?.toggleDefeated();
        return
    }

    if (data?.system?.attributes?.hp?.value > 0 && hasCondition(actor, "dying")) {
        await actor.decreaseCondition('dying', {forceRemove:true})
        if (hasCondition(actor, "unconscious")) {
            await actor.decreaseCondition('unconscious');
        }
    }

    if (game.settings.get(moduleName, "removeUnconsciousWhenHeal")) {
        if (data?.system?.attributes?.hp?.value > 0 && (data.system.attributes.hp.value + diff.damageTaken) === 0) {
            if (hasCondition(actor, "unconscious") && !hasCondition(actor, "dying")) {
                await actor.decreaseCondition('unconscious')
            }
        }
    }

    if (game.settings.get(moduleName, "addDeathCondition")) {
        if (data?.system?.attributes?.hp?.value === 0 && ["character", "familiar"].includes(actor?.type) && !hasCondition(actor, "dying") && !actor.traits.has('eidolon')) {
            if (game.settings.get(moduleName, "checkNonLethal") && isDamageNonLethal(actor.uuid)) {
                if (!hasCondition(actor, "unconscious")) {
                    await actor.increaseCondition('unconscious');
                }
                return;
            }
            if (isInstaKill(actor)) {
                setMaxDying(actor);
            } else {
                let val = (actor.getCondition("wounded")?.value ?? 0) + (isDamageCrit(actor) ? 2 : 1);
                if (val > actor.attributes.dying.max) {
                    val = actor.attributes.dying.max;
                }
                if (val === actor.attributes.dying.max) {
                    setMaxDying(actor, true);
                    return
                }
                await actor.increaseCondition('dying',{'value': val})
            }
        }
    }
});

Hooks.on('deleteItem', async (item, data, diff, id) => {
    if (!game.user.isGM) {return}
    if (game.settings.get(moduleName, "addUnconsciousZeroHP") && item.slug === 'dying') {
        if (item.actor?.system?.attributes?.hp?.value === 0 && !hasCondition(item.actor, "unconscious")) {
            await item.actor.increaseCondition('unconscious');
        }
    }
    if (game.settings.get(moduleName, "addWounded") && item.slug === 'dying' && !item.getFlag(moduleName, "heroicRecovery")) {
        await item.actor.increaseCondition('wounded',{'value': (item.actor.getCondition("wounded")?.value ?? 0) + 1})
    }

    if (item.slug === 'unconscious') {
        rotateActor(item.actor, false)
    }
});

Hooks.on('createItem', (item, data, diff, id) => {
    if (!game.user.isGM) {return}
    if (!item.actor) {return}
    if (!(item.slug === 'unconscious')) { return }
    rotateActor(item.actor)
});