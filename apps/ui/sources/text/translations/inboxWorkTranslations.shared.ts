

export const en = {
    pageDescription: 'Everything waiting on you, grouped by the work it belongs to.',
    tabs: {
        a11y: 'Inbox view',
        needsYou: 'Needs you',
        updates: 'Updates',
    },
    groups: {
        unknownLead: 'Session',
        leadMeta: ({ count }: { count: number }) => (count === 1 ? '1 sub-session' : `${count} sub-sessions`),
        runMeta: 'Workflow run',
        otherTitle: 'Other sessions',
        otherMeta: 'Not part of an orchestrator or run',
        openSession: 'Open session',
        openRun: 'Open run',
    },
    rows: {
        step: 'Step',
        workflowRun: 'Workflow run',
        review: 'Review',
        stalled: 'Stalled',
        stalledReason: 'Its machine went offline mid-turn',
        landing: 'Landing',
        settle: 'Settle',
        snoozedUntil: ({ time }: { time: string }) => `Snoozed until ${time}`,
        more: 'More actions',
        approvalNeeded: 'Needs your approval',
        approvalUntitled: 'Approve an action',
    },
    popover: {
        moreInOther: ({ count }: { count: number }) => `${count} more in Other sessions`,
        updates: ({ count }: { count: number }) => (count === 1 ? '1 update' : `${count} updates`),
    },
    empty: {
        title: 'Nothing needs you',
        description: 'Permission requests, reviews and anything an orchestrator or workflow waits on land here.',
    },
    updatesEmpty: {
        title: 'No updates',
        description: 'Finished sessions and friend requests land here.',
    },
    stale: {
        reason: "Couldn't refresh workflow runs",
        retry: 'Try again',
    },
    settleFailed: "Couldn't settle this session",
    detail: {
        openApproval: 'Open request',
        idle: 'Choose an item to see it here',
    },
};


export const inboxWorkTranslationsEnglish = { en };