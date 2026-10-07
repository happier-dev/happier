

export type TargetParams = Readonly<{ target: string }>;



export type BrowserToolTranslations = Readonly<{
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
        watch: 'Watch',
        watchA11y: 'Open this page in the browser',
    } } satisfies Pick<Record<string, BrowserToolTranslations>, "en">;