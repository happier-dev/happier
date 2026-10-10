import { describe, expect, it } from 'vitest';

import { countInbox, countInboxItems, countInboxNeedsYou, countInboxUpdates, type InboxCountSource } from './inboxCounts';

function source(overrides: Partial<InboxCountSource> = {}): InboxCountSource {
    return {
        openApprovals: [],
        openUsageNotices: [],
        actionOperationEntries: [],
        friendRequests: [],
        sessionPresentation: { sessionsNeedingAttention: [], readySessions: [] },
        workflowAttention: { runIds: [] },
        automationAttention: { runIds: [] },
        ...overrides,
    };
}

describe('Inbox counts', () => {
    it('counts ordinary Automation attention even with no Workflow or Session rows', () => {
        const model = source({ automationAttention: { runIds: ['pre-session-failure'] } });
        expect(countInboxNeedsYou(model)).toBe(1);
        expect(countInbox(model)).toBe(1);
    });
    it('counts what the rail badge counts: a waiting run before its row has loaded, never a parked row', () => {
        // The badge is built from the attention window's run ids and the session classifier. The
        // list also draws rows that are not asking for anything now (snoozed, stalled) and draws a
        // run only once its row has loaded; neither may make the page disagree with the badge.
        const model = source({
            openApprovals: [{}, {}],
            sessionPresentation: { sessionsNeedingAttention: [{}], readySessions: [{}, {}, {}] },
            workflowAttention: { runIds: ['run-1', 'run-2'] },
            friendRequests: [{}],
        });
        expect(countInboxNeedsYou(model)).toBe(5);
        expect(countInboxUpdates(model)).toBe(4);
        expect(countInbox(model)).toBe(9);
        // The always-mounted summary feeds the same formula from its own narrow projections.
        expect(countInboxItems({ sessions: 4, workflowRuns: 2, automationRuns: 0, approvalsAndNotices: 2, operations: 0, friendRequests: 1 })).toBe(9);
    });
});
