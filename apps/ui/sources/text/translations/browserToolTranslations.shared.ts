

export type TargetParams = Readonly<{ target: string }>;



/** What the agent did, said once in the past (the outcome) and once in the present (the ask, while it waits). */
export type BrowserToolPhrases = Readonly<{
    opened: (params: Readonly<{ page: string }>) => string;
    openedPage: string;
    reloaded: string;
    wentBack: string;
    wentForward: string;
    clicked: (params: TargetParams) => string;
    clickedPage: string;
    typedInto: (params: TargetParams) => string;
    typed: string;
    filledIn: (params: TargetParams) => string;
    filled: string;
    pressed: (params: Readonly<{ key: string }>) => string;
    pressedKey: string;
    scrolled: string;
    pointedAt: (params: TargetParams) => string;
    pointed: string;
    choseIn: (params: TargetParams) => string;
    chose: string;
    uploadedTo: (params: TargetParams) => string;
    uploaded: string;
    dragged: (params: TargetParams) => string;
    draggedPage: string;
    looked: string;
    screenshot: string;
    recordingStarted: string;
    recordingStopped: string;
    other: string;
}>;

export type BrowserToolTranslations = BrowserToolPhrases & Readonly<{
    present: BrowserToolPhrases;
    watch: string;
    watchA11y: string;
}>;


export const browserToolTranslationsEnglish = { en: {
        opened: ({ page }) => `Opened ${page}`,
        openedPage: 'Opened a page',
        reloaded: 'Reloaded the page',
        wentBack: 'Went back',
        wentForward: 'Went forward',
        clicked: ({ target }) => `Clicked ${target}`,
        clickedPage: 'Clicked on the page',
        typedInto: ({ target }) => `Typed into ${target}`,
        typed: 'Typed on the page',
        filledIn: ({ target }) => `Filled in ${target}`,
        filled: 'Filled in a field',
        pressed: ({ key }) => `Pressed ${key}`,
        pressedKey: 'Pressed a key',
        scrolled: 'Scrolled the page',
        pointedAt: ({ target }) => `Pointed at ${target}`,
        pointed: 'Pointed at the page',
        choseIn: ({ target }) => `Chose an option in ${target}`,
        chose: 'Chose an option',
        uploadedTo: ({ target }) => `Uploaded a file to ${target}`,
        uploaded: 'Uploaded a file',
        dragged: ({ target }) => `Dragged ${target}`,
        draggedPage: 'Dragged on the page',
        looked: 'Looked at the page',
        screenshot: 'Took a screenshot',
        recordingStarted: 'Started recording the page',
        recordingStopped: 'Stopped recording',
        other: 'Used the browser',
        present: {
            opened: ({ page }) => `Open ${page}`,
            openedPage: 'Open a page',
            reloaded: 'Reload the page',
            wentBack: 'Go back',
            wentForward: 'Go forward',
            clicked: ({ target }) => `Click ${target}`,
            clickedPage: 'Click on the page',
            typedInto: ({ target }) => `Type into ${target}`,
            typed: 'Type on the page',
            filledIn: ({ target }) => `Fill in ${target}`,
            filled: 'Fill in a field',
            pressed: ({ key }) => `Press ${key}`,
            pressedKey: 'Press a key',
            scrolled: 'Scroll the page',
            pointedAt: ({ target }) => `Point at ${target}`,
            pointed: 'Point at the page',
            choseIn: ({ target }) => `Choose an option in ${target}`,
            chose: 'Choose an option',
            uploadedTo: ({ target }) => `Upload a file to ${target}`,
            uploaded: 'Upload a file',
            dragged: ({ target }) => `Drag ${target}`,
            draggedPage: 'Drag on the page',
            looked: 'Look at the page',
            screenshot: 'Take a screenshot',
            recordingStarted: 'Start recording the page',
            recordingStopped: 'Stop recording',
            other: 'Use the browser',
        },
        watch: 'Watch',
        watchA11y: 'Open this page in the browser',
    } } satisfies Pick<Record<string, BrowserToolTranslations>, "en">;