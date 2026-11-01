

export type WidgetAddTranslation = Readonly<{
    added: string;
    boardTitle: string;
    boardHint: string;
    companionTitle: string;
    companionHint: string;
    searchWidgets: string;
    searchCompanion: string;
    makeOne: string;
    noteSubtitle: string;
    interactiveViewSubtitle: string;
    findMore: string;
    findMoreSubtitle: string;
    askTitle: string;
    askNote: string;
    glances: string;
    glancesHint: string;
    onBoard: string;
    onBoardHint: string;
    panes: string;
    panesHint: string;
    builtIn: string;
    sessionDetails: string;
    prompts: Readonly<{ project: string; projects: string; session: string; workspace: string; checkout: string; machine: string }>;
    inputLabels: Readonly<Record<'session' | 'metric' | 'breakdown' | 'groupBy' | 'apiEquivalent' | 'agent' | 'model' | 'project' | 'workspace' | 'backendMode' | 'source' | 'machine', string>>;
    nativeDescriptions: Readonly<{
        session_summary: string;
        agent_plan: string;
        changes: string;
        local_services: string;
    }>;
    noMatch: (params: Readonly<{ query: string }>) => string;
    pickTitle: string;
    pickHint: string;
    /** The nothing-selected pane's key legend: ↑↓, ↵ and esc. */
    keysBrowse: string;
    keysAdd: string;
    keysClose: string;
    pickNote: string;
    askAction: string;
    pluginTag: string;
    pluginProvenance: (params: Readonly<{ plugin: string }>) => string;
    readsChosenSession: string;
    readsFrom: (params: Readonly<{ source: string }>) => string;
    savedQueryOn: (params: Readonly<{ source: string }>) => string;
    madeByYou: (params: Readonly<{ date: string }>) => string;
    madeByAgent: (params: Readonly<{ date: string }>) => string;
    madeByPlugin: (params: Readonly<{ date: string }>) => string;
    previewLiveData: string;
    addsAtSize: (params: Readonly<{ size: string }>) => string;
    backToWidgets: string;
    editTitle: (params: Readonly<{ widget: string }>) => string;
    editHint: string;
    preview: string;
    previewLive: string;
    previewWaiting: (params: Readonly<{ field: string }>) => string;
    /** What to type in a list input that declares no placeholder of its own. */
    listOnePerLine: string;
    listCommaSeparated: string;
    previewAfterAdd: string;
    adding: string;
    savingInputs: string;
    needed: string;
    stillNeeded: (params: Readonly<{ field: string }>) => string;
    followGroup: string;
    pinGroup: string;
    another: string;
    anotherSubtitle: string;
    searchChoices: (params: Readonly<{ field: string }>) => string;
    noChoices: string;
    optionsLoading: string;
    optionsFailed: string;
    yoursFailed: string;
    invalidValue: string;
    invalidReason: string;
    inputsInvalid: string;
    inputsUnavailable: string;
    connectionNeeded: (params: Readonly<{ field: string }>) => string;
    sessionDenied: (params: Readonly<{ session: string }>) => string;
    sessionUnavailable: (params: Readonly<{ session: string }>) => string;
    typeUnavailable: (params: Readonly<{ field: string }>) => string;
    inputUnavailable: (params: Readonly<{ field: string }>) => string;
    selectedInputUnavailable: (params: Readonly<{ field: string; value: string }>) => string;
    viewerOnly: string;
    choicesCount: (params: Readonly<{ count: number }>) => string;
    countOnHome: (params: Readonly<{ count: number }>) => string;
    countOnBoard: (params: Readonly<{ count: number }>) => string;
    countInCompanion: (params: Readonly<{ count: number }>) => string;
    justAdded: (params: Readonly<{ widget: string }>) => string;
    /** The Add pane's button once it has added: the same Add again is another copy. */
    addAnother: string;
    saved: (params: Readonly<{ widget: string }>) => string;
    addFailed: string;
    saveFailed: string;
    homeTitle: string;
    homeHint: string;
    addWidgets: string;
    addToHome: string;
    addToBoard: string;
    addToCompanion: string;
    editInputs: string;
    width: string;
    size: string;
    sizes: Readonly<Record<'small' | 'medium' | 'wide' | 'full' | 'tall' | 'large', string>>;
    widthHalf: string;
    widthFull: string;
    thisSession: string;
    thisPage: string;
    ownValue: string;
    ownValueHint: string;
    thisProject: string;
    thisCheckout: string;
    areaPinned: string;
    areaPinnedMeta: string;
    areaProjectTitle: string;
    areaProjectMeta: string;
    areaAdd: (params: Readonly<{ surface: string }>) => string;
    areaAddTo: (params: Readonly<{ surface: string }>) => string;
    areaHint: string;
    countHere: (params: Readonly<{ count: number }>) => string;
    areaEmptyTitle: string;
    areaEmptyReason: string;
    areaEmptyAction: string;
    areaUnavailableTitle: string;
    areaScopeRecovery: string;
    projectSourceUnavailableTitle: string;
    areaWriteFailed: string;
    areaApprovalPending: string;
    /** Why an Add or save was refused, and the next step. */
    refusals: Readonly<Record<'areaUnavailable' | 'inputsInvalid' | 'typeUnavailable' | 'sizeUnsupported' | 'editDenied' | 'writeUnconfirmed' | 'inputsAccessDenied' | 'inputsChoiceGone' | 'inputsChoicesUnavailable', string>>;
    valueNotFound: (params: Readonly<{ value: string }>) => string;
    chooseAnother: (params: Readonly<{ field: string }>) => string;
    chooseField: (params: Readonly<{ field: string }>) => string;
    widgetOptions: string;
    moveTo: string;
}>;



