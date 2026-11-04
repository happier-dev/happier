

export type AgentParams = Readonly<{ agent: string }>;



export type BrowserPresenceTranslations = Readonly<{
    /** Names the agent when the session's agent is unknown to the catalog. */
    remoteControls: Readonly<{
        touch: string;
        modifiers: string;
        arrows: string;
        clipboard: string;
        sendClipboard: string;
        receiveClipboard: string;
        hideKeyboard: string;
    }>;
    agentFallbackName: string;
    agentBrowsing: (params: AgentParams) => string;
    clickTarget: (params: Readonly<{ target: string }>) => string;
    doing: Readonly<{
        click: string;
        type: string;
        fill: string;
        scroll: string;
        navigate: string;
        history: string;
        reload: string;
        press: string;
        select: string;
        drag: string;
        upload: string;
        look: string;
        other: string;
    }>;
    takeControl: string;
    stopping: (params: AgentParams) => string;
    stoppingDetail: string;
    youHaveControl: string;
    /** The person stopped the agent but the release of its input is not confirmed (never “You have control”). */
    stopUnconfirmed: string;
    checkAgain: string;
    pausedUntilHandBack: (params: AgentParams) => string;
    /** A takeover interrupted an agent action whose effect could not be confirmed. */
    lastActionMayHaveLanded: (params: AgentParams) => string;
    handBack: string;
    stream: Readonly<{
        connectingTitle: (params: AgentParams) => string;
        connectingBody: (params: Readonly<{ machine: string }>) => string;
        preparingTitle: string;
        preparingBody: string;
        openingPage: string;
        pageOpened: string;
        installFailedTitle: string;
        sandboxAllow: string;
        sandboxAllowedTitle: string;
        sandboxAllowedBody: (params: AgentParams) => string;
        sandboxPermissionTitle: string;
        sandboxPermissionBody: string;
        sandboxFailedBody: string;
        stalled: string;
        endedTitle: (params: AgentParams) => string;
        endedBody: string;
        openPageHere: string;
        setupTitle: (params: AgentParams) => string;
        unavailableTitle: (params: AgentParams) => string;
        unavailableBody: (params: AgentParams) => string;
        tryAgain: string;
        inputA11y: string;
        directMode: string;
        trackpadMode: string;
        resetZoom: string;
    }>;
    recording: Readonly<{
        elapsedA11y: (params: Readonly<{ elapsed: string }>) => string;
        discard: string;
    }>;
    openInYourBrowser: string;
    slowPage: string;
    /** A confidential entry holds Agent reading and recording until the page itself closes. */
    confidentialHeld: (params: AgentParams) => string;
    closePage: string;
    interaction: Readonly<{
        thisPage: string;
        says: (params: Readonly<{ host: string }>) => string;
        leaveTitle: string;
        leaveBody: string;
        leave: string;
        stay: string;
        chooserTitle: (params: Readonly<{ host: string }>) => string;
        chooserTitleMultiple: (params: Readonly<{ host: string }>) => string;
        chooserBody: string;
        chooseFile: string;
        chooseFiles: string;
        otherViewer: string;
        chooserUnavailable: string;
        downloadUnavailable: string;
        downloadProgress: (params: Readonly<{ received: string; total: string }>) => string;
        downloadCanceled: string;
        save: string;
        dismissDownloads: string;
        downloadsA11y: string;
        showKeyboard: string;
    }>;
}>;


