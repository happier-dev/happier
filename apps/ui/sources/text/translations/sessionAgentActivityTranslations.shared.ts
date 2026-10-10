

export const en = {
    status: {
        queued: 'Queued',
        starting: 'Starting',
        running: 'Running',
        waiting: 'Waiting',
        blocked: 'Blocked',
        succeeded: 'Completed',
        failed: 'Failed',
        timedOut: 'Timed out',
        cancelled: 'Stopped',
        unknown: 'Unknown',
    },
    attention: {
        /** A tool wants to run and someone has to approve it. */
        permission: 'Needs approval',
        /** The agent asked a question and is waiting on an answer. */
        userAction: 'Needs your answer',
        /**
         * Both at once. The badge stays one short phrase so a dense row does not grow a second
         * line; `bothDescription` is what a screen reader hears, and it names both facts.
         */
        both: 'Needs attention',
        bothDescription: 'Needs approval and needs your answer',
    },
    /** `<title>, <status>` — the spoken form of a row whose status is a badge beside the title. */
    /** The Agents roster: what is working, what waits on a person, what finished. */
    /** What kind of work a Run is, from its canonical intent and class — never a raw token. */
    runKind: {
        conversation: 'Conversation',
        review: 'Review',
        plan: 'Plan',
    },
    /** The Agents pane: its "+", its states, its team groups and its live line (agents lab). */
    roster: {
        teamLabel: ({ team, count }: { team: string; count: number }) => `Team ${team} · ${count} ${count === 1 ? 'agent' : 'agents'}`,
        teamActionsA11y: 'Team actions',
        openWork: 'Open',
        needsYouCount: ({ count }: { count: number }) => count === 1 ? '1 needs you' : `${count} need you`,
        runningCount: ({ count }: { count: number }) => `${count} running`,
        nothingRunning: 'Nothing running.',
        startAgent: 'Start an agent',
        machineOffline: ({ machine }: { machine: string }) => `${machine} isn’t answering`,
        machineOfflineUnnamed: 'The machine isn’t answering',
        launch: {
            menuA11y: 'Start an agent',
            conversationDescription: 'Talk to an agent beside this session',
            reviewDescription: 'Check the changes so far',
            planDescription: 'Work out the next steps',
            delegateDescription: 'Hand off a task and get it back done',
            advancedDescription: 'Choose agents, permissions and profile',
        },
        empty: {
            title: 'Put more agents on this session',
            reason: ({ machine }: { machine: string }) => `Start a side conversation, or ask one to review or plan while you keep working. They run on ${machine} and report back here.`,
            reasonUnnamed: 'Start a side conversation, or ask one to review or plan while you keep working. They report back here.',
            moreWays: 'Ask for a review, plan or delegate',
        },
        unavailable: {
            notEnabled: 'Agents can’t start on this Home.',
            machineOffline: ({ machine }: { machine: string }) => `Starting agents needs ${machine} online.`,
            machineOfflineUnnamed: 'Starting agents needs this machine online.',
            sessionInactive: 'This session has stopped. Resume it to start agents here.',
            externalRunnerInactive: 'This session was started outside Happier. Agents can start from here while Happier is attached to it.',
        },
    },
    summaryA11y: ({ title, status }: { title: string; status: string }) => `${title}, ${status}`,
    summaryAttentionA11y: ({ title, status, attention }: { title: string; status: string; attention: string }) =>
        `${title}, ${status}, ${attention}`,
};


export const sessionAgentActivityTranslationsEnglish = { en };