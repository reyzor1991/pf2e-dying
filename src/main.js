const moduleName = "pf2e-dying";

function hasCondition(actor, con) {
    return actor?.itemTypes?.condition?.find((c => c.type === "condition" && con === c.slug))
}

function isDamageRoll(message) {
    return message?.flags?.pf2e?.context?.type === "damage-roll";
}

function isDamageNonLethal() {
     const lDam = game.messages.contents.slice(-5).findLast(m=>isDamageRoll(m));
     if (lDam) {
        return (Number(lDam.content) > 0) && lDam?.item?.traits?.has('nonlethal')
     }
     return false;
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
    }
});

Hooks.on('updateActor', async (actor, data, diff, id) => {
    if (!game.settings.get(moduleName, "addDeathCondition")) {return;}
    if (data?.system?.attributes?.hp?.value === 0 && ["character", "familiar"].includes(actor?.type) && !hasCondition(actor, "dying")) {
        if (game.settings.get(moduleName, "checkNonLethal") && isDamageNonLethal()) {
            if (!hasCondition(actor, "unconscious")) {
                await actor.increaseCondition('unconscious');
            }
            return;
        }
        await actor.increaseCondition('dying',{'value': (actor.getCondition("wounded")?.value ?? 0) + 1})
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