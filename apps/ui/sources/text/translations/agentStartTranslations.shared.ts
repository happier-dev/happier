

export const en = {
    titles: {
        conversation: 'A side conversation',
    },
    descriptions: {
        conversation: ({ machine }: { machine: string }) => `Ask anything without interrupting this session. It runs on ${machine} beside it; nothing goes back unless you send it.`,
    },
    chips: {
        engineTitle: 'Who answers',
        addReviewer: 'Add reviewer',
        removeReviewer: ({ name }: { name: string }) => `Remove ${name}`,
        scope: 'What to review',
        advanced: 'Advanced',
    },
    reportToSession: 'Report to this session',
    startsWhenYouSend: ({ count }: { count: number }) => count > 1 ? `${count} reviews start when you send` : 'Starts when you send',
    offline: ({ machine }: { machine: string }) => `${machine} is offline. The agent starts there; your draft stays here until it’s back.`,
    menu: {
        askSection: 'Ask an agent to',
        secondOpinionTitle: 'Second opinion',
        secondOpinionSubtitle: 'An independent check before done',
        keepGoingTitle: 'Keep going until done…',
        keepGoingSubtitle: 'Set a goal in the Goal control',
        runWorkflowTitle: 'Run a workflow',
        runWorkflowSubtitle: 'From your library or a built-in',
        searchWorkflows: 'Search workflows…',
        yourLibrary: 'Your library',
        noWorkflows: 'No saved workflows yet',
        addTriggerTitle: 'Add a trigger…',
        addTriggerSubtitle: 'Runs here each time something happens',
        advancedTitle: 'Advanced…',
        advancedSubtitle: 'Several agents, permissions, profile',
        builtIn: 'Built-in',
        allWorkflows: 'All workflows…',
    },
    role: {
        replaces: ({ agent }: { agent: string }) => `Replaces ${agent}`,
    },
    startRow: {
        subtitle: 'Draft · starts when you send',
        conversation: 'New conversation',
        review: 'New review',
        plan: 'New plan',
        delegate: 'New task',
    },
    pane: {
        cancelRun: 'Cancel run',
        whenItFinishes: 'When it finishes',
        sendToSession: ({ session }: { session: string }) => `Send to ${session}`,
        replyTo: ({ agent }: { agent: string }) => `Reply to ${agent}…`,
        repliesGoTo: ({ session }: { session: string }) => `Replies go to this agent, not to ${session}`,
    },
};


export const agentStartTranslationsEnglish = { en };