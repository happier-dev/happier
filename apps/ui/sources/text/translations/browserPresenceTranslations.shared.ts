

export type AgentParams = Readonly<{ agent: string }>;



export type BrowserPresenceTranslations = Readonly<{
    /** Names the agent when the session's agent is unknown to the catalog. */
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
        stalled: string;
        endedTitle: (params: AgentParams) => string;
        endedBody: string;
        unavailableTitle: (params: AgentParams) => string;
        unavailableBody: (params: AgentParams) => string;
        tryAgain: string;
        inputA11y: string;
    }>;
    recording: Readonly<{
        elapsedA11y: (params: Readonly<{ elapsed: string }>) => string;
        discard: string;
    }>;
    openInYourBrowser: string;
    slowPage: string;
}>;


export const browserPresenceTranslationsEnglish = { en: {
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
            stalled: 'Showing the last frame · reconnecting',
            endedTitle: ({ agent }) => `${agent} closed this browser`,
            endedBody: 'The page is no longer being shown here.',
            unavailableTitle: ({ agent }) => `Can’t show ${agent}’s browser here`,
            unavailableBody: ({ agent }) => `${agent} keeps browsing; its actions still appear in the chat.`,
            tryAgain: 'Try again',
            inputA11y: 'The page. Tap, scroll or type to take control.',
        },
        recording: {
            elapsedA11y: ({ elapsed }) => `Recording, ${elapsed}`,
            discard: 'Discard recording',
        },
        openInYourBrowser: 'Open in your browser',
        slowPage: 'This page is taking a while',
    } } satisfies Pick<Record<string, BrowserPresenceTranslations>, "en">;