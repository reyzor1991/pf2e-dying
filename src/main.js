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
    const lDam = lastDamageMessage(uuid)
    if (lDam) {
        return (Number(lDam.content) > 0) && lDam?.item?.traits?.has('nonlethal')
    }
    return false;
}

function isInstantKill(actor) {
    const lMes = lastDamageMessage(actor.uuid);
    if (!lMes) {
        return false;
    }
    const totalDamage = lMes?.rolls?.[0]?.total ?? 0;

    return totalDamage >= (actor.attributes.hp.temp + actor.attributes.hp.max * 2)
        || (actor.attributes.hp.value === 0 && lMes?.item?.traits?.has('death'));
}

function lastDamageMessage(uuid) {
    return game.messages.contents.slice(-3).findLast(m =>
            m?.flags?.pf2e?.context?.type === "damage-roll"
            && (
                (m?.flags?.pf2e?.context?.sourceType === "attack" && m?.flags?.pf2e?.context?.target?.actor === uuid)
                || m?.flags?.pf2e?.context?.sourceType === "save"
            )
    );
}

function isDamageCritical(actor) {
    const lDam = lastDamageMessage(actor.uuid);
    if (lDam) {
        if (lDam.flags.pf2e.context.sourceType === "attack") {
            return criticalSuccessMessageOutcome(lDam);
        }
        let lastSave = game.messages.contents.slice(-15).findLast(m =>
            m.item === lDam.item && m.flags.pf2e?.context?.type === "saving-throw"
            && m.actor?.uuid === actor.uuid
        )
        return criticalFailureMessageOutcome(lastSave);
    }
    return false;
}

async function setMaxDying(actor, isMax = false) {
    await actor.increaseCondition('dying', {'value': actor.attributes.dying.max});
    ChatMessage.create({
        flavor: isMax ? `${actor.name} is dead because of max dying condition` : `${actor.name} is dead because of damage`,
        speaker: ChatMessage.getSpeaker({actor}),
    }).then();
}

async function heroicRecovery(actor) {
    const dying = hasCondition(actor, "dying");
    if (!dying) {
        ui.notifications.info("Need to have Dying condition");
        return;
    }
    if (actor.system.resources.heroPoints.value === 0) {
        ui.notifications.info("Need to have at least 1 Hero Point");
        return;
    }
    await actor.update({"system.resources.heroPoints.value": 0});

    await dying.setFlag(moduleName, "heroicRecovery", true);
    await dying.delete();

    ui.notifications.info("Hero was recovered!");
}

async function changeInitiative(combatant) {
    if (!combatant) {
        return
    }
    if (!game.combat || !game.combat.combatant) {
        return
    }
    if (!game.settings.get(moduleName, "move")) {
        return
    }
    if (game.combat?.combatant === combatant) {
        return
    }

    let current = game.combat.combatant.initiative

    let previous = game.combat.combatants
        .map(c => c.initiative || 0)
        .sort((a, b) => a - b)
        .find(i => i > current)

    const initiative = !previous || previous < current ? current + 1 : (previous + current) / 2;
    game.combat.setInitiative(combatant.id, initiative)
}

