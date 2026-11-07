

export type WidgetDefinitionTranslation = Readonly<{
    yourWidgets: string;
    yourWidgetsHint: string;
    yourWidget: string;
    moreInSource: string;
    notCurrent: string;
    aboutMenu: string;
    aboutTitle: string;
    aboutUnavailable: string;
    aboutData: string;
    aboutReads: string;
    aboutInputs: string;
    aboutRefresh: string;
    aboutUsedIn: string;
    savedFromSession: (params: Readonly<{ session: string }>) => string;
    aSession: string;
    madeInYourAccount: string;
    edited: (params: Readonly<{ time: string }>) => string;
    readsOnly: string;
    runsOn: (params: Readonly<{ machine: string }>) => string;
    withYourConnection: string;
    readsResource: (params: Readonly<{ read: string; plugin: string }>) => string;
    cannotRunAnythingElse: string;
    inputsThisCopy: string;
    refreshWhenOpen: string;
    refreshNow: string;
    refreshing: string;
    refreshed: string;
    refreshFailed: string;
    placedOnHome: string;
    placedOnABoard: string;
    placedInASession: string;
    placedInAProject: string;
    placedOnAPluginPage: string;
    placedOnACorePage: string;
    notPlacedYet: string;
    otherPlacesNotListed: string;
    editsChangeAll: (params: Readonly<{ count: number }>) => string;
    editsChangeEverywhere: string;
    changeWithAgent: string;
    changeDraft: (params: Readonly<{ widget: string }>) => string;
    duplicate: string;
    duplicated: (params: Readonly<{ name: string }>) => string;
    duplicateFailed: string;
    saveMenu: string;
    visualSaveTitle: string;
    visualSaveHint: string;
    visualShareTitle: string;
    visualSaveMenu: string;
    visualShareMenu: string;
    visualCopyToSessionMenu: string;
    visualCopyToSessionTitle: string;
    visualCopiedToSession: (params: Readonly<{ session: string }>) => string;
    visualCopySourceChanged: string;
    visualCopyFailed: string;
    visualSavedCopy: string;
    visualSaveFailed: string;
    saveMenuSubtitle: string;
    saveTitle: string;
    saveHint: string;
    saveNote: string;
    saveWidget: string;
    saveFailed: string;
    savedButNotPlaced: string;
    savedAsYours: (params: Readonly<{ name: string }>) => string;
    name: string;
    nameNeeded: string;
    becomesViewerInput: string;
    becomesContextInput: string;
    alsoAddTo: string;
    anotherPlace: string;
    snapshotMenu: string;
    snapshotMenuSubtitle: string;
    snapshotTitle: string;
    snapshotHint: (params: Readonly<{ widget: string; time: string }>) => string;
    postSnapshot: string;
    snapshotNotCurrent: string;
    snapshotFailed: string;
    snapshotAwaitingApproval: string;
    snapshotPosted: string;
    snapshotNote: string;
    asOf: (params: Readonly<{ time: string }>) => string;
}>;


export const widgetDefinitionTranslationsEnglish = { en: {
        yourWidgets: "Your widgets",
        yourWidgetsHint: "made by you or your agents",
        yourWidget: "Your widget",
        moreInSource: "There is more in the source than this shows.",
        notCurrent: "Not current",
        aboutMenu: "About this widget",
        aboutTitle: "About this widget",
        aboutUnavailable: "This widget can’t be opened right now.",
        aboutData: "Data",
        aboutReads: "Reads",
        aboutInputs: "Inputs",
        aboutRefresh: "Refresh",
        aboutUsedIn: "Used in",
        savedFromSession: ({ session }) => `Saved from ${session}`,
        aSession: "a session",
        madeInYourAccount: "Made in your account",
        edited: ({ time }) => `edited ${time}`,
        readsOnly: "Reads only",
        runsOn: ({ machine }) => `runs on ${machine}`,
        withYourConnection: "with your own connection",
        readsResource: ({ read, plugin }) => `${read} from ${plugin}`,
        cannotRunAnythingElse: "The widget can’t run anything else.",
        inputsThisCopy: "For this copy only",
        refreshWhenOpen: "When you open it",
        refreshNow: "Refresh now",
        refreshing: "Refreshing…",
        refreshed: "Refreshed",
        refreshFailed: "Couldn’t refresh it. The last numbers stay.",
        placedOnHome: "Home",
        placedOnABoard: "A board",
        placedInASession: "A session",
        placedInAProject: "A project",
        placedOnAPluginPage: "A plugin page",
        placedOnACorePage: "An app page",
        notPlacedYet: "Not placed anywhere yet",
        otherPlacesNotListed: "Places on other devices or shared surfaces aren’t listed here.",
        editsChangeAll: ({ count }) => `Edits to the widget change all ${count}`,
        editsChangeEverywhere: "Edits to the widget change it everywhere it’s used",
        changeWithAgent: "Change with the agent",
        changeDraft: ({ widget }) => `Change the “${widget}” widget so that `,
        duplicate: "Duplicate",
        duplicated: ({ name }) => `Saved a copy, “${name}”, to Your widgets`,
        duplicateFailed: "Couldn’t make a copy. Try again.",
        saveMenu: "Save as your widget…",
        visualSaveTitle: "Save as Artifact",
        visualSaveHint: "Save a copy before sharing. This session keeps its own visual.",
        visualShareTitle: "Share",
        visualSaveMenu: "Save as Artifact…",
        visualShareMenu: "Share link…",
        visualCopyToSessionMenu: "Copy to another session…",
        visualCopyToSessionTitle: "Copy to a session",
        visualCopiedToSession: ({ session }: Readonly<{ session: string }>) => `Copied to ${session}. It’s an independent copy on that session’s board.`,
        visualCopySourceChanged: "This visual changed while you chose. Copy it again to take the current version.",
        visualCopyFailed: "The copy could not be made. This visual is unchanged.",
        visualSavedCopy: "Saved to your account as an independent copy. Creating a public link is a separate choice.",
        visualSaveFailed: "The copy could not be saved. Your session visual is still here.",
        saveMenuSubtitle: "A copy for Home and your boards",
        saveTitle: "Save as your widget",
        saveHint: "A copy you can put on Home, your boards and projects. This session keeps its own.",
        saveNote: "Saved to your account · only you",
        saveWidget: "Save widget",
        saveFailed: "Couldn’t save the widget. Try again.",
        savedButNotPlaced: "Saved to Your widgets, but it couldn’t be added everywhere you chose.",
        savedAsYours: ({ name }) => `Saved “${name}” to Your widgets`,
        name: "Name",
        nameNeeded: "Give it a name",
        becomesViewerInput: "Becomes an input: each place uses your connection",
        becomesContextInput: "Becomes an input: each place chooses its own",
        alsoAddTo: "Also add to",
        anotherPlace: "Another place…",
        snapshotMenu: "Post a snapshot to this board…",
        snapshotMenuSubtitle: "Everyone here sees your numbers as of now",
        snapshotTitle: "Post a snapshot for everyone here?",
        snapshotHint: ({ widget, time }) => `Anyone who can open this session will see ${widget} as of ${time}. It won’t update, and your connection stays yours.`,
        postSnapshot: "Post snapshot",
        snapshotNotCurrent: "The widget is still getting current numbers. Try again when it has them.",
        snapshotFailed: "Couldn’t post the snapshot. Nothing was shared.",
        snapshotAwaitingApproval: "Waiting for approval in your Inbox. Nothing is shared until it’s approved.",
        snapshotPosted: "Snapshot posted",
        snapshotNote: "A copy of these numbers. It doesn’t update.",
        asOf: ({ time }) => `as of ${time}`,
    } } satisfies Pick<Readonly<Record<string, WidgetDefinitionTranslation>>, "en">;
