

export const en = {
    discussion: {
        loadingTitle: 'Opening this conversation…',
        offlineTitle: 'This conversation isn’t available offline',
        offlineReason: 'Reconnect and it opens where you left off.',
        errorTitle: 'Couldn’t open this conversation',
        lockedTitle: 'Can’t open this conversation on this device yet',
        lockedReason: 'It’s end-to-end encrypted, and this device’s encryption setup doesn’t match this session’s.',
        revokedTitle: 'You no longer have access to this conversation',
        revokedReason: 'This session isn’t shared with you anymore. Messages you wrote stay with the session.',
        unavailableTitle: 'Conversations aren’t available here',
        closeTab: 'Close tab',
    },
    draft: {
        leadTitle: 'Ask an agent about this',
        leadBody: 'It runs as its own conversation beside the session, with these messages as context. Nothing starts until you send.',
    },
    context: {
        fromConversation: ({ title, count }: { title: string; count: number }) =>
            `From ${title} · ${count === 1 ? '1 message' : `${count} messages`}`,
        fromUntitled: ({ count }: { count: number }) =>
            `From a conversation · ${count === 1 ? '1 message' : `${count} messages`}`,
    },
    origin: {
        fromConversation: ({ title }: { title: string }) => `from ${title}`,
        fromUntitled: 'from a conversation',
    },
    run: {
        details: 'Run details',
        loadingTitle: 'Opening this agent conversation…',
        errorTitle: 'Couldn’t open this agent conversation',
    },
};


export const sessionConversationSurfaceTranslationsEnglish = { en };