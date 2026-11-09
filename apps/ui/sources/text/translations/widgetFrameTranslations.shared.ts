

export type WidgetFrameTranslation = Readonly<{
    styleCard: string;
    stylePlain: string;
    surfaceHome: string;
    surfaceBoard: string;
    surfaceCompanion: string;
    /** ⋯ menu: give this one widget a card. */
    showFrame: string;
    /** ⋯ menu: draw this one widget plain. */
    hideFrame: string;
    thisWidgetOnly: string;
    /** "Board uses Card": what the surface does for every other widget. */
    surfaceUses: (params: Readonly<{ surface: string; style: string }>) => string;
    useSurfaceDefault: (params: Readonly<{ surface: string }>) => string;
    likeTheOthers: (params: Readonly<{ style: string }>) => string;
    appearanceTitle: string;
    appearanceDescription: string;
    /** A preview tile's caption: "Board · Card". */
    previewLabel: (params: Readonly<{ surface: string; style: string }>) => string;
    /** A one-shot chip on a widget that just arrived. */
    newChip: string;
    /** The undoable notice after a widget's frame changed. */
    noticeChanged: string;
    /** Widget groups (A6/A7, lab widget-groups). */
    groupAddTo: string;
    groupAddToSubtitle: string;
    groupCopied: (params: Readonly<{ name: string; place: string }>) => string;
    groupCopyFailed: string;
    groupSaveTitle: string;
    groupSaveHint: (params: Readonly<{ count: number }>) => string;
    groupSaveNote: string;
    groupInputs: string;
    groupInputsValue: (params: Readonly<{ field: string; value: string }>) => string;
    groupWidth: string;
    widthHalf: string;
    widthFull: string;
    groupFrame: string;
    groupDividers: string;
    dividersLines: string;
    dividersNone: string;
    groupSave: string;
    groupSaveSubtitle: string;
    ungroup: string;
    ungroupSubtitle: (params: Readonly<{ count: number }>) => string;
    groupRemove: string;
    moveToGroup: string;
    removeFromGroup: string;
    removeFromGroupSubtitle: string;
    groupWith: string;
    groupWithNew: string;
    groupSlot: string;
    groupSlotAdd: string;
    groupUntitled: string;
    /** The accessible name of a group's name field on its Customize bar. */
    groupName: string;
    groupMenu: string;
    followingGroup: string;
    followingGroupValue: (params: Readonly<{ value: string }>) => string;
    groupInputsTitle: (params: Readonly<{ group: string }>) => string;
    groupInputsHint: string;
    groupFollowCount: (params: Readonly<{ following: number; count: number }>) => string;
    groupFollows: string;
    groupOwnValue: string;
    groupGrantsNothing: string;
    groupSaved: (params: Readonly<{ name: string }>) => string;
    groupSaveFailed: string;
    moveIntoGroupNamed: (params: Readonly<{ group: string }>) => string;
    intoGroupAbove: (params: Readonly<{ target: string }>) => string;
    intoGroupBelow: (params: Readonly<{ target: string }>) => string;
    intoGroupEnd: string;
    intoGroupKeepsSize: (params: Readonly<{ size: string }>) => string;
    reorderInGroupDetail: string;
    outOfGroupDetail: (params: Readonly<{ group: string }>) => string;
    wholeGroupDetail: (params: Readonly<{ count: number }>) => string;
    cantPutInGroup: (params: Readonly<{ group: string }>) => string;
    groupRefusedWidth: string;
    groupRefusedNesting: string;
    groupRefusedNestingNamed: (params: Readonly<{ group: string; target: string }>) => string;
    groupNeedsFullWidth: (params: Readonly<{ widget: string }>) => string;
    groupFacts: (params: Readonly<{ width: string; count: number }>) => string;
    groupCannotTake: (params: Readonly<{ group: string }>) => string;
    groupA11y: (params: Readonly<{ name: string }>) => string;
    groupCount: (params: Readonly<{ count: number }>) => string;
    /** A saved group added more than once: which copy this row is, so identical rows tell apart. */
    groupCopyOf: (params: Readonly<{ count: number; index: number; total: number }>) => string;
    /** A group's name in a chooser heading or preview when other groups share it: which copy it is. */
    groupNameCopyOf: (params: Readonly<{ name: string; index: number; total: number }>) => string;
    /** A group's sheet header, beside its name: "Group · 4 widgets". */
    groupWidgetCount: (params: Readonly<{ count: number }>) => string;
    addsAtWidth: (params: Readonly<{ width: string }>) => string;
    /** Presets (A7): an edited preset's tab marker, its one line, Reset and Undo. */
    presetEdited: string;
    /** An edited preset's line: the view no longer matches its preset (Reset follows it). */
    presetChangedView: string;
    /** A saved group's provenance in Add: "Your group · saved from Home on Oct 8 · 3 widgets". */
    groupProvenance: (params: Readonly<{ origin: string | null; date: string | null; count: number }>) => string;
    /** What adding a saved group does: "Adds Release check with its 3 widgets, following happier". */
    groupAddsFollowing: (params: Readonly<{ name: string; count: number; value: string | null }>) => string;
    /** Under a saved group's input while it is still needed. */
    groupInputAskedOnce: (params: Readonly<{ count: number }>) => string;
    presetReset: string;
    presetResetDone: (params: Readonly<{ name: string }>) => string;
    presetResetFailed: string;
    undo: string;
    /** Appearance → Widgets: how the Add popover opens (Gallery | List), also switched in the popover. */
}>;