Hooks.once("init", () => {
    game.settings.register(moduleName, "checkNonLethal", {
        name: "Check  Non-lethal damage",
        hint: "Non-lethal damage doesn't add dying but unconscious when set to 0 hp",
        scope: "world",
        config: true,
        default: false,
        type: Boolean,
    });
    game.settings.register(moduleName, "move", {
        name: "Change initiative when get dying condition",
        scope: "world",
        config: true,
        default: false,
        type: Boolean,
    });
    game.settings.register(moduleName, "rotateState", {
        name: "Rotate Token when has condition",
        scope: "world",
        config: true,
        type: String,
        choices: {
            no: 'No Rotate',
            unconscious: 'Unconscious',
            unconsciousProne: 'Unconscious or Prone',
        },
        default: "no",
    });
    game.settings.register(moduleName, "unconsciousLayer", {
        name: "Add unconscious layer when actor is dying",
        scope: "world",
        config: true,
        default: false,
        type: Boolean,
        onChange: (value) => {
            if (!value) {
                game.actors.forEach(a => {
                    a.effects.find(a => a.statuses.has('unconscious'))?.delete()
                })
            }
        },
    });
    game.settings.register(moduleName, "deactivateRegeneration", {
        name: "Deactivate Regeneration when creature has max dying condition",
        hint: "Not rollback operation",
        scope: "world",
        config: true,
        default: false,
        type: Boolean,
    });

    game.pf2eDying = foundry.utils.mergeObject(game.pf2eDying ?? {}, {
        "heroicRecovery": heroicRecovery,
    })

    let origin = CONFIG.ActiveEffect.documentClass.prototype._preCreate;
    CONFIG.ActiveEffect.documentClass.prototype._preCreate = async (data, operation, user) => {
        return data.statuses.includes("dead") || data.statuses.includes("unconscious")
            ? true
            : origin.call(this, data, operation, user)
    }
});

Hooks.on('createChatMessage', async (message) => {
    if (!isGM()) {
        return
    }
    if ('appliedDamage' in message.flags.pf2e && message.flags.pf2e.appliedDamage && !message.flags.pf2e.appliedDamage.isHealing
        && message.content?.includes("damage-taken") && message.content.match(/takes (?![0]\b)\d{1,4} damage/)
        && message.flags.pf2e.appliedDamage.updates.length === 0
    ) {
        const {actor} = message;
        if (actor && actor.system.attributes.hp.value === 0) {
            if (game.settings.get(moduleName, "checkNonLethal") && isDamageNonLethal(actor.uuid)) {
                return;
            }
            if (isInstantKill(actor)) {
                await setMaxDying(actor);
            } else {
                const dyingValue = actor.getCondition("dying")?.value ?? 0;
                let val = (isDamageCritical(actor) ? 2 : 1);
                if ((dyingValue + val) >= actor.attributes.dying.max) {
                    await setMaxDying(actor, true);
                    return
                }
                await actor.increaseCondition('dying', {'value': val})
            }
        }
    }
});

Hooks.on('preUpdateActor', (actor, data) => {
    if (actor.system?.attributes?.hp?.value === 0 && data?.system?.attributes?.hp?.value > 0) {
        if (hasCondition(actor, "unconscious") && !hasCondition(actor, "dying")) {
            actor.decreaseCondition('unconscious')
        }
        actor.effects.find(a => a.statuses.has('unconscious'))?.delete()
    } else if (actor.system?.attributes?.hp?.value > 0 && data?.system?.attributes?.hp?.value > 0) {
        actor.effects.find(a => a.statuses.has('unconscious'))?.delete()
    }
});

Hooks.on('updateActor', async (actor, data) => {
    if (!isGM()) {
        return
    }
    if (data?.system?.attributes?.hp?.value === 0 && actor?.isOfType('npc')) {
        toggleActorDead(actor)
        return
    }

    if (data?.system?.attributes?.hp?.value > 0 && hasCondition(actor, "dying")) {
        await actor.decreaseCondition('dying', {forceRemove: true})
        if (hasCondition(actor, "unconscious")) {
            await actor.decreaseCondition('unconscious');
        }
        actor.effects.find(a => a.statuses.has('unconscious'))?.delete()
    }

    if (data?.system?.attributes?.hp?.value === 0 && ["character", "familiar"].includes(actor?.type) && !hasCondition(actor, "dying") && !actor.traits.has('eidolon')) {
        if (game.settings.get(moduleName, "checkNonLethal") && isDamageNonLethal(actor.uuid)) {
            if (!hasCondition(actor, "unconscious")) {
                await actor.increaseCondition('unconscious');
            }
            await toggleActorDead(actor)
            return;
        }
        if (isInstantKill(actor)) {
            await setMaxDying(actor);
        } else {
            let val = (actor.getCondition("wounded")?.value ?? 0) + (isDamageCritical(actor) ? 2 : 1);
            if (val > actor.attributes.dying.max) {
                val = actor.attributes.dying.max;
            }
            if (val === actor.attributes.dying.max) {
                await setMaxDying(actor, true);
            } else {
                await actor.increaseCondition('dying', {'value': val})
            }
        }
        await toggleActorDead(actor)
    }
});