export const browserPresenceTranslationsEnglish = { en: {
        remoteControls: {
            touch: "Touch",
            modifiers: "Modifiers",
            arrows: "Arrows",
            clipboard: "Clipboard",
            sendClipboard: "Send clipboard",
            receiveClipboard: "Receive clipboard",
            hideKeyboard: "Hide keyboard",
        },
        agentFallbackName: 'The agent',
        agentBrowsing: ({ agent }) => `${agent} is browsing`,
        clickTarget: ({ target }) => `Clicking “${target}”`,
        doing: {
            click: 'Clicking on the page',
            type: 'Typing',
            fill: 'Filling in a field',
            scroll: 'Scrolling',
            navigate: 'Opening a page',
            history: 'Moving through history',
            reload: 'Reloading the page',
            press: 'Pressing a key',
            select: 'Choosing an option',
            drag: 'Dragging',
            upload: 'Uploading a file',
            look: 'Looking at the page',
            other: 'Working in the page',
        },
        takeControl: 'Take control',
        stopping: ({ agent }) => `Stopping ${agent}…`,
        stoppingDetail: 'Finishing its last action',
        lastActionMayHaveLanded: ({ agent }) => `${agent}’s last action may have landed`,
        youHaveControl: 'You have control',
        stopUnconfirmed: 'Couldn’t confirm the stop',
        checkAgain: 'Check again',
        pausedUntilHandBack: ({ agent }) => `${agent} is paused until you hand back`,
        handBack: 'Hand back',
        stream: {
            connectingTitle: ({ agent }) => `Connecting to ${agent}’s browser`,
            connectingBody: ({ machine }) => `It runs on ${machine}. The page appears here as soon as the first frame arrives.`,
            preparingTitle: 'Preparing the browser…',
            preparingBody: 'Downloading Chromium on this machine. This only happens once. Your page will open when it’s ready.',
            openingPage: 'Opening the page…',
            pageOpened: 'The page opened.',
            installFailedTitle: 'Couldn’t prepare the browser',
            sandboxAllow: 'Allow the browser sandbox',
            sandboxAllowedTitle: 'The browser sandbox is allowed',
            sandboxAllowedBody: ({ agent }) => `${agent}’s browser can start now. Ask ${agent} to open the page again.`,
            sandboxPermissionTitle: 'Waiting for a system permission',
            sandboxPermissionBody: 'Someone needs to approve the system permission on that machine. Then allow the sandbox again.',
            sandboxFailedBody: 'The sandbox couldn’t be allowed on this machine. Try again in a moment.',
            stalled: 'Showing the last frame · reconnecting',
            endedTitle: ({ agent }) => `${agent} closed this browser`,
            endedBody: 'The page is no longer being shown here.',
            openPageHere: "Open page here",
            setupTitle: ({ agent }) => `${agent}’s browser isn’t set up yet`,
            unavailableTitle: ({ agent }) => `Can’t show ${agent}’s browser here`,
            unavailableBody: ({ agent }) => `${agent} keeps browsing; its actions still appear in the chat.`,
            tryAgain: 'Try again',
            directMode: 'Direct touch',
            trackpadMode: 'Trackpad',
            resetZoom: 'Fit picture',
            inputA11y: 'The page. Tap, scroll or type to take control.',
        },
        recording: {
            elapsedA11y: ({ elapsed }) => `Recording, ${elapsed}`,
            discard: 'Discard recording',
        },
        openInYourBrowser: 'Open in your browser',
        slowPage: 'This page is taking a while',
        confidentialHeld: ({ agent }) => `Private entry here · hidden from ${agent} until the page closes`,
        closePage: 'Close page',
        interaction: {
            thisPage: 'This page',
            says: ({ host }) => `${host} says`,
            leaveTitle: 'Leave this page?',
            leaveBody: 'Changes you made may not be saved.',
            leave: 'Leave',
            stay: 'Stay',
            chooserTitle: ({ host }) => `${host} asks for a file`,
            chooserTitleMultiple: ({ host }) => `${host} asks for files`,
            chooserBody: 'Choose from this device. Only what you pick is uploaded to the page.',
            chooseFile: 'Choose file',
            chooseFiles: 'Choose files',
            otherViewer: 'The person in control answers this.',
            chooserUnavailable: 'This page asked for a file, but uploads aren’t available here',
            downloadUnavailable: 'This page started a download, but downloads aren’t available here',
            downloadProgress: ({ received, total }) => `${received} of ${total}`,
            downloadCanceled: 'Canceled',
            save: 'Save',
            dismissDownloads: 'Hide downloads',
            downloadsA11y: 'Downloads',
            showKeyboard: 'Show keyboard',
        },
    } } satisfies Pick<Record<string, BrowserPresenceTranslations>, "en">;