export const widgetFrameTranslationsEnglish = { en: {
        styleCard: 'Card',
        stylePlain: 'Plain',
        surfaceHome: 'Home',
        surfaceBoard: 'Board',
        surfaceCompanion: 'Companion',
        showFrame: 'Show frame',
        hideFrame: 'Hide frame',
        thisWidgetOnly: 'This widget only',
        surfaceUses: ({ surface, style }) => `${surface} uses ${style}`,
        useSurfaceDefault: ({ surface }) => `Use the ${surface} default`,
        likeTheOthers: ({ style }) => `${style}, like the others`,
        appearanceTitle: 'Widgets',
        appearanceDescription: 'How widgets are framed on this device. To change one widget, use its ⋯ menu.',
        previewLabel: ({ surface, style }) => `${surface} · ${style}`,
        noticeChanged: 'Frame changed',
        newChip: 'New',
        groupInputs: "Inputs…",
        groupInputsValue: ({ field, value }) => `${field}: ${value}`,
        groupWidth: "Width",
        widthHalf: "Half",
        widthFull: "Full",
        groupFrame: "Frame",
        groupDividers: "Dividers",
        dividersLines: "Lines",
        dividersNone: "None",
        groupSave: "Save group…",
        groupSaveSubtitle: "Keep it in Your widgets, to add anywhere",
        ungroup: "Ungroup",
        ungroupSubtitle: ({ count }) => count === 1 ? 'Its widget stays here, on its own card' : `Its ${count} widgets stay here, each on its own card`,
        groupRemove: "Remove group and its widgets",
        moveToGroup: "Move to group",
        removeFromGroup: "Remove from group",
        removeFromGroupSubtitle: "Back on its own card, beside the group",
        groupWith: "Group with…",
        groupWithNew: "A new group of the two",
        groupSlot: "Drop a widget here or",
        groupSlotAdd: "add one",
        groupUntitled: "Untitled group",
        groupName: "Group name",
        groupMenu: "Group options",
        followingGroup: "Following group",
        followingGroupValue: ({ value }) => `Following group · ${value}`,
        groupInputsTitle: ({ group }) => `${group} · inputs`,
        groupInputsHint: "Set once. Widgets that follow the group use it.",
        groupFollowCount: ({ following, count }) => `${following} of ${count} widgets follow the group`,
        groupFollows: "Follows",
        groupOwnValue: "Its own value",
        groupGrantsNothing: "The group grants nothing: each widget still checks its own access.",
        groupSaved: ({ name }) => `${name} is in Your widgets`,
        groupSaveFailed: "Couldn't save the group. Try again.",
        moveIntoGroupNamed: ({ group }) => `Move into ${group}`,
        intoGroupAbove: ({ target }) => `Above ${target} · shows plain inside the group`,
        intoGroupBelow: ({ target }) => `Below ${target} · shows plain inside the group`,
        intoGroupEnd: "Shows plain inside the group",
        intoGroupKeepsSize: ({ size }) => `stays ${size}`,
        reorderInGroupDetail: "Order only",
        outOfGroupDetail: ({ group }) => `Out of ${group} · gets its own card again`,
        wholeGroupDetail: ({ count }) => count === 1 ? `Its widget moves with it` : `Its ${count} widgets move with it`,
        cantPutInGroup: ({ group }) => `Can’t put it in ${group}`,
        groupRefusedWidth: "It needs the full width and this group is half. Drop it beside, or make the group full width.",
        groupRefusedNesting: "Groups can’t go inside groups. Drop it above or below, or ungroup it first.",
        groupRefusedNestingNamed: ({ group, target }) => `Groups can’t go inside groups. Drop ${group} above or below ${target}, or ungroup it first.`,
        groupNeedsFullWidth: ({ widget }) => `${widget} needs the full width`,
        groupFacts: ({ width, count }) => `${width} · ${count === 1 ? '1 widget' : `${count} widgets`}`,
        groupCannotTake: ({ group }) => `Needs the full width; ${group} is half`,
        groupA11y: ({ name }) => `Group: ${name}`,
        groupCount: ({ count }) => `Group · ${count}`,
        groupCopyOf: ({ count, index, total }) => `Group · ${count} · Copy ${index} of ${total}`,
        groupNameCopyOf: ({ name, index, total }) => `${name} · Copy ${index} of ${total}`,
        groupWidgetCount: ({ count }) => count === 1 ? 'Group · 1 widget' : `Group · ${count} widgets`,
        addsAtWidth: ({ width }) => `Adds it at ${width} width.`,
        presetEdited: "Edited",
        presetChangedView: "You changed this view.",
        groupProvenance: ({ origin, date, count }) => ['Your group', origin && date ? `saved from ${origin} on ${date}` : date ? `saved on ${date}` : origin ? `saved from ${origin}` : null, count === 1 ? '1 widget' : `${count} widgets`].filter(Boolean).join(' · '),
        groupAddsFollowing: ({ name, count, value }) => `Adds ${name} with its ${count === 1 ? 'widget' : `${count} widgets`}${value ? `, following ${value}` : ''}`,
        groupInputAskedOnce: ({ count }) => count === 1 ? 'Asked once. Its widget follows it.' : `Asked once. The ${count} widgets follow it.`,
        presetReset: "Reset to preset",
        presetResetDone: ({ name }) => `${name} is back to its preset`,
        presetResetFailed: "Couldn't reset to the preset.",
        undo: "Undo",
        groupAddTo: "Add to…",
        groupAddToSubtitle: "A copy on another Home or project",
        groupCopied: ({ name, place }) => `${name} copied to ${place}`,
        groupCopyFailed: "Couldn't copy the group. Try again.",
        groupSaveTitle: "Save group",
        groupSaveHint: ({ count }) => count === 1 ? 'Keep it in Your widgets, with its widget, to add anywhere.' : `Keep it in Your widgets, with its ${count} widgets, to add anywhere.`,
        groupSaveNote: "A copy: this group stays as it is.",
    } } satisfies Pick<Readonly<Record<string, WidgetFrameTranslation>>, "en">;