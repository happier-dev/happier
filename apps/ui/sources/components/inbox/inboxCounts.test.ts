import { describe, expect, it } from 'vitest';

import { countInbox, countInboxItems, countInboxNeedsYou, countInboxNeedsYouByKind, countInboxUpdates, type InboxCountSource } from './inboxCounts';
import type { InboxItem } from './inboxItems';

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
    it('does not count unavailable Runs absent from an open Inbox projection', () => {
        expect(countInboxNeedsYou(source({ items: [], workflowAttention: { runIds: ['offline-run'] } }))).toBe(0);
    });
    it('keeps Machine reminders in Needs you and reachability in Updates', () => {
        const model = source({ machineDeletionEntries: [{}], machineReachabilityEntries: [{}] });
        expect(countInboxNeedsYou(model)).toBe(1);
        expect(countInboxUpdates(model)).toBe(1);
        expect(countInbox(model)).toBe(2);
    });
    it('counts a pending machine sign-in in Needs you before the Inbox is open', () => {
        const model = source({ machineSignInItems: [{}] });
        expect(countInboxNeedsYou(model)).toBe(1);
        expect(countInbox(model)).toBe(1);
    });
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
    it('names each kind that needs you from the same count the tab shows', () => {
        const item = (key: string, type: InboxItem['type'], kind = 'session') => ({ key, type, view: 'needs_you', producer: 'live',
            source: { kind, id: key, serverId: 'home-a' } }) as unknown as InboxItem;
        const model = source({
            items: [item('decision', 'decision'), item('run', 'approval', 'workflow_run'), item('approval-row', 'approval', 'approval')],
            openApprovals: [{}],
            actionOperationEntries: [{ reason: 'failed' }, { reason: 'failed' }, { reason: 'review_required' }],
        });
        const kinds = countInboxNeedsYouByKind(model);
        expect(kinds).toEqual({ approvals: 2, decisions: 1, blocked: 0, alerts: 0, failedActions: 2, actions: 1 });
        expect(Object.values(kinds).reduce((sum, count) => sum + count, 0)).toBe(countInboxNeedsYou(model));
    });
    it('names a notice that needs you as an alert, not as a blocked session (R19-D3 B)', () => {
        const item = (key: string, kind: string) => ({ key, type: 'blocked', view: 'needs_you', producer: 'live',
            source: { kind, id: key, serverId: 'home-a' } }) as unknown as InboxItem;
        // A failing service's health notice and a Machine's removal reminder ask for the person, but no session is blocked.
        const model = source({ items: [item('stuck', 'session'), item('health', 'account_notice'), item('removal', 'managed_machine')] });
        const kinds = countInboxNeedsYouByKind(model);
        expect(kinds).toMatchObject({ blocked: 1, alerts: 2 });
        expect(Object.values(kinds).reduce((sum, count) => sum + count, 0)).toBe(countInboxNeedsYou(model));
    });
});
