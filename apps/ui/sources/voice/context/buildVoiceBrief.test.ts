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
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { createSessionListPresentationSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';

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
        if (shareSessionSummary) expect(spoken[1]).toEqual({ category: 'needs_you', title: 'Publish release notes', count: 1 });
        else expect(spoken).toEqual([{ category: 'needs_you', count: 2 }, { category: 'failed', count: 2 }, { category: 'ready', count: 1 }]);
        expect(spoken.find((item: { title?: string }) => item.title?.startsWith('Nightly')))
            .toEqual(shareSessionSummary ? { category: 'failed', title: 'Nightly dependency check <path_redacted>', count: 1 } : undefined);
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
            expect(item?.subtitle).toBe(buildInboxSessionReasonLine(candidate) || t('common.unavailable'));
        }
        // Notification previews do not override the Account's Voice disclosure policy.
        expect(JSON.parse(brief.context).items.map((item: { title?: string }) => item.title)).toEqual([
            'needs <path_redacted>', 'failed <path_redacted>', 'ready <path_redacted>',
        ]);
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
            expect(item.subtitle).toBe(buildInboxSessionReasonLine(candidate) || t('common.unavailable'));
            // The Inbox row's "where" (Home, folder) is the context line's job; it is not a reason.
            const place = buildInboxSessionContextLine(candidate, { showHome: true, showNeed: false });
            if (place) expect(item.subtitle ?? '').not.toContain(place);
        }
    });

    it.each([
        ['permission', { tool: 'Bash', arguments: { command: 'yarn test:e2e' } }, () => t('voiceMoments.briefWantsTo', { action: t('voiceMoments.briefRunCommand', { command: 'yarn test:e2e' }) })],
        ['permission', { tool: 'Edit', arguments: { file_path: 'src/index.ts' } }, () => t('voiceMoments.briefWantsTo', { action: t('voice.readiness.permissionAccessFile', { path: 'src/index.ts' }) })],
        ['permission', { tool: 'WebFetch', arguments: {} }, () => t('voiceMoments.briefWantsTo', { action: t('voice.readiness.permissionContinueAction') })],
        ['user_action', { tool: 'AskUserQuestion', arguments: { questions: [{ question: 'Which branch?', header: 'Branch', options: [], multiSelect: false }] } }, () => 'Which branch?'],
    ] as const)('leads with what the %s request asks for (%#)', (kind, request, expected) => {
        const inbox = source();
        const sessionsNeedingAttention = inbox.sessionPresentation.sessionsNeedingAttention.map((entry) => entry.candidate.sessionId === 'needs'
            ? { ...entry, requestDetails: undefined, ...(kind === 'permission'
                ? { pendingPermissions: [{ id: 'r1', ...request, createdAt: 1 }] }
                : { pendingUserActions: [{ id: 'r1', ...request, createdAt: 1 }] }) }
            : entry);
        const brief = buildVoiceBrief({ inbox: { ...inbox, sessionPresentation: { ...inbox.sessionPresentation, sessionsNeedingAttention } }, settings: {} });
        const subtitle = brief.items.find((item) => item.destination.kind === 'session' && item.destination.address.sessionId === 'needs')?.subtitle;
        expect(subtitle?.startsWith(expected())).toBe(true);
    });

    it.each([true, false])('shows the readable Inbox request despite notification status-only, with Voice sharing=%s', (sharePermissionRequests) => {
        const inbox = source();
        const original = inbox.sessionPresentation.sessionsNeedingAttention.find(entry => entry.candidate.sessionId === 'needs')!.candidate.session;
        // Restart126b's observed Home has 766 waiting rows. Exercise that admitted
        // shape without introducing a competing Brief window or disclosure cap.
        const waitingCount = 766;
        const question = 'Which branch should I publish to /home/alice/private?';
        const candidates = Array.from({ length: waitingCount }, (_, index) => buildSessionActivityAttention({ session: createSessionFixture({
            ...original, id: `waiting-${index}`, active: true, activeAt: 1_000,
            viewer: { ...original.viewer!, attention: { ...original.viewer!.attention,
                reasons: ['user_action_required'], primary: 'user_action_required', presentation: 'status_only' } },
            agentState: { controlledByUser: false, requests: { r1: { tool: 'AskUserQuestion',
                kind: 'user_action', arguments: { questions: [{ question: index === waitingCount - 1 ? 'Resume from the summary?' : question,
                    header: 'Branch', options: [], multiSelect: false }] }, createdAt: 950 } } },
        }), nowMs: 1_000 }));
        const sessionPresentation = buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates(candidates) });
        expect(sessionPresentation.sessionsNeedingAttention).toHaveLength(waitingCount);
        expect(sessionPresentation.sessionsNeedingAttention.every(entry => entry.pendingUserActions.length === 1)).toBe(true);
        const brief = buildVoiceBrief({ inbox: { ...inbox, sessionPresentation }, settings: { voice: { privacy: {
            sharePermissionRequests, shareToolArgs: true, shareSessionSummary: true,
        } } } });
        expect(brief.items).toHaveLength(waitingCount);
        expect(brief.items.filter(item => item.subtitle === question)).toHaveLength(waitingCount - 1);
        expect(brief.items.filter(item => item.subtitle === 'Resume from the summary?')).toHaveLength(1);
        const spoken: readonly { title?: string; requests?: readonly string[]; count: number }[] = JSON.parse(brief.context).items;
        expect(spoken).toHaveLength(sharePermissionRequests ? 2 : 1);
        expect(spoken.map(item => item.count)).toEqual(sharePermissionRequests ? [waitingCount - 1, 1] : [waitingCount]);
        expect(JSON.parse(brief.context).counts).toEqual({ needs_you: waitingCount, failed: 0, ready: 0 });
        expect(spoken.every(item => item.title === 'needs <path_redacted>')).toBe(true);
        expect(spoken.every(item => (item.requests?.length ?? 0) === (sharePermissionRequests ? 1 : 0))).toBe(true);
        expect(brief.context.includes('Which branch should I publish')).toBe(sharePermissionRequests);
        expect(brief.context).not.toContain('home-a');
        expect(brief.context).not.toContain('waiting-');
        expect(brief.context).not.toContain('/home/alice');
    });

    it('keeps a transient display title out of permission speech while retaining authored titles', () => {
        const inbox = source();
        const entry = inbox.sessionPresentation.sessionsNeedingAttention.find(entry => entry.candidate.sessionId === 'needs')!;
        const dictated = 'NOW ASK IT TO CREATE ANOTHER FILE CALLED SECOND NOTES DOT TEXT WITH THE WORD GOOD BY INSIDE';
        const messages = [{ id: 'dictated', kind: 'user-text' as const, localId: null, createdAt: 1, text: dictated }];
        const settings = { voice: { privacy: { shareSessionSummary: true, sharePermissionRequests: true } } };
        const permissionSpeech = (title?: string) => {
            const session = createSessionFixture({ ...entry.candidate.session, metadata: {
                path: '/project', ...(title ? { summary: { text: title, updatedAt: 2 } } : {}),
            } });
            const row = buildSessionListRenderableFromSession(session, undefined, messages);
            const candidate = buildSessionActivityAttention({ session, presentationSource: createSessionListPresentationSource(row, { baseSession: session }), nowMs: 1_000 });
            const brief = buildVoiceBrief({ inbox: { ...inbox, sessionPresentation: { ...inbox.sessionPresentation,
                sessionsNeedingAttention: [{ ...entry, candidate, requestDetails: undefined,
                    pendingPermissions: [{ id: 'r1', tool: 'Bash', arguments: {}, createdAt: 1 }] }],
                readySessions: [],
            } }, settings });
            expect(brief.items[0]?.title).toBe(title ?? dictated);
            expect(brief.context).not.toContain(dictated);
            return JSON.parse(brief.context).items[0]?.requests[0] as string;
        };
        expect(permissionSpeech()).toContain('needs permission');
        expect(permissionSpeech()).not.toContain(dictated);
        expect(permissionSpeech('Second notes')).toContain('Second notes');
    });

    it('does not substitute a status word when the Inbox request reason is not yet known', () => {
        const brief = buildVoiceBrief({ inbox: source(), settings: {} });
        const unknown = brief.items.filter(item => item.destination.kind === 'session' && item.destination.address.sessionId !== 'ready');
        expect(unknown.map(item => item.subtitle)).toEqual([t('common.unavailable'), t('common.unavailable')]);
    });

    it('retains a readable inactive question without offering request controls', () => {
        const inbox = source();
        const original = inbox.sessionPresentation.sessionsNeedingAttention.find(entry => entry.candidate.sessionId === 'needs')!.candidate.session;
        const candidate = buildSessionActivityAttention({ session: createSessionFixture({ ...original, active: false,
            viewer: { ...original.viewer!, attention: { ...original.viewer!.attention, reasons: ['permission_required', 'user_action_required'], primary: 'user_action_required' } },
            agentState: { requests: {
                stale: { tool: 'Bash', kind: 'permission', arguments: { command: 'do not revive stale permission' } },
                resume: { tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [{ question: 'Resume from the summary?' }] } },
            } },
        }), nowMs: 1_000 });
        const sessionPresentation = buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates([candidate]) });
        const brief = buildVoiceBrief({ inbox: { ...inbox, sessionPresentation }, settings: { voice: { privacy: { sharePermissionRequests: true, shareToolArgs: true } } } });
        expect(brief.items[0]).toMatchObject({ subtitle: 'Resume from the summary?', hasRequestControls: false });
        expect(brief.context).toContain('Resume from the summary?');
        expect(brief.context).not.toContain('do not revive stale permission');
        expect(sessionPresentation.sessionsNeedingAttention[0]?.requestDetails?.permissions).toEqual([]);
        expect(sessionPresentation.sessionsNeedingAttention[0]?.pendingUserActions).toEqual([]);
    });

    it.each([true, false])('uses the actual authored or typed failure reason before an unavailable label (authored=%s)', authored => {
        const inbox = source();
        const original = inbox.sessionPresentation.sessionsNeedingAttention.find(entry => entry.candidate.sessionId === 'failed')!.candidate.session;
        const candidate = buildSessionActivityAttention({ session: createSessionFixture({ ...original, latestTurnStatus: 'failed',
            metadata: { ...original.metadata!, work: { statusReason: authored ? 'Waiting for release sign-off' : undefined } },
            lastRuntimeIssue: { v: 1, scope: 'primary_session', status: 'failed', source: 'agent_session_error',
                code: 'agent_startup_rpc_rejected', occurredAt: 950 },
        }), nowMs: 1_000 });
        const sessionPresentation = buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates([candidate]) });
        const brief = buildVoiceBrief({ inbox: { ...inbox, sessionPresentation }, settings: {} });
        expect(brief.items[0]?.subtitle).toBe(authored ? 'Waiting for release sign-off' : t('session.startFailure.cause.agent_startup_rpc_rejected'));
    });

    it('states the known blocked delivery condition without inventing a delivery cause', () => {
        const inbox = source();
        const original = inbox.sessionPresentation.sessionsNeedingAttention.find(entry => entry.candidate.sessionId === 'needs')!.candidate.session;
        const candidate = buildSessionActivityAttention({ session: createSessionFixture({ ...original, active: false, pendingBlockedCount: 1,
            viewer: { ...original.viewer!, attention: { ...original.viewer!.attention, reasons: ['pending_blocked', 'unread'], primary: 'pending_blocked' } },
            lastRuntimeIssue: { v: 1, scope: 'primary_session', status: 'failed', source: 'agent_session_error',
                code: 'agent_startup_rpc_rejected', occurredAt: 950 },
        }), nowMs: 1_000 });
        const sessionPresentation = buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates([candidate]) });
        const brief = buildVoiceBrief({ inbox: { ...inbox, sessionPresentation }, settings: {} });
        expect(brief.items[0]?.subtitle).toBe(t('session.pendingMessages.deliveryBlockedReasons.unknown'));
        expect(brief.items[0]?.hasRequestControls).toBe(false);
    });

    it('preserves workflow hold reasons and automation occurrence causes in navigable rows', () => {
        const inbox = source();
        const row = { ...workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'held', state: 'waiting_for_review',
            heldCount: 1, heldStep: { invocationId: 'invocation', label: 'Approve release', laneLabel: 'Release' } })),
            metadata: WorkflowRunPrivateMetadataV1Schema.parse({ kind: 'available', value: { title: 'Do an action' } }) };
        const run = createAutomationRunFixture({ id: 'failed-occurrence', state: 'dispatch_failed' });
        const failedRow = { ...workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'failed-workflow', state: 'failed', failureUnseen: true,
            errorCode: 'agent_startup_rpc_rejected' })), metadata: row.metadata };
        const brief = buildVoiceBrief({ inbox: { ...inbox,
            workGroups: buildInboxWorkGroups({ sessionEntries: [], workflowRuns: [row, failedRow], automationRuns: [], automationServerId: null,
                openApprovals: [], stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null }),
            automationAttentionItems: [{ key: 'occurrence', title: 'Memory upkeep', run, route: '/workflows/runs/failed-occurrence?target=occurrence&automationId=automation' }],
        }, settings: {} });
        expect(brief.items.find(item => item.destination.kind === 'workflow')?.subtitle).toContain('Approve release');
        expect(brief.items.find(item => item.destination.kind === 'workflow')?.subtitle).toContain('Release');
        expect(brief.items.find(item => item.destination.kind === 'automation')?.subtitle).toBeTruthy();
        expect(brief.items.find(item => item.key === 'run:failed-workflow')?.category).toBe('failed');
        expect(brief.items.find(item => item.key === 'run:failed-workflow')?.subtitle).toBe(t('session.startFailure.cause.agent_startup_rpc_rejected'));
        expect(brief.items.find(item => item.key === 'occurrence')?.category).toBe('failed');
        expect(JSON.parse(brief.context).counts).toEqual({ needs_you: 2, failed: 3, ready: 1 });
    });

    it('counts workflow and automation failures through the existing Run status owner', () => {
        const inbox = source();
        const row = { ...workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'failure', state: 'failed', failureUnseen: true })),
            metadata: WorkflowRunPrivateMetadataV1Schema.parse({ kind: 'available', value: { title: 'Do an action' } }) };
        const brief = buildVoiceBrief({ inbox: { ...inbox,
            workGroups: buildInboxWorkGroups({ sessionEntries: [], workflowRuns: [row], automationRuns: [], automationServerId: null,
                openApprovals: [], stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null }),
            automationAttentionItems: [{ key: 'automation-failure', title: 'Memory upkeep', run: createAutomationRunFixture({ state: 'dispatch_failed' }),
                route: '/workflows/runs/failure?target=occurrence&automationId=automation' }],
        }, settings: {} });
        expect(brief.items.filter(item => item.destination.kind !== 'session').map(item => item.category)).toEqual(['failed', 'failed']);
        expect(JSON.parse(brief.context).counts).toEqual({ needs_you: 1, failed: 3, ready: 1 });
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
