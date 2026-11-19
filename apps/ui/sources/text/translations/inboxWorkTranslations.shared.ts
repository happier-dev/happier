

export const en = {
    pageDescription: 'What needs you, what changed and who mentioned you.',
    needsYouSummary: ({ approvals, decisions, blocked }: { approvals: number; decisions: number; blocked: number }) => {
        const parts = [
            approvals > 0 ? `${approvals} ${approvals === 1 ? 'approval' : 'approvals'}` : null,
            decisions > 0 ? `${decisions} ${decisions === 1 ? 'decision' : 'decisions'}` : null,
            blocked > 0 ? `${blocked} ${blocked === 1 ? 'blocked session' : 'blocked sessions'}` : null,
        ].filter((part): part is string => part !== null);
        const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? '';
        return `${list} ${approvals + decisions + blocked === 1 ? 'needs you' : 'need you'}.`;
    },
    quickDecision: { allowOnce: 'Allow once' },
    keyHints: { move: 'move', fullPage: 'full page', close: 'close', answering: 'Answering opens the next one' },
    tabs: {
        a11y: 'Inbox view',
        needsYou: 'Needs you',
        updates: 'Updates',
        mentions: 'Mentions',
    },
    groups: {
        openSession: 'Open session',
        openRun: 'Open run',
    },
    rows: {
        step: 'Step',
        pluginControlUnavailable: 'That didn’t go through. Open the session to try there.',
        workflowRun: 'Workflow run',
        review: 'Review',
        stalled: 'Stalled',
        stalledReason: 'Its machine went offline mid-turn',
        reportsTo: ({ lead }: { lead: string }) => `Reports to ${lead}`,
        landing: 'Landing',
        settle: 'Settle',
        snoozedUntil: ({ time }: { time: string }) => `Snoozed until ${time}`,
        more: 'More actions',
        approvalNeeded: 'Needs your approval',
        approvalUntitled: 'Approve an action',
        mentionedYou: "Mentioned you",
        newMessage: "New message",
    },
    popover: {
        updates: ({ count }: { count: number }) => (count === 1 ? '1 update' : `${count} updates`),
    },
    types: { approval: "Approvals", decision: "Decisions", blocked: "Blocked" },
    days: { today: "Today", earlier: "Earlier" },
    mentionsEmpty: {
        title: "No mentions",
        description: "When someone mentions you in a Discussion, it lands here.",
    },
    empty: {
        title: 'Nothing needs you',
        description: 'Permission requests, reviews and anything a Coordinator or Workflow waits on land here.',
    },
    updatesEmpty: {
        title: 'No updates',
        description: 'Finished sessions and friend requests land here.',
    },
    stale: {
        reason: "Couldn't refresh workflow runs",
        sources: 'Some items may be missing.',
        sourcesTitle: "Couldn't load everything",
        retry: 'Try again',
    },
    loadingRest: 'Still loading the rest.',
    settleFailed: "Couldn't settle this session",
    detail: {
        openApproval: 'Open request',
    },
    healthNotice: {
        where: 'Where it’s failing',
        service: 'Service',
        machine: 'Machine',
        failing: 'Failing',
        environment: 'Environment',
        investigate: 'Investigate',
        investigateHint: ({ machine }: { machine: string }) => `Investigate opens a new session on ${machine} with this notice as evidence.`,
        approvalBody: 'The session opens once the request is approved.',
        selectionTitle: 'Investigate needs a choice',
        selectionBody: 'Investigate couldn’t pick a session or an agent on its own. Nothing was started.',
        uncertainTitle: 'Not sure a session started',
        uncertainBody: 'Check your sessions before trying again.',
        unavailableTitle: 'Couldn’t start an investigation',
        unavailableBody: 'Nothing was started.',
        agentActionsNeedMachine: 'Agent actions need their Machine online.',
        agentActionsUnavailable: 'Agent actions couldn’t be loaded.',
        alertInvestigateHint: 'Opens a session with this issue as evidence.',
        investigateUnavailable: 'Investigate isn’t available for this alert.',
        notSetUpTitle: 'This action isn’t set up',
        notSetUpBody: 'Finish setting it up in Actions, then try again.',
        notSetUpAction: 'Open actions',
        placementTitle: 'Choose where to work',
        placementReason: {
            controller_required: 'Its controller isn’t known. Pick the Machine to work on.',
            machine_unreachable: 'Its Machine is offline. Pick another, or try again once it’s back.',
            ambiguous_workspace: 'More than one folder fits. Pick the one to work in.',
            agent_required: 'No default agent is set. Pick the agent to use.',
        },
        placementOffline: 'Offline',
        placementAnyFolder: 'Any folder',
        placementAgent: 'Agent',
        placementConfirm: 'Start here',
    },
};


export const inboxWorkTranslationsEnglish = { en };
