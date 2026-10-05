import { describe, expect, it } from 'vitest';

import { buildActivityOverviewSnapshot } from '@/activity/attention/buildActivityOverviewSnapshot';
import { buildInboxSessionPresentation } from '@/activity/presentation/buildInboxSessionPresentation';
import { buildInboxWorkGroups } from '@/activity/presentation/buildInboxWorkGroups';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';

import { createInboxItemRoute, isFocusedInboxWorkItem, readInboxItemFocus } from './inboxItemFocus';

describe('Home-qualified Inbox focus', () => {
    it('selects only the qualified Session when two Homes have the same id', () => {
        const sessions = ['home-a', 'home-b'].map((serverId) => createSessionFixture({
            id: 'same-session', serverId, active: true, pendingPermissionRequestCount: 1, pendingRequestObservedAt: 1_000,
        }));
        const presentation = buildInboxSessionPresentation({ overview: buildActivityOverviewSnapshot({ sessions, nowMs: 1_000 }) });
        const items = buildInboxWorkGroups({ sessionEntries: presentation.sessionsNeedingAttention,
            workflowRuns: [], stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null,
        }).flatMap((group) => group.items);
        expect(items).toHaveLength(2);
        const focus = readInboxItemFocus(createInboxItemRoute({ kind: 'session', serverId: 'home-b', id: 'same-session' }).params.item);
        expect(items.filter((item) => isFocusedInboxWorkItem(item, focus)).map((item) => item.key)).toEqual(['session:home-b:same-session']);
    });

    it('round-trips qualified ids and refuses ambiguous legacy or malformed input', () => {
        const focus = { kind: 'session', serverId: 'https://home.example/a:b', id: 'session:with/parts' } as const;
        const route = createInboxItemRoute(focus);
        expect(readInboxItemFocus([route.params.item])).toEqual(focus);
        for (const value of [undefined, '', 'session:legacy', 'run:legacy', 'session::id', 'run:home:', 'session:%XX:id', 'session:home:id:extra']) {
            expect(readInboxItemFocus(value)).toBeNull();
        }
    });

    it('compares the workflow Run focus against the Home that serves the Inbox window', () => {
        const row = workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'same-run' }), null);
        const item = { kind: 'workflow_run', key: 'run:same-run', runId: 'same-run', row } as const;
        const focus = readInboxItemFocus(createInboxItemRoute({ kind: 'workflow_run', serverId: 'home-b', id: 'same-run' }).params.item);
        expect(isFocusedInboxWorkItem(item, focus, 'home-a')).toBe(false);
        expect(isFocusedInboxWorkItem(item, focus, 'home-b')).toBe(true);
        expect(isFocusedInboxWorkItem(item, focus, null)).toBe(false);
    });
});