async function toggleActorDead(actor) {
    if (actor.prototypeToken.actorLink) {
        await toggleLinkedActorDead(actor)
    } else if (actor.combatant) {
        await actor.combatant.toggleDefeated();
    } else {
        await actor.toggleStatusEffect("dead", {overlay: true});
    }

    if (actor.combatant && actor.combatant.actor === actor) {
        await changeInitiative(actor.combatant);
    }
}

async function toggleLinkedActorDead(actor) {
    if (!game.settings.get(moduleName, "unconsciousLayer")) {
        return
    }
    if (actor.effects.find(a => a.statuses.has('unconscious'))) {
        return
    }
    let effect = await ActiveEffect.implementation.fromStatusEffect("unconscious");
    effect.img = 'icons/svg/unconscious.svg'
    effect._source.img = 'icons/svg/unconscious.svg'
    effect.updateSource({"flags.core.overlay": true})

    ActiveEffect.implementation.create(effect, {parent: actor, keepId: true});
}

Hooks.on('deleteItem', async (item) => {
    if (!isGM()) {
        return
    }
    if (
        item.slug === 'dying' && item.actor?.system?.attributes?.hp?.value === 0 && !hasCondition(item.actor, "unconscious")) {
        await item.actor.increaseCondition('unconscious');
    }
    if (
        item.slug === 'dying' && !item.getFlag(moduleName, "heroicRecovery")) {
        await item.actor.increaseCondition('wounded')
    }

    if (['unconscious', 'prone'].includes(item.slug)) {
        await rotateActor(item.actor)
    }
});

Hooks.on('createItem', async (item) => {
    if (!isGM() || !item.actor) {
        return
    }
    if (!['unconscious', 'prone'].includes(item.slug)) {
        return
    }
    await rotateActor(item.actor)
});

function isGM() {
    return game.user.isGM && game.user === game.users.activeGM;
}

async function rotateActor(actor) {
    if (game.settings.get(moduleName, "rotateState") === 'no') {
        return
    }
    let tokens = actor.getActiveTokens(true, false)

    if (game.settings.get(moduleName, "rotateState") === 'unconscious') {
        if (hasCondition(actor, "unconscious")) {
            for (const t of tokens) {
                await t.rotate(-90)
            }
        } else {
            for (const t of tokens) {
                await t.rotate(0)
            }
        }
    } else if (game.settings.get(moduleName, "rotateState") === 'unconsciousProne') {
        if (hasCondition(actor, "unconscious")) {
            for (const t of tokens) {
                await t.rotate(-90)
            }
        } else if (hasCondition(actor, "prone")) {
            for (const t of tokens) {
                await t.rotate(-90)
            }
        } else {
            for (const t of tokens) {
                await t.rotate(0)
            }
        }
    }
}

Hooks.on('updateItem', async (item) => {
    if (!game.settings.get(moduleName, "deactivateRegeneration")) {
        return
    }

    if (!isGM() || !item.actor || item.slug !== "dying") {
        return
    }
    if (item.system.value.value !== item.actor.system.attributes.dying.max) {
        return
    }

    let action = item.actor.itemTypes.action.find(a => a.rules.find(r => r.key === 'FastHealing' && !r.ignored && r.type === 'regeneration'))
    if (!action) {
        return
    }
    let allRules = foundry.utils.deepClone(action._source.system.rules);
    let rule = allRules.find(r => r.key === 'FastHealing' && !r.ignored && r.type === 'regeneration')
    if (!rule) {
        return
    }

    rule.ignored = true;
    await action.update({'system.rules': allRules});
});
