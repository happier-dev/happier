import { describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { buildActivityOverviewFromCandidates, buildActivityOverviewSnapshot } from '@/activity/attention/buildActivityOverviewSnapshot';
import { buildInboxSessionPresentation } from '@/activity/presentation/buildInboxSessionPresentation';
import type { WorkflowAttentionSource } from '@/hooks/inbox/useWorkflowAttentionSource';
import { buildVoiceBrief, type VoiceBriefSource } from './buildVoiceBrief';
import { createWorkflowRunSummaryFixture, createAutomationRunFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { buildInboxWorkGroups } from '@/activity/presentation/buildInboxWorkGroups';
import { buildInboxSessionContextLine, buildInboxSessionReasonLine } from '@/components/inbox/workGroups/inboxSessionContextLine';
import { t } from '@/text';
import { WorkflowRunPrivateMetadataV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { readInboxSessionTitle } from '@/components/inbox/sessionAttention/inboxSessionPrivacy';

const EMPTY_WORKFLOW_ATTENTION_SOURCE: WorkflowAttentionSource = { serverId: null, available: false, phase: 'idle', runIds: [], refreshFailed: false,
    knownAt: null, hasMore: false, loadingMore: false, loadMoreFailed: false, retry: async () => {}, loadMore: async () => {} };

function source(): VoiceBriefSource {
    const candidates = [
        ['failed', 'failed'], ['needs', 'permission_required'], ['ready', 'ready_after_read'],
    ].map(([id, reason]) => buildSessionActivityAttention({
        session: createSessionFixture({ id, serverId: 'home-a', latestTurnStatus: 'completed',
            metadata: { path: '/home/alice/private', host: 'test-host', summary: { text: `${id} /home/alice/private`, updatedAt: 1 } },
            viewer: { latestFailureSeq: null, readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: null },
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
    it.each([undefined, true, false])('carries current delegated-approval guidance with the native exception (enabled=%s)', (canApproveRequests) => {
        const brief = buildVoiceBrief({ inbox: source(), settings: { voice: { canApproveRequests } } });
        const guidance: unknown = JSON.parse(brief.context).approval;
        expect(guidance).toEqual(expect.stringContaining(canApproveRequests === false ? 'Voice approvals are off' : 'Voice approvals are enabled'));
        expect(guidance).toEqual(expect.stringContaining('Native Codex Realtime cannot decide requests'));
        if (canApproveRequests === false) {
            expect(guidance).toEqual(expect.stringContaining('A tap in the request UI is required'));
            expect(guidance).not.toEqual(expect.stringContaining('Use the canonical request tools to approve or deny'));
        } else {
            expect(guidance).toEqual(expect.stringContaining('Use the canonical request tools to approve or deny'));
        }
    });
    it.each([
        { total: 2, working: 0, needsYou: 0, stalled: 2, finished: 0, attentionPrimary: null },
        { total: 2, working: 0, needsYou: 2, stalled: 0, finished: 0, attentionPrimary: null },
        { total: 6, working: 2, needsYou: 1, stalled: 3, finished: 0, attentionPrimary: null },
    ])('keeps report buckets truthful in the spoken session context: %j', (reports) => {
        const inbox = source();
        const candidates = [...inbox.sessionPresentation.sessionsNeedingAttention.map(entry => entry.candidate),
            ...inbox.sessionPresentation.readySessions].map(candidate => ({ ...candidate, session: { ...candidate.session, managedSessions: reports } }));
        const brief = buildVoiceBrief({ inbox: { ...inbox, sessionPresentation: buildInboxSessionPresentation({
            overview: buildActivityOverviewFromCandidates(candidates),
        }) }, settings: { voice: { privacy: { shareSessionSummary: true } } } });
        expect(brief.items).toHaveLength(3);
        for (const item of brief.items) {
            expect(item.subtitle ?? '').not.toContain(t('sessionWork.strip.stillWorking', { count: reports.total }));
            if (reports.working > 0) expect(item.subtitle).toContain(t('sessionWork.strip.stillWorking', { count: reports.working }));
        }
        expect(brief.context).not.toContain(t('sessionWork.strip.stillWorking', { count: reports.total }));
    });
    it.each([true, false])('keeps originless work routes while sharing permitted redacted names (summary=%s)', (shareSessionSummary) => {
        const inbox = source();
        const row = { ...workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'run/a', state: 'interrupted' })),
            metadata: WorkflowRunPrivateMetadataV1Schema.parse({ kind: 'available', value: { title: 'Publish release notes' } }) };
        const route = '/workflows/runs/run%2Fb?target=occurrence&automationId=automation' as const;
        const brief = buildVoiceBrief({ inbox: { ...inbox,
            workflowAttention: { ...inbox.workflowAttention, serverId: 'home-b' },
            workGroups: buildInboxWorkGroups({ sessionEntries: [], workflowRuns: [row], automationRuns: [], automationServerId: null,
                openApprovals: [], stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null }),
            automationAttentionItems: [{ key: 'automation:run/b', title: 'Nightly dependency check /home/alice/private', run: createAutomationRunFixture({ id: 'run/b', state: 'dispatch_failed' }), route }] }, settings: { voice: { privacy: { shareSessionSummary, shareFilePaths: false } } } });
        expect(brief.items.find((item) => item.destination.kind === 'workflow')).toMatchObject({ title: 'Publish release notes', destination: { kind: 'workflow', runId: 'run/a' }, route: '/workflows/runs/run%2Fa?serverId=home-b' });
        expect(brief.items.find((item) => item.destination.kind === 'automation')).toMatchObject({ title: 'Nightly dependency check /home/alice/private', destination: { kind: 'automation', route }, route });
        expect(brief.items).toHaveLength(5);
        const spoken = JSON.parse(brief.context).items;
        expect(spoken[1]).toEqual({ category: 'needs_you', ...(shareSessionSummary ? { title: 'Publish release notes' } : {}) });
        expect(spoken.find((item: { title?: string }) => item.title?.startsWith('Nightly')))
            .toEqual(shareSessionSummary ? { category: 'needs_you', title: 'Nightly dependency check <path_redacted>' } : undefined);
        expect(brief.context).not.toContain('/home/alice');
        expect(brief.context).not.toContain(route);
    });
    it('uses the Inbox’s readable session identity even when notification previews are status-only', () => {
        const inbox = source();
        const candidates = [...inbox.sessionPresentation.sessionsNeedingAttention.map(entry => entry.candidate),
            ...inbox.sessionPresentation.readySessions].map(candidate => buildSessionActivityAttention({ session: {
                ...candidate.session, viewer: { ...candidate.session.viewer!,
                    attention: { ...candidate.session.viewer!.attention, presentation: 'status_only' as const } },
            }, presentationSource: candidate.presentationSource, nowMs: 1_000 }));
        const sessions = candidates.map(candidate => candidate.session);
        const sessionPresentation = buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates(candidates) });
        const brief = buildVoiceBrief({ inbox: { ...inbox, sessionPresentation }, settings: { voice: { privacy: { shareSessionSummary: true } } } });
        expect(brief.items).toHaveLength(3);
        for (const session of sessions) {
            const item = brief.items.find(item => item.destination.kind === 'session' && item.destination.address.sessionId === session.id);
            expect(item?.title)
                .toBe(readInboxSessionTitle(session, session.serverId ?? null));
            const candidate = [...sessionPresentation.sessionsNeedingAttention.map(entry => entry.candidate), ...sessionPresentation.readySessions]
                .find(candidate => candidate.sessionId === session.id)!;
            expect(item?.subtitle).toBe(buildInboxSessionReasonLine(candidate));
        }
        expect(JSON.parse(brief.context).items.every((item: { title?: string }) => item.title === undefined)).toBe(true);
    });
    it('omits unreadable or unnamed work without claiming the Inbox is caught up', () => {
        const inbox = source();
        const original = inbox.sessionPresentation.readySessions[0]!.session;
        const sessions = [createSessionFixture({ ...original, id: 'locked', encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_access_pending', metadata: null }),
            createSessionFixture({ ...original, id: 'unnamed', metadata: null })];
        const row = workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'unnamed-run', state: 'interrupted' }));
        const route = '/workflows/runs/unnamed-automation-run?target=occurrence&automationId=automation' as const;
        const brief = buildVoiceBrief({ inbox: { ...inbox,
            sessionPresentation: buildInboxSessionPresentation({ overview: buildActivityOverviewSnapshot({ sessions, nowMs: 1000 }) }),
            workGroups: buildInboxWorkGroups({ sessionEntries: [], workflowRuns: [row], automationRuns: [], automationServerId: null,
                openApprovals: [], stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null }),
            automationAttentionItems: [{ key: 'unnamed-automation-run', run: createAutomationRunFixture(), route }] }, settings: {} });
        expect(brief.items).toEqual([]);
        expect(JSON.parse(brief.context).items).toEqual([]);
        expect(brief.caughtUp).toBe(false);
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

    it('says why each session needs the person, never where it runs', () => {
        const inbox = source();
        const brief = buildVoiceBrief({ inbox, settings: {} });
        const candidates = [
            ...inbox.sessionPresentation.sessionsNeedingAttention.map((entry) => entry.candidate),
            ...inbox.sessionPresentation.readySessions,
        ];
        for (const item of brief.items) {
            const candidate = candidates.find((entry) => item.destination.kind === 'session' && entry.sessionId === item.destination.address.sessionId)!;
            expect(item.subtitle).toBe(buildInboxSessionReasonLine(candidate));
            // The Inbox row's "where" (Home, folder) is the context line's job; it is not a reason.
            const place = buildInboxSessionContextLine(candidate, { showHome: true, showNeed: false });
            if (place) expect(item.subtitle ?? '').not.toContain(place);
        }
    });

    it.each([
        ['permission', { tool: 'Bash', arguments: { command: 'yarn test:e2e' } }, () => t('voiceMoments.briefWantsTo', { action: t('voiceMoments.briefRunCommand', { command: 'yarn test:e2e' }) })],
        ['permission', { tool: 'Edit', arguments: { file_path: 'src/index.ts' } }, () => t('voiceMoments.briefWantsTo', { action: t('voice.readiness.permissionAccessFile', { path: 'src/index.ts' }) })],
        ['permission', { tool: 'WebFetch', arguments: {} }, () => t('voiceMoments.briefWantsTo', { action: t('voice.readiness.permissionUseTool', { tool: 'WebFetch' }) })],
        ['user_action', { tool: 'AskUserQuestion', arguments: { questions: [{ question: 'Which branch?', header: 'Branch', options: [], multiSelect: false }] } }, () => 'Which branch?'],
    ] as const)('leads with what the %s request asks for (%#)', (kind, request, expected) => {
        const inbox = source();
        const sessionsNeedingAttention = inbox.sessionPresentation.sessionsNeedingAttention.map((entry) => entry.candidate.sessionId === 'needs'
            ? { ...entry, ...(kind === 'permission'
                ? { pendingPermissions: [{ id: 'r1', ...request, createdAt: 1 }] }
                : { pendingUserActions: [{ id: 'r1', ...request, createdAt: 1 }] }) }
            : entry);
        const brief = buildVoiceBrief({ inbox: { ...inbox, sessionPresentation: { ...inbox.sessionPresentation, sessionsNeedingAttention } }, settings: {} });
        const subtitle = brief.items.find((item) => item.destination.kind === 'session' && item.destination.address.sessionId === 'needs')?.subtitle;
        expect(subtitle?.startsWith(expected())).toBe(true);
    });

    it('keeps request contents out of a status-only row', () => {
        const inbox = source();
        const sessionsNeedingAttention = inbox.sessionPresentation.sessionsNeedingAttention.map((entry) => entry.candidate.sessionId === 'needs'
            ? { ...entry, candidate: { ...entry.candidate, personalAttention: { ...entry.candidate.personalAttention, presentation: 'status_only' as const } },
                pendingPermissions: [{ id: 'r1', tool: 'Bash', arguments: { command: 'yarn secret' }, createdAt: 1 }] }
            : entry);
        const brief = buildVoiceBrief({ inbox: { ...inbox, sessionPresentation: { ...inbox.sessionPresentation, sessionsNeedingAttention } }, settings: {} });
        expect(brief.items.find((item) => item.destination.kind === 'session' && item.destination.address.sessionId === 'needs')?.subtitle ?? '').not.toContain('yarn secret');
    });

    it('withholds titles, destinations and request details from speech unless the canonical privacy policy admits them', () => {
        const inbox = source();
        const brief = buildVoiceBrief({ inbox, settings: { voice: { privacy: { shareSessionSummary: false, sharePermissionRequests: false } } } });
        expect(brief.items).toHaveLength(3);
        expect(brief.context).not.toContain('private');
        expect(brief.context).not.toContain('home-a');
        expect(brief.context).not.toContain('permission_required');
        const allowed = buildVoiceBrief({ inbox, settings: { voice: { privacy: { shareSessionSummary: true } } } });
        expect(JSON.parse(allowed.context).items.map((item: { title?: string }) => item.title)).toEqual([
            'needs <path_redacted>', 'failed <path_redacted>', 'ready <path_redacted>',
        ]);
        expect(allowed.context).not.toContain('/home/alice');
    });

    it('retains paging/failure facts and never announces caught up from unknown or partial sources', () => {
        const inbox = source();
        const brief = buildVoiceBrief({ inbox: { ...inbox, sessionPresentation: { sessionsNeedingAttention: [], readySessions: [], markAllReadTargets: [], pendingRequestHydrationTargets: [] },
            isLoading: true, showCaughtUp: true, source: { isDataReady: false, personalSessionListCoverageComplete: false },
            workflowAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, available: true, phase: 'loaded', refreshFailed: true, knownAt: 700, hasMore: true } }, settings: {} });
        expect(brief.caughtUp).toBe(false);
        expect(brief.incomplete).toBe(true);
        expect(brief.freshness.workflow).toMatchObject({ knownAt: 700, refreshFailed: true, hasMore: true });
    });
});
