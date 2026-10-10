

export type SessionCompanionTranslations = Readonly<{
    recap: Readonly<{ title: string }>;
    status: Readonly<{
        waitingForYou: string;
        pausedBeforeStep: (params: Readonly<{ agent: string; step: number; total: number }>) => string;
        stepOfPlan: (params: Readonly<{ step: number; total: number }>) => string;
        agentFallback: string;
    }>;
    ask: Readonly<{
        question: (params: Readonly<{ summary: string }>) => string;
        allow: string;
        deny: string;
        showInChat: string;
        moreWaiting: (params: Readonly<{ count: number }>) => string;
        allowed: (params: Readonly<{ summary: string }>) => string;
        denied: (params: Readonly<{ summary: string }>) => string;
        justNow: string;
        failed: string;
        answerWhenBack: (params: Readonly<{ machine: string }>) => string;
        answerWhenSessionBack: string;
        notAllowed: string;
        groupA11y: string;
    }>;
    facts: Readonly<{
        subagents: string;
        changed: string;
        context: string;
        subagentsValue: (params: Readonly<{ live: number; total: number }>) => string;
        contextValue: (params: Readonly<{ percent: number }>) => string;
        opensAgents: string;
        opensGit: string;
        opensUsage: string;
    }>;
    plan: Readonly<{
        title: string;
        description: (params: Readonly<{ agent: string }>) => string;
        progress: (params: Readonly<{ done: number; total: number }>) => string;
        progressA11y: (params: Readonly<{ done: number; total: number }>) => string;
        emptyTitle: string;
        emptyReason: string;
        stepDone: string;
        stepCurrent: string;
    }>;
    picker: Readonly<{
        open: string;
        chooseWidget: string;
        onTheBoard: (params: Readonly<{ source: string }>) => string;
    }>;
    drop: Readonly<{ keepBesideChat: string }>;
    freshness: Readonly<{ machineOffline: (params: Readonly<{ machine: string }>) => string }>;
    needsYouA11y: (params: Readonly<{ count: number }>) => string;
}>;


export const sessionCompanionTranslationsEnglish = { en: {
        recap: { title: 'Recap' },
        status: {
            waitingForYou: 'Waiting for you',
            pausedBeforeStep: ({ agent, step, total }) => `${agent} paused before step ${step} of ${total}`,
            stepOfPlan: ({ step, total }) => `Step ${step} of ${total} in the plan`,
            agentFallback: 'The agent',
        },
        ask: {
            question: ({ summary }) => `${summary}?`,
            allow: 'Allow',
            deny: 'Deny',
            showInChat: 'Show in chat',
            moreWaiting: ({ count }) => `${count} more waiting`,
            allowed: ({ summary }) => `Allowed ${summary}`,
            denied: ({ summary }) => `Denied ${summary}`,
            justNow: 'just now',
            failed: 'Your answer didn’t reach the session. Try again.',
            answerWhenBack: ({ machine }) => `You can answer when ${machine} is back.`,
            answerWhenSessionBack: 'You can answer when the session is back.',
            notAllowed: 'Only people who can run this session can answer.',
            groupA11y: 'Waiting for you',
        },
        facts: {
            subagents: 'subagents',
            changed: 'changed',
            context: 'context',
            subagentsValue: ({ live, total }) => (live > 0 ? `${live} of ${total}` : `${total}`),
            contextValue: ({ percent }) => `${percent}%`,
            opensAgents: 'Opens Agents',
            opensGit: 'Opens Git',
            opensUsage: 'Opens usage',
        },
        plan: {
            title: 'Plan',
            description: ({ agent }) => `${agent}’s to-do list for this session`,
            progress: ({ done, total }) => `${done} of ${total}`,
            progressA11y: ({ done, total }) => `${done} of ${total} done`,
            emptyTitle: 'No plan yet',
            emptyReason: 'When the agent writes a to-do list, it shows up here, step by step.',
            stepDone: 'Done',
            stepCurrent: 'Current step',
        },
        picker: {
            open: 'Add to Companion',
            chooseWidget: 'Choose a widget…',
            onTheBoard: ({ source }) => `${source} · on the board`,
        },
        drop: { keepBesideChat: 'Keep beside your chat' },
        freshness: { machineOffline: ({ machine }) => `${machine} is offline` },
        needsYouA11y: ({ count }) => `Companion, ${count} waiting for you`,
    } } as const satisfies Pick<Readonly<Record<string, SessionCompanionTranslations>>, "en">;