export function inSentence(label: string): string {
    return /^[A-Z][a-z]/.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label;
}


export const widgetAddTranslationsEnglish = { en: {
        added: 'Added',
        boardTitle: 'Add to the board',
        boardHint: 'Everyone here sees what you add',
        companionTitle: 'Add to companion',
        companionHint: 'Only you see your Companion',
        searchWidgets: 'Search widgets',
        searchCompanion: 'Search glances and panes',
        makeOne: 'Make one',
        noteSubtitle: 'Markdown',
        interactiveViewSubtitle: 'HTML',
        findMore: 'Find more widgets',
        findMoreSubtitle: 'Plugins',
        askTitle: 'Ask the agent for a widget',
        askNote: 'Drafts it in the composer; nothing is sent until you do.',
        glances: 'Glances',
        glancesHint: 'live, built in or from plugins',
        onBoard: 'On this board',
        onBoardHint: 'shared with everyone here',
        panes: 'Panes',
        panesHint: 'added as a link that opens in Details',
        builtIn: 'Built in',
        sessionDetails: 'Session details',
        prompts: { project: 'Which project?', projects: 'Which projects?', session: 'Which session?', workspace: 'Which workspace?', checkout: 'Which checkout?', machine: 'Which machine?' },
        inputLabels: { session: 'Session', metric: 'Metric', breakdown: 'Breakdown', groupBy: 'Group by', apiEquivalent: 'API equivalent', agent: 'Agent', model: 'Model', project: 'Project', workspace: 'Workspace', backendMode: 'Backend mode', source: 'Source', machine: 'Machine' },
        nativeDescriptions: {
            session_summary: 'Activity and next steps for the session you choose.',
            agent_plan: 'Follow the agent’s plan for the session you choose.',
            changes: 'Review file changes in the session you choose.',
            local_services: 'Open local services running for the session you choose.',
        },
        noMatch: ({ query }) => `No widgets match “${query}”`,
        pickTitle: 'Pick a widget to see it here',
        pickHint: 'It shows your own data, at the size you choose, before anything is added.',
        keysBrowse: 'browse',
        keysAdd: 'add',
        keysClose: 'close',
        pickNote: 'Pick a widget to add it',
        askAction: 'Draft the request',
        pluginTag: 'plugin',
        pluginProvenance: ({ plugin }) => `${plugin} plugin`,
        readsChosenSession: 'reads the session you choose, where it runs',
        readsFrom: ({ source }) => `reads ${source}`,
        savedQueryOn: ({ source }) => `a saved query on ${source}`,
        madeByYou: ({ date }) => `made by you on ${date}`,
        madeByAgent: ({ date }) => `made by your agent on ${date}`,
        madeByPlugin: ({ date }) => `made by a plugin on ${date}`,
        previewLiveData: 'Live, with your data',
        addsAtSize: ({ size }) => `Adds it at ${size}. You can change its size later.`,
        backToWidgets: 'Widgets',
        editTitle: ({ widget }) => `${widget} · inputs`,
        editHint: 'Only this copy changes. Other copies keep their inputs.',
        preview: 'Preview',
        previewLive: 'Preview · live',
        previewWaiting: ({ field }) => `Choose the ${inSentence(field)} to see it here`,
        listOnePerLine: "One per line",
        listCommaSeparated: "Separated by commas",
        previewAfterAdd: 'It shows here once it’s added',
        adding: 'Adding…',
        savingInputs: 'Saving…',
        needed: 'Needed',
        stillNeeded: ({ field }) => `${field} is still needed`,
        followGroup: 'Follow',
        pinGroup: 'Or pin one',
        another: 'Another…',
        anotherSubtitle: 'Search everything you can reach',
        searchChoices: ({ field }) => `Search ${field}`,
        noChoices: 'Nothing to choose here yet',
        optionsLoading: 'Loading choices…',
        optionsFailed: 'Couldn’t load the choices',
        yoursFailed: 'Couldn’t load your widgets',
        invalidValue: 'not found',
        inputsInvalid: 'Review this widget’s inputs',
        inputsUnavailable: 'A selected input is unavailable',
        connectionNeeded: ({ field }) => `Connect your ${field}`,
        sessionDenied: ({ session }) => `You no longer have access to ${session}`,
        sessionUnavailable: ({ session }) => `${session} is unavailable or was deleted`,
        typeUnavailable: ({ field }) => `The type for ${field} is no longer available`,
        inputUnavailable: ({ field }) => `${field} is unavailable`,
        selectedInputUnavailable: ({ field, value }) => `${field}: ${value} is no longer available`,
        invalidReason: 'You no longer have access, or it was removed.',
        viewerOnly: 'Everyone here sees it with their own connection.',
        justAdded: ({ widget }) => `${widget} added`,
        addAnother: 'Add another',
        saved: ({ widget }) => `${widget} saved`,
        addFailed: 'Couldn’t add it. Try again.',
        saveFailed: 'Couldn’t save. Try again.',
        homeTitle: 'Add to Home',
        homeHint: 'Only you see your Home · on every device',
        addWidgets: 'Add widgets',
        addToHome: 'Add to Home',
        addToBoard: 'Add to the board',
        addToCompanion: 'Add to companion',
        editInputs: 'Edit inputs…',
        width: 'Width',
        size: 'Size',
        sizes: { small: 'Small', medium: 'Medium', wide: 'Wide', full: 'Full', tall: 'Tall', large: 'Large' },
        widthHalf: 'Half',
        widthFull: 'Full',
        thisSession: 'This session',
        choicesCount: ({ count }) => count === 1 ? '1 choice' : `${count} choices`,
        countOnHome: ({ count }) => `${count} on Home`,
        countOnBoard: ({ count }) => `${count} on the board`,
        countInCompanion: ({ count }) => `${count} in Companion`,
        thisPage: 'This page',
        ownValue: 'Own value',
        ownValueHint: 'Set it here; it stops following',
        thisProject: 'This project',
        thisCheckout: 'This checkout',
        areaPinned: 'Pinned',
        areaPinnedMeta: 'your widgets on this page',
        areaProjectTitle: 'Widgets',
        areaProjectMeta: 'yours',
        areaAdd: ({ surface }) => `Add a widget to ${surface}`,
        areaAddTo: ({ surface }) => `Add to ${surface}`,
        areaHint: 'Only you see these widgets',
        countHere: ({ count }) => count === 1 ? '1 here' : `${count} here`,
        areaEmptyTitle: 'Nothing pinned yet',
        areaEmptyReason: 'Pin a widget to keep it here, just for you.',
        areaEmptyAction: 'Add a widget',
        areaUnavailableTitle: 'Widgets can’t load here',
        areaScopeRecovery: 'Reopen this page to load widgets for the current Home and Account.',
        projectSourceUnavailableTitle: 'Widgets appear here once this project’s repository is known',
        areaWriteFailed: 'Couldn’t save this change',
        areaApprovalPending: 'Waiting for approval',
        refusals: {
            areaUnavailable: 'Widgets aren’t available here right now. Try again in a moment.',
            inputsInvalid: 'Some inputs aren’t valid. Review them and try again.',
            typeUnavailable: 'This widget isn’t available anymore. Choose another.',
            sizeUnsupported: 'That size isn’t available for this widget. Pick another size.',
            editDenied: 'You can’t change widgets here.',
            writeUnconfirmed: 'Your Home didn’t confirm it. Check the area, then try again.',
            inputsAccessDenied: 'That session isn’t readable by you, so the widget can’t show it.',
            inputsChoiceGone: 'That choice isn’t available anymore. Choose another.',
            inputsChoicesUnavailable: 'Couldn’t load the choices for this widget. Try again in a moment.',
        },
        valueNotFound: ({ value }) => `${value} can’t be found`,
        chooseAnother: ({ field }) => `Choose another ${inSentence(field)}`,
        chooseField: ({ field }) => `Choose the ${inSentence(field)}`,
        widgetOptions: 'Widget options',
        moveTo: 'Move…',
    } } satisfies Pick<Readonly<Record<string, WidgetAddTranslation>>, "en">;
