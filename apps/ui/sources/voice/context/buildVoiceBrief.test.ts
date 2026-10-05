import { describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { buildActivityOverviewFromCandidates } from '@/activity/attention/buildActivityOverviewSnapshot';
import { buildInboxSessionPresentation } from '@/activity/presentation/buildInboxSessionPresentation';
import type { WorkflowAttentionSource } from '@/hooks/inbox/useWorkflowAttentionSource';
import { buildVoiceBrief, type VoiceBriefSource } from './buildVoiceBrief';
import { createWorkflowRunSummaryFixture, createAutomationRunFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { buildInboxWorkGroups } from '@/activity/presentation/buildInboxWorkGroups';
import { buildInboxSessionContextLine } from '@/components/inbox/workGroups/inboxSessionContextLine';

const EMPTY_WORKFLOW_ATTENTION_SOURCE: WorkflowAttentionSource = { serverId: null, available: false, phase: 'idle', runIds: [], refreshFailed: false,
    knownAt: null, hasMore: false, loadingMore: false, loadMoreFailed: false, retry: async () => {}, loadMore: async () => {} };

function source(): VoiceBriefSource {
    const candidates = [
        ['failed', 'failed'], ['needs', 'permission_required'], ['ready', 'ready_after_read'],
    ].map(([id, reason]) => buildSessionActivityAttention({
        session: createSessionFixture({ id, serverId: 'home-a', latestTurnStatus: 'completed',
            metadata: { path: '/home/alice/private', host: 'test-host', displayName: `${id} /home/alice/private` },
            viewer: { readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: null },
                relevance: { relevant: true, reasons: ['owned_by_me'] }, follow: { follows: false, notificationLevel: null, includeInVoice: true },
                notification: { level: 'important', source: 'owner' },
                attention: { needsAttention: true, reasons: [reason as 'failed' | 'permission_required' | 'ready_after_read'],
                    primary: reason as 'failed' | 'permission_required' | 'ready_after_read', presentation: 'full' } },
        }), nowMs: 1000,
    }));
    return {
        source: { isDataReady: true, personalSessionListCoverageComplete: true,
            sessionListHomeObservationByServerId: { 'home-a': { phase: 'ready', lastSuccessAt: 900 } } },
        sessionPresentation: buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates(candidates) }),
        workGroups: [], automationAttentionItems: [], isLoading: false, showCaughtUp: false,
        workflowAttention: EMPTY_WORKFLOW_ATTENTION_SOURCE, automationAttention: EMPTY_WORKFLOW_ATTENTION_SOURCE,
    };
}

describe('Voice brief from the mounted Inbox', () => {
    it('keeps originless workflow and automation work at their exact existing Run routes', () => {
        const inbox = source();
        const row = workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'run/a', state: 'interrupted' }));
        const route = { pathname: '/automations/[id]/runs/[runId]' as const, params: { id: 'automation', runId: 'run/b' } };
        const brief = buildVoiceBrief({ inbox: { ...inbox,
            workGroups: buildInboxWorkGroups({ sessionEntries: [], workflowRuns: [row], stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null }),
            automationAttentionItems: [{ key: 'automation:run/b', run: createAutomationRunFixture({ id: 'run/b', state: 'dispatch_failed' }), route }] }, settings: {} });
        expect(brief.items.find((item) => item.destination.kind === 'workflow')).toMatchObject({ destination: { kind: 'workflow', runId: 'run/a' }, route: '/workflows/runs/run%2Fa' });
        expect(brief.items.find((item) => item.destination.kind === 'automation')).toMatchObject({ destination: { kind: 'automation', route }, route });
        expect(brief.items).toHaveLength(5);
    });
    it('orders existing attention without losing exact Home destinations or reclassifying ready work', () => {
        const brief = buildVoiceBrief({ inbox: source(), settings: { voice: { privacy: { shareSessionSummary: true } } } });
        expect(brief.items.map((item) => item.category)).toEqual(['needs_you', 'failed', 'ready']);
        expect(brief.items.map((item) => item.destination)).toEqual([
            { kind: 'session', address: { serverId: 'home-a', sessionId: 'needs' } },
            { kind: 'session', address: { serverId: 'home-a', sessionId: 'failed' } },
            { kind: 'session', address: { serverId: 'home-a', sessionId: 'ready' } },
        ]);
        expect(brief.freshness.sessionHomes).toEqual({ 'home-a': { phase: 'ready', lastSuccessAt: 900 } });
    });

    it('carries the Inbox row’s own second line for each session it lists, so the brief says more than titles', () => {
        const inbox = source();
        const brief = buildVoiceBrief({ inbox, settings: {} });
        const candidates = [
            ...inbox.sessionPresentation.sessionsNeedingAttention.map((entry) => entry.candidate),
            ...inbox.sessionPresentation.readySessions,
        ];
        for (const item of brief.items) {
            const candidate = candidates.find((entry) => item.destination.kind === 'session' && entry.sessionId === item.destination.address.sessionId);
            const expected = candidate ? buildInboxSessionContextLine(candidate) : undefined;
            expect(expected).toBeTruthy();
            expect(item.subtitle).toBe(expected);
        }
    });

    it('withholds titles, destinations and request details from speech unless the canonical privacy policy admits them', () => {
        const inbox = source();
        const brief = buildVoiceBrief({ inbox, settings: { voice: { privacy: { shareSessionSummary: false, sharePermissionRequests: false } } } });
        expect(brief.items).toHaveLength(3);
        expect(brief.context).not.toContain('private');
        expect(brief.context).not.toContain('home-a');
        expect(brief.context).not.toContain('permission_required');
        const allowed = buildVoiceBrief({ inbox, settings: { voice: { privacy: { shareSessionSummary: true } } } });
        expect(allowed.context).toContain('private');
        expect(allowed.context).not.toContain('/home/alice');
    });

    it('retains paging/failure facts and never announces caught up from unknown or partial sources', () => {
        const inbox = source();
        const brief = buildVoiceBrief({ inbox: { ...inbox, sessionPresentation: { sessionsNeedingAttention: [], readySessions: [], markAllReadTargets: [] },
            isLoading: true, showCaughtUp: true, source: { isDataReady: false, personalSessionListCoverageComplete: false },
            workflowAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, available: true, phase: 'loaded', refreshFailed: true, knownAt: 700, hasMore: true } }, settings: {} });
        expect(brief.caughtUp).toBe(false);
        expect(brief.incomplete).toBe(true);
        expect(brief.freshness.workflow).toMatchObject({ knownAt: 700, refreshFailed: true, hasMore: true });
    });
});
