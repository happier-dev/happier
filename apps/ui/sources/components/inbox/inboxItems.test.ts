import { describe, expect, it, vi } from 'vitest';

// Counts the shared approval review owner's derivations; the real review still runs underneath.
vi.mock('@/components/approvals/actionApprovalReview', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/approvals/actionApprovalReview')>();
    return { ...actual, readActionApprovalReview: vi.fn(actual.readActionApprovalReview) };
});
// Counts Inbox route derivations; the real route owner still runs underneath.
vi.mock('./inboxItemFocus', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./inboxItemFocus')>();
    return { ...actual, createInboxItemRoute: vi.fn(actual.createInboxItemRoute) };
});
import { createAccountNoticeArtifactFixture, usageNoticeFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { AccountNoticeArtifactHeaderV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { SessionQuestionContextV1Schema } from '@happier-dev/protocol/sessions/permissions/v1';
import type { Session } from '@/sync/domains/state/storageTypes';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { buildInboxItems, type InboxItem, type InboxItemsInput } from './inboxItems';
import { DiscussionOpenedSummaryV1Schema, DiscussionOpenedMessageV1Schema } from '@happier-dev/protocol/discussions/actions';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { DiscussionMessageV1Schema } from '@happier-dev/protocol/discussions/models';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import { isInboxSessionStatusOnly, readInboxSessionTitle } from './sessionAttention/inboxSessionPrivacy';
import { SESSION_CONTENT_AVAILABILITIES } from '@/sync/domains/session/encryptedContentAvailability';
import { countInbox, countInboxNeedsYou } from './inboxCounts';
import { ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { createInboxItemRoute, readInboxItemFocus } from './inboxItemFocus';
import { projectInboxReadItemV1 } from '@happier-dev/protocol/actions/appShellActionFamily';
import { RunFollowOccurrenceV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { createSessionFixture, createSessionListRenderableSessionFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import type { Message } from '@happier-dev/session-core/messages';
import { t } from '@/text';
import { readOpenApprovalInboxEntry } from '@/sync/domains/artifacts/approvalArtifactAdmission';

const emptyInput: InboxItemsInput = { sessionPresentation: { sessionsNeedingAttention: [], readySessions: [],
    markAllReadTargets: [], pendingRequestHydrationTargets: [] }, workGroups: [], workflowServerId: 'home-a',
    accountServerId: 'home-a', notices: [] };

async function input(overrides: Partial<Session> = {}): Promise<InboxItemsInput> {
    const { buildActivityOverviewSnapshot } = await import('@/activity/attention/buildActivityOverviewSnapshot');
    const { buildInboxSessionPresentation } = await import('@/activity/presentation/buildInboxSessionPresentation');
    const { buildInboxWorkGroups } = await import('@/activity/presentation/buildInboxWorkGroups');
    const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const session = createSessionFixture({ id: 'ask', serverId: 'home-a', active: true,
        pendingPermissionRequestCount: 1, pendingRequestObservedAt: 1_000, ...overrides });
    const sessionPresentation = buildInboxSessionPresentation({ overview: buildActivityOverviewSnapshot({ sessions: [session], nowMs: 1_000 }) });
    return { sessionPresentation, workGroups: buildInboxWorkGroups({
        sessionEntries: sessionPresentation.sessionsNeedingAttention, workflowRuns: [], automationRuns: [],
        automationServerId: null, openApprovals: [], stalledSessions: [], landings: [], snoozed: [],
        resolveSession: () => session, resolveOriginRunId: () => null,
    }), workflowServerId: 'home-a', accountServerId: 'home-a', notices: [] };
}

describe('one Inbox row projection', () => {
    it('omits recording-hidden attention and ready Sessions without changing their held source', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { setScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');
        const original = storage.getState();
        const source = await input();
        try {
            storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { 'home-a': ['private'] } });
            storage.getState().setSessionTagAssignmentsOptimistic('home-a', 'ask', ['private']);
            expect(buildInboxItems(source)).toHaveLength(1);
            setScreenSharingPrivacyActive(true);
            expect(buildInboxItems(source)).toEqual([]);
            const candidate = source.sessionPresentation.sessionsNeedingAttention[0]!.candidate;
            expect(buildInboxItems({ ...emptyInput, sessionPresentation: {
                ...emptyInput.sessionPresentation, readySessions: [candidate],
            } })).toEqual([]);
            setScreenSharingPrivacyActive(false);
            expect(buildInboxItems(source)).toHaveLength(1);
        } finally { setScreenSharingPrivacyActive(false); storage.setState(original, true); }
    });
    it('keeps Landing as the single Session row when the same Session also has an unread finished turn', async () => {
        const { buildInboxWorkGroups } = await import('@/activity/presentation/buildInboxWorkGroups');
        const session = createSessionFixture({ id: 'landing-ready', serverId: 'home-a', active: true, activeAt: 1_000, seq: 2,
            latestReadyEventSeq: 2, latestTurnStatus: 'completed', lastViewedSessionSeq: 0 });
        const source = await input({ ...session, viewer: createSessionOwnerViewerFixture(session),
            pendingPermissionRequestCount: 0, pendingRequestObservedAt: null });
        expect(source.sessionPresentation.readySessions).toHaveLength(1);
        const workGroups = buildInboxWorkGroups({ sessionEntries: source.sessionPresentation.sessionsNeedingAttention,
            workflowRuns: [], automationRuns: [], automationServerId: null, openApprovals: [], stalledSessions: [], snoozed: [],
            landings: [{ session, link: { number: 42, url: 'https://forge.example/acme/app/pull/42', state: 'open' } }],
            resolveSession: () => session, resolveOriginRunId: () => null });
        expect(buildInboxItems({ ...source, workGroups })).toEqual([
            expect.objectContaining({ key: `landing:${sessionAddressKey({ serverId: 'home-a', sessionId: session.id })}`, focus: { kind: 'session', serverId: 'home-a', id: session.id } }),
        ]);
        const otherHome = await input({ ...session, serverId: 'home-b', viewer: createSessionOwnerViewerFixture(session),
            pendingPermissionRequestCount: 0, pendingRequestObservedAt: null });
        expect(buildInboxItems({ ...source, workGroups, sessionPresentation: { ...source.sessionPresentation,
            readySessions: [...source.sessionPresentation.readySessions, ...otherHome.sessionPresentation.readySessions],
        } }).map(row => row.focus.serverId)).toEqual(['home-a', 'home-b']);
    });

    it('orders mixed row attention and ready entries by the reconciled lifecycle clock', async () => {
        const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
        const { createSessionListPresentationSource } = await import('@/sync/domains/session/listing/sessionListRenderableSessionProjection');
        const requested = await input({ updatedAt: 900 });
        const entry = requested.sessionPresentation.sessionsNeedingAttention[0]!;
        const base = createSessionFixture({ id: entry.candidate.sessionId, serverId: 'home-a', updatedAt: 900 });
        const row = buildSessionListRenderableFromSession({ ...base, seq: base.seq + 1, updatedAt: 100 });
        const candidate = { ...entry.candidate, session: row,
            presentationSource: createSessionListPresentationSource(row, { baseSession: base, serverId: 'home-a' }),
            lastTurnCompletedAt: null };
        const workGroups = requested.workGroups.map(group => ({ ...group, items: group.items.map(item => item.kind === 'session'
            ? { ...item, entry: { ...item.entry, candidate } } : item) }));
        expect(buildInboxItems({ ...requested, workGroups })[0]?.createdAt).toBe(900);
        expect(buildInboxItems({ ...emptyInput, sessionPresentation: {
            ...emptyInput.sessionPresentation, readySessions: [candidate],
        } })[0]?.createdAt).toBe(900);
    });
    it('reads a list-only lead title without disclosing unreadable or other-Home leads', async () => {
        const requested = await input({ manager: { sessionId: 'lead' } });
        const lead = createSessionListRenderableSessionFixture({ id: 'lead', serverId: 'home-a',
            metadata: { name: 'Payments rollout', path: '/project', host: 'qa-host' } });
        const source = { ...requested, sessionsById: {}, sessionListRowsByServerId: { 'home-a': { lead } } };
        expect(buildInboxItems(source)[0]?.reportsTo).toEqual({
            address: { serverId: 'home-a', sessionId: 'lead' }, title: 'Payments rollout',
        });
        expect(buildInboxItems({ ...source, sessionListRowsByServerId: { 'home-a': { lead: {
            ...lead, encryptedContentAvailability: 'encrypted_content_unavailable',
        } } } })[0]?.reportsTo?.title).toBeNull();
        expect(buildInboxItems({ ...source, sessionListRowsByServerId: { 'home-b': { lead } } })[0]?.reportsTo?.title).toBeNull();
    });

    it('resolves list-only worker and lead facts for an external-plugin Inbox landing', () => {
        const lead = createSessionListRenderableSessionFixture({ id: 'lead', serverId: 'home-a',
            metadata: { name: 'Payments rollout', path: '/project', host: 'qa-host' } });
        const worker = createSessionListRenderableSessionFixture({ id: 'worker', serverId: 'home-a',
            manager: { sessionId: lead.id } });
        const pluginSessionRows = [{ key: 'external/index/worker', pluginId: 'acme.external', indexResourceId: 'index',
            row: { id: worker.id, session: { serverId: 'home-a', sessionId: worker.id }, title: 'Worker', detail: null,
                detailResource: { pluginId: 'acme.external', resourceId: 'detail' } } }];
        expect(buildInboxItems({ ...emptyInput, pluginSessionRows,
            sessionListRowsByServerId: { 'home-a': { lead, worker } } })[0]?.reportsTo).toEqual({
            address: { serverId: 'home-a', sessionId: lead.id }, title: 'Payments rollout',
        });
    });

    it('carries the immediate lead for attention and external-plugin Session rows', async () => {
        const requested = await input({ manager: { sessionId: 'lead' } });
        const root = createSessionFixture({ id: 'root', serverId: 'home-a' });
        const lead = createSessionFixture({ id: 'lead', serverId: 'home-a', manager: { sessionId: root.id } });
        const worker = createSessionFixture({ id: 'worker', serverId: 'home-a', manager: { sessionId: lead.id } });
        const pluginSessionRows = [{ key: 'external/index/worker', pluginId: 'acme.external', indexResourceId: 'index',
            row: { id: worker.id, session: { serverId: 'home-a', sessionId: worker.id }, title: 'Worker', detail: null,
                detailResource: { pluginId: 'acme.external', resourceId: 'detail' } } }];
        const projected = buildInboxItems({ ...requested, pluginSessionRows, sessionsById: { root, lead, worker } });
        expect(projected).toHaveLength(2);
        for (const row of projected) expect(row.reportsTo).toEqual({
            address: { serverId: 'home-a', sessionId: lead.id }, title: readInboxSessionTitle(lead, 'home-a'),
        });
        expect(buildInboxItems({ ...requested, sessionsById: { lead: { ...lead, serverId: 'home-b' } } })[0]?.reportsTo)
            .toEqual({ address: { serverId: 'home-a', sessionId: lead.id }, title: null });
        expect(buildInboxItems(await input())[0]?.reportsTo).toBeUndefined();
    });

    it('carries the latest available Session WorkerUpdate headline from the exact lead without reading unrelated transcripts', () => {
        const lead = createSessionFixture({ id: 'lead', serverId: 'home-a' });
        const worker = createSessionFixture({ id: 'ask', serverId: 'home-a', manager: { sessionId: lead.id } });
        const pluginSessionRows = [{ key: 'external/index/worker', pluginId: 'acme.external', indexResourceId: 'index',
            row: { id: worker.id, session: { serverId: 'home-a', sessionId: worker.id }, title: 'Worker', detail: null,
                detailResource: { pluginId: 'acme.external', resourceId: 'detail' } } }];
        const update = (id: string, seq: number, workerId: string, headline: string): Extract<Message, { kind: 'agent-event' }> => ({
            kind: 'agent-event', id, seq, localId: id, createdAt: seq,
            event: { type: 'worker-update', update: { v: 1, workerKind: 'session', workerId,
                ownerState: 'settled', wake: 'finished', headline, canInspect: true } },
        });
        const history: Message[] = Array.from({ length: 20_000 }, (_, index) => ({
            kind: 'user-text', id: `history-${index}`, seq: index + 1, localId: null, createdAt: index + 1, text: 'Earlier prompt',
        }));
        const messages = [...history, update('old', 20_001, 'ask', 'Earlier result'), update('latest', 20_002, 'ask', 'Runbook drafted'),
            update('other', 20_003, 'other-worker', 'Other result')];
        const transcript = createSessionMessagesFixture({ isLoaded: true,
            messageIdsOldestFirst: messages.map(message => message.id),
            messagesById: Object.fromEntries(messages.map(message => [message.id, message])) });
        const sessionMessagesById = { lead: transcript,
            get unrelated(): ReturnType<typeof createSessionMessagesFixture> {
                throw new Error('An Inbox row must not read unrelated transcript bodies');
            } };
        const source = { ...emptyInput, pluginSessionRows, sessionsById: { lead, ask: worker }, sessionMessagesById };
        const projected = buildInboxItems(source);
        expect(projected[0]?.view).toBe('updates');
        expect(projected[0]?.workerUpdateHeadline).toBe(`${t('sessionWork.workerUpdate.state.settled')} · Runbook drafted`);
        let bodyReads = 0;
        for (const message of messages) {
            const kind = message.kind;
            Object.defineProperty(message, 'kind', { configurable: true, enumerable: true,
                get: () => { bodyReads++; return kind; } });
        }
        expect(buildInboxItems({ ...source, sessionMessagesById: { lead: transcript,
            unrelated: createSessionMessagesFixture({ messagesVersion: 1 }),
        } }, projected)).toBe(projected);
        expect(bodyReads).toBe(0);
        const changed = update('latest', 20_002, 'ask', 'Runbook revised');
        expect(buildInboxItems({ ...source, sessionMessagesById: { lead: createSessionMessagesFixture({ ...transcript,
            latestWorkerUpdates: undefined,
            messagesById: { ...transcript.messagesById, latest: changed },
        }) } }, projected)[0]?.workerUpdateHeadline).toBe(`${t('sessionWork.workerUpdate.state.settled')} · Runbook revised`);
        for (const headline of ['Finished its turn', `${readInboxSessionTitle(worker, 'home-a')} · settled`, 'ask · settled']) {
            const native = update('latest', 20_002, 'ask', headline);
            expect(buildInboxItems({ ...source, sessionMessagesById: { lead: createSessionMessagesFixture({
                ...transcript, latestWorkerUpdates: undefined, messagesById: { ...transcript.messagesById, latest: native },
            }) } })[0]?.workerUpdateHeadline).toBe(t('sessionWork.workerUpdate.state.settled'));
        }
        expect(buildInboxItems({ ...source, sessionsById: { ask: worker, lead: { ...lead, serverId: 'home-b' } } })[0]?.workerUpdateHeadline)
            .toBeUndefined();
        expect(buildInboxItems({ ...source, sessionsById: { ask: worker, lead: { ...lead, encryptedContentAvailability: 'encrypted_content_unavailable' } } })[0]?.workerUpdateHeadline)
            .toBeUndefined();
        expect(buildInboxItems({ ...source, sessionsById: { lead, ask: { ...worker,
            encryptedContentAvailability: 'encrypted_content_unavailable' } } })[0]?.workerUpdateHeadline)
            .toBeUndefined();
    });

    it('uses Session presentation for an admitted live Resource landing and removes it when withdrawn', async () => {
        const { PluginSessionInboxRowV1Schema } = await import('@happier-dev/protocol/plugins/contributions/ui/sessionInbox');
        const row = PluginSessionInboxRowV1Schema.parse({ id: 'linked-session',
            session: { serverId: 'home-a', sessionId: 'ask' }, title: 'Linked work', detail: null,
            detailResource: { pluginId: 'acme.review', resourceId: 'detail' } });
        const pluginSessionRows = [{ key: 'acme.review/index/linked-session', pluginId: 'acme.review',
            indexResourceId: 'index', row }];
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const session = createSessionFixture({ id: 'ask', serverId: 'home-a', updatedAt: 123 });
        const landing = buildInboxItems({ ...emptyInput, pluginSessionRows, sessionsById: { ask: session } });
        expect(landing).toHaveLength(1);
        expect(landing[0]).toMatchObject({ producer: 'live', type: 'update', title: readInboxSessionTitle(session, 'home-a'),
            createdAt: 123, focus: { kind: 'session', serverId: 'home-a', id: 'ask' } });
        const joined = buildInboxItems({ ...await input(), pluginSessionRows });
        expect(joined).toHaveLength(1);
        expect(joined[0]).toMatchObject({ type: 'approval', pluginSessionRows });
        expect(buildInboxItems({ ...emptyInput, pluginSessionRows: [] }, landing)).toEqual([]);
    });

    it('keeps settled Session landings out without suppressing an existing Session request', async () => {
        const row = { key: 'external/index/session', pluginId: 'acme.external', indexResourceId: 'index',
            row: { id: 'ask', session: { serverId: 'home-a', sessionId: 'ask' }, title: 'Linked work', detail: null,
                detailResource: { pluginId: 'acme.external', resourceId: 'detail' } } };
        const { buildSessionOrganizationSessionKey } = await import('@/sync/domains/session/organization/keys');
        const attentionStandings = { [buildSessionOrganizationSessionKey('home-a', 'ask')]: {
            sessionId: 'ask', standing: false, updatedAt: 1,
        } };
        expect(buildInboxItems({ ...emptyInput, attentionStandings, pluginSessionRows: [row] })).toEqual([]);
        expect(buildInboxItems({ ...await input(), attentionStandings, pluginSessionRows: [row] }))
            .toEqual([expect.objectContaining({ type: 'approval' })]);
    });

    it('groups external live Resource rows with the exact Session request and retains unrelated rows', async () => {
        const row = { key: 'acme.review/inbox/one', pluginId: 'acme.review', indexResourceId: 'inbox',
            row: { id: 'one', session: { serverId: 'home-a', sessionId: 'ask' }, title: 'Review', detail: 'Checks failed',
                detailResource: { pluginId: 'acme.review', resourceId: 'detail' } } };
        const first = buildInboxItems({ ...emptyInput, pluginSessionRows: [row] });
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({ producer: 'live', focus: { kind: 'session', serverId: 'home-a', id: 'ask' },
            title: 'Review', pluginSessionRows: [row] });
        const requested = await input();
        const grouped = buildInboxItems({ ...requested, pluginSessionRows: [row] });
        expect(grouped).toHaveLength(1);
        expect(grouped[0]).toMatchObject({ type: 'approval', pluginSessionRows: [row] });
        const other = { ...row, key: 'acme.review/inbox/two', row: { ...row.row, id: 'two',
            session: { serverId: 'home-a', sessionId: 'other' } } };
        const both = buildInboxItems({ ...emptyInput, pluginSessionRows: [row, other] }, first);
        expect(both[0]).toBe(first[0]);
        expect(buildInboxItems({ ...emptyInput, pluginSessionRows: [] }, both)).toEqual([]);
    });

    it('uses owner-projected Workflow attention rather than held-count guesses, keeping failures in Updates', async () => {
        const { createWorkflowRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
        const { workflowRunRowFromSummary } = await import('@/sync/store/domains/workflowRuns');
        const project = (facts: { failureUnseen: boolean; invocationAttentionRequired: boolean; attentionRequired: boolean; heldCount: number }) => {
            const summary = { ...createWorkflowRunSummaryFixture({ state: 'failed' }), ...facts };
            const row = workflowRunRowFromSummary(summary, null);
            return buildInboxItems({ ...emptyInput, workGroups: [{ key: 'other', root: { kind: 'other' },
                items: [{ kind: 'workflow_run', key: 'run:run-1', runId: summary.id, row,
                    heldStepLabel: null, heldStepLaneLabel: null, heldStepNeed: null }] }] });
        };
        const failed = project({ failureUnseen: true, invocationAttentionRequired: false, attentionRequired: true, heldCount: 7 });
        expect(failed[0]).toMatchObject({ type: 'update', view: 'updates', workStatus: { tone: 'danger', attentionType: 'update' } });
        expect(countInboxNeedsYou({ items: failed, openApprovals: [], openUsageNotices: [],
            actionOperationEntries: [], friendRequests: [], sessionPresentation: emptyInput.sessionPresentation,
            workflowAttention: { runIds: failed.map(item => item.source.id) }, automationAttention: { runIds: [] } })).toBe(0);
        const held = project({ failureUnseen: false, invocationAttentionRequired: true, attentionRequired: true, heldCount: 0 });
        expect(held[0]).toMatchObject({ type: 'decision', view: 'needs_you', workStatus: { tone: 'attention', attentionType: 'decision' } });
        const seen = project({ failureUnseen: false, invocationAttentionRequired: false, attentionRequired: false, heldCount: 7 });
        expect(seen[0]).toMatchObject({ type: 'update', view: 'updates', workStatus: { tone: 'neutral', attentionType: null } });
        expect(countInboxNeedsYou({ items: seen, openApprovals: [], openUsageNotices: [], actionOperationEntries: [],
            friendRequests: [], sessionPresentation: emptyInput.sessionPresentation,
            workflowAttention: { runIds: [] }, automationAttention: { runIds: [] } })).toBe(0);
    });
    it.each(['plain', 'e2ee'] as const)('reads a %s Session title without visiting its 1,000 pending requests', async (encryptionMode) => {
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        let requestReads = 0;
        const pending = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`request-${index}`, {
            tool: 'Bash', arguments: { command: 'true' }, createdAt: 1_000,
        }]));
        // Count actual request-row reads, keeping the real privacy/title and pending logic.
        const requests = new Proxy(pending, {
            get(target, key, receiver) {
                if (typeof key === 'string' && Object.hasOwn(target, key)) requestReads++;
                return Reflect.get(target, key, receiver);
            },
        });
        const session = createSessionFixture({ encryptionMode, encryptedContentAvailability: 'ready', active: true,
            metadata: { name: 'Question worker', path: '/project', host: 'qa-host' }, agentState: { requests },
            pendingPermissionRequestCount: undefined, pendingUserActionRequestCount: undefined });
        expect(readInboxSessionTitle(session, 'home-a')).toBe('Question worker');
        expect(requestReads).toBe(0);
    });

    it.each(['plain', 'e2ee'] as const)('keeps %s Inbox title privacy tied to the decryption owner alone', async (encryptionMode) => {
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        for (const availability of [null, ...SESSION_CONTENT_AVAILABILITIES]) {
            const session = createSessionFixture({ encryptionMode, encryptedContentAvailability: availability,
                metadata: { name: 'Private cached title', path: '/private/path', host: 'private-host' } });
            const readable = availability === 'ready' || availability === null && encryptionMode === 'plain';
            expect(isInboxSessionStatusOnly(session)).toBe(!readable);
            expect(readInboxSessionTitle(session, 'home-a') === 'Private cached title').toBe(readable);
        }
    });

    it('projects live Execution Runs once and removes settled Runs instead of retaining notices', () => {
        const run = ExecutionRunPublicStateSchema.parse({ runId: 'run-review', callId: 'call', sidechainId: 'sidechain',
            intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, display: { title: 'Review changes' },
            permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
            status: 'running', startedAtMs: 100 });
        const entry = { address: { serverId: 'home-a', sessionId: 'source-session' }, run };
        const initial = buildInboxItems({ ...emptyInput, executionRuns: [entry] });
        expect(initial).toHaveLength(1);
        expect(initial[0]).toMatchObject({ producer: 'live', type: 'update', view: 'updates', title: 'Review changes',
            source: { kind: 'execution_run', id: run.runId, serverId: 'home-a' },
            focus: { kind: 'execution_run', id: run.runId, serverId: 'home-a', sessionId: 'source-session' } });
        expect(readInboxItemFocus(createInboxItemRoute(initial[0]!.focus).params.item)).toEqual(initial[0]!.focus);
        expect(projectInboxReadItemV1(initial[0]!)).toMatchObject({ focus: initial[0]!.focus, producer: 'live' });
        expect(buildInboxItems({ ...emptyInput, executionRuns: [entry] }, initial)).toBe(initial);
        const waiting = buildInboxItems({ ...emptyInput, executionRuns: [{ ...entry,
            run: { ...run, attention: { kind: 'permission_required', requestIds: ['permission-a'] } } }] }, initial);
        expect(waiting).toHaveLength(1);
        expect(waiting[0]).toMatchObject({ key: initial[0]!.key, type: 'approval', view: 'needs_you' });
        expect(buildInboxItems({ ...emptyInput, executionRuns: [{ ...entry,
            run: { ...run, status: 'succeeded', finishedAtMs: 200 } }] }, waiting)).toEqual([]);
    });
    it('keeps an accepted Run one-shot as a source-backed Update until its receipt is read', () => {
        const run = ExecutionRunPublicStateSchema.parse({ runId: 'settled-run', callId: 'call', sidechainId: 'sidechain',
            intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, display: { title: 'Review changes' },
            permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
            status: 'succeeded', startedAtMs: 100, finishedAtMs: 200 });
        const onceDelivery = RunFollowOccurrenceV1Schema.parse({ original: { source: {
            kind: 'execution_run', sessionId: 'source-session', runId: run.runId,
        }, terminalEventId: 'terminal-one' }, event: { kind: 'finished' } });
        const entry = { address: { serverId: 'home-a', sessionId: 'source-session' }, run, onceDeliveries: [onceDelivery] };
        const rows = buildInboxItems({ ...emptyInput, executionRuns: [entry] });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ producer: 'live', type: 'update', view: 'updates', read: false,
            source: { kind: 'execution_run', id: run.runId, onceDeliveries: [onceDelivery] } });
        const laterReceipt = RunFollowOccurrenceV1Schema.parse({ ...onceDelivery,
            original: { ...onceDelivery.original, terminalEventId: 'terminal-two' } });
        const changed = buildInboxItems({ ...emptyInput, executionRuns: [{ ...entry, onceDeliveries: [laterReceipt] }] }, rows);
        expect(changed[0]?.source.onceDeliveries).toEqual([laterReceipt]);
        expect(buildInboxItems({ ...emptyInput, executionRuns: [{ ...entry, onceDeliveries: [] }] }, rows)).toEqual([]);
    });
    it('opens a detached Run at its exact Machine without inventing a Session', () => {
        const run = ExecutionRunPublicStateSchema.parse({ runId: 'detached-run', callId: 'call', sidechainId: 'sidechain',
            intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, display: { title: 'Review changes' },
            permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
            status: 'running', startedAtMs: 100 });
        const entry = { address: { serverId: 'home-a', machineId: 'machine-one' }, run };
        const [row] = buildInboxItems({ ...emptyInput, executionRuns: [entry] });
        expect(row).toMatchObject({ focus: { kind: 'execution_run', serverId: 'home-a', id: run.runId, machineId: 'machine-one' } });
        expect(row!.focus).not.toHaveProperty('sessionId');
        expect(row!.pageRoute).toBe('/runs?serverId=home-a&machineId=machine-one&runId=detached-run');
        expect(readInboxItemFocus(createInboxItemRoute(row!.focus).params.item)).toEqual(row!.focus);
        expect(projectInboxReadItemV1(row!)).toMatchObject({ focus: row!.focus, producer: 'live' });
        const offline = buildInboxItems({ ...emptyInput, executionRuns: [{ ...entry, unavailable: 'target_unavailable' }] }, [row!]);
        expect(offline[0]?.workStatus).toMatchObject({ state: 'disconnected', bucket: 'offline', tone: 'neutral' });
        expect(buildInboxItems({ ...emptyInput, executionRuns: [entry] }, offline)[0]?.workStatus).toEqual(row!.workStatus);
    });
    it('does not turn an answered one-shot permission into a running Update', () => {
        const run = ExecutionRunPublicStateSchema.parse({ runId: 'permission-run', callId: 'call', sidechainId: 'sidechain',
            intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, display: { title: 'Review changes' },
            permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
            status: 'running', startedAtMs: 100, attention: { kind: 'permission_required', requestIds: ['permission-one'] } });
        const onceDelivery = RunFollowOccurrenceV1Schema.parse({ original: { source: {
            kind: 'execution_run', machineId: 'machine-one', runId: run.runId,
        }, permissionRequests: [{ requestId: 'permission-one', createdAt: 100 }] }, event: { kind: 'needs_you', type: 'approval' } });
        const entry = { address: { serverId: 'home-a', machineId: 'machine-one' }, run, persistent: false,
            onceDeliveries: [onceDelivery] };
        expect(buildInboxItems({ ...emptyInput, executionRuns: [entry] })[0]).toMatchObject({ type: 'approval', view: 'needs_you' });
        expect(buildInboxItems({ ...emptyInput, executionRuns: [{ ...entry, run: { ...run, attention: undefined } }] })).toEqual([]);
        expect(buildInboxItems({ ...emptyInput, executionRuns: [{ ...entry, run: { ...run,
            attention: { kind: 'permission_required', requestIds: ['another-permission'] } } }] })).toEqual([]);
    });
    it('keeps cached Session names unavailable when only status is readable', async () => {
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const session = createSessionFixture({ id: 'locked-source', serverId: 'home-a', encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_content_unavailable', metadata: { name: 'Private cached project', path: '/private/path', host: 'private-host' } });
        const [row] = buildInboxItems({ ...emptyInput, workGroups: [{ key: 'other', root: { kind: 'other' },
            items: [{ kind: 'stalled', key: 'stalled:locked-source', session }] }] });
        expect(row).toMatchObject({ title: readInboxSessionTitle(session, 'home-a'),
            source: { displayName: readInboxSessionTitle(session, 'home-a') } });
        expect(JSON.stringify(row)).not.toContain('Private cached project');
    });
    it('builds approval rows without deriving any approval review: none per rebuild, none when one approval changes', async () => {
        const { readActionApprovalReview } = await import('@/components/approvals/actionApprovalReview');
        const reviews = vi.mocked(readActionApprovalReview);
        const artifactFor = (index: number, summary = `Change name ${index}`) => {
            const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: index, updatedAtMs: index,
                createdBy: { surface: 'cli' }, actionId: 'account.name.set', actionArgs: { name: 'Captain' }, summary,
                executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
                    serverId: 'request-home', actionId: 'account.name.set', requestId: `request-${index}` } });
            return { id: `approval-${index}`, isDecrypted: true, title: request.summary,
                header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request),
                headerVersion: 1, bodyVersion: 1, seq: index, createdAt: index, updatedAt: index } satisfies DecryptedArtifact;
        };
        const itemFor = (artifact: DecryptedArtifact) => ({ kind: 'approval' as const, key: `approval:${artifact.id}`,
            artifact, approval: readOpenApprovalInboxEntry(artifact)! });
        const items = Array.from({ length: 40 }, (_, index) => itemFor(artifactFor(index + 1)));
        const build = (workItems: typeof items, previous: readonly InboxItem[] = []) => buildInboxItems({ ...emptyInput,
            workGroups: [{ key: 'other', root: { kind: 'other' }, items: workItems }] }, previous);
        reviews.mockClear();
        const rows = build(items);
        expect(rows).toHaveLength(40);
        const counts = { build: reviews.mock.calls.length, rebuild: 0, oneChanged: 0 };
        reviews.mockClear();
        const routes = vi.mocked(createInboxItemRoute);
        routes.mockClear();
        expect(build(items, rows)).toBe(rows);
        counts.rebuild = reviews.mock.calls.length;
        // Retaining an unchanged row never re-derives its route address.
        expect(routes).not.toHaveBeenCalled();
        reviews.mockClear();
        const changed = items.map((item, index) => index === 7 ? itemFor({ ...artifactFor(8, 'Renamed'), title: 'Renamed' }) : item);
        const next = build(changed, rows);
        counts.oneChanged = reviews.mock.calls.length;
        // Quick decisions belong to the mounted row (ApprovalInboxCard), which also holds requester authority.
        expect(counts).toEqual({ build: 0, rebuild: 0, oneChanged: 0 });
        expect(next[7]).not.toBe(rows[7]);
        expect(next[7]!.title).toBe('Renamed');
        expect(next.filter((row, index) => row === rows[index])).toHaveLength(39);
    });
    it('projects exact qualified live Discussion mentions and Doc anchors, then drops them on owner read', () => {
        const scope = { serverId: 'home-b', accountId: 'me' };
        const summary = DiscussionOpenedSummaryV1Schema.parse({ id: 'thread', ownerAccountId: 'me', encryptionMode: 'plain',
            anchor: { kind: 'doc', doc: { ref: { kind: 'doc', artifactId: 'plan-doc', serverId: 'home-b' },
                revision: { headerVersion: 1, bodyVersion: 2 } } }, access: 'owner', keyReadiness: true, dataEncryptionKey: null,
            creationLocalId: null, title: 'Doc review', latestMessage: { id: 'newer-chatter', localId: null, seq: 3,
                authorAccountId: null, accountActor: null, producerV1: null, createdAt: 3 },
            messageSeq: 3, lastReadSeq: 1, unreadCount: 2, unreadMentionCount: 1, recentAuthorAccountIds: [], archivedAt: null,
            capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false } });
        const committed = DiscussionMessageV1Schema.parse({ id: 'actual-mention', discussionId: 'thread', localId: null,
            seq: 2, authorAccountId: 'alice', accountActor: { v: 1, accountId: 'alice',
                profile: { name: 'Alice Chen', firstName: 'Alice', lastName: 'Chen', username: 'alice', avatarUrl: null } }, producerV1: null,
            content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Please\n review' }] } },
            mentionedAccountIds: ['me'], createdAt: 2 });
        const message = DiscussionOpenedMessageV1Schema.parse({ ...committed,
            content: committed.content.t === 'plain' ? committed.content.v : null,
            messageRef: createDiscussionMessageRefV1({ serverId: 'home-b', discussionId: 'thread' }, committed) });
        const source = (opened = message, discussion = summary, type: 'mention' | 'decision' = 'mention') => ({ scope,
            entries: [{ discussion, occurrences: [{ message: opened, type }] }] });
        const before = buildInboxItems({ ...emptyInput, discussions: source() });
        const mention = before.find(item => item.view === 'mentions');
        expect(mention).toMatchObject({ focus: { kind: 'discussion', serverId: 'home-b', id: 'thread', messageId: 'actual-mention' },
            source: { displayName: 'Doc review' }, excerpt: 'Please review',
            author: resolveAccountActorPresentation({ ...committed.accountActor!, serverId: scope.serverId }, scope),
            discussion: { messageRef: message.messageRef, anchor: summary.anchor } });
        expect(mention?.pageRoute).toBe('/discussions/thread?serverId=home-b&messageId=actual-mention');
        const namedDocSource = { ...source(), docDisplayNames: new Map([['plan-doc', 'Release guide']]) };
        const namedDoc = buildInboxItems({ ...emptyInput, discussions: namedDocSource }, before);
        expect(namedDoc[0]).toMatchObject({ title: 'Release guide', source: { displayName: 'Release guide' } });
        const renamedDoc = buildInboxItems({ ...emptyInput, discussions: { ...namedDocSource,
            docDisplayNames: new Map([['plan-doc', 'Revised release guide']]) } }, namedDoc);
        expect(renamedDoc[0]?.title).toBe('Revised release guide');
        expect(renamedDoc[0]).not.toBe(namedDoc[0]);
        expect(buildInboxItems({ ...emptyInput, discussions: { ...namedDocSource, docDisplayNames: new Map() } }, namedDoc)[0]?.title).toBe('Doc review');
        expect(buildInboxItems({ ...emptyInput, discussions: source() }, before)).toBe(before);
        const editedMessage = { ...message, content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Changed excerpt' }] } };
        const edited = buildInboxItems({ ...emptyInput, discussions: source(editedMessage) }, before);
        expect(edited[0]).not.toBe(before[0]);
        expect(edited[0]?.excerpt).toBe('Changed excerpt');
        const renamedAuthor = { ...message, accountActor: { ...message.accountActor!, profile: { ...message.accountActor!.profile!, name: 'Alice renamed' } } };
        const renamed = buildInboxItems({ ...emptyInput, discussions: source(renamedAuthor) }, before);
        expect(renamed[0]).not.toBe(before[0]);
        expect(renamed[0]?.author?.name).toBe('Alice renamed');
        const producedMessage = DiscussionOpenedMessageV1Schema.parse({ ...message, authorAccountId: null, accountActor: null,
            producerV1: { v: 1, kind: 'agent', sessionId: 'payments-bot' } });
        const produced = { ...emptyInput, discussions: { ...source(producedMessage),
            sessionDisplayNames: new Map([['payments-bot', 'Payments coordinator']]) } };
        const botRows = buildInboxItems(produced, before);
        expect(botRows[0]?.author).toEqual({ name: 'Payments coordinator' });
        expect(botRows[0]).not.toBe(before[0]);
        expect(buildInboxItems({ ...produced, discussions: { ...produced.discussions, sessionDisplayNames: new Map() } }, botRows)[0]?.author).toBeNull();
        expect(buildInboxItems({ ...emptyInput, discussions: source({ ...message, content: null }) }, before)).toEqual([]);
        const read = { ...summary, lastReadSeq: 3, unreadCount: 0, unreadMentionCount: 0 };
        expect(buildInboxItems({ ...emptyInput, discussions: source(message, read, 'decision') }, before)[0])
            .toMatchObject({ type: 'decision', view: 'needs_you', read: true });
        const countsFor = (items: readonly InboxItem[]) => ({ items, openApprovals: [], openUsageNotices: [],
            actionOperationEntries: [], friendRequests: [], sessionPresentation: emptyInput.sessionPresentation,
            workflowAttention: { runIds: [] }, automationAttention: { runIds: [] } });
        for (const discussion of [summary, read]) {
            const model = countsFor(buildInboxItems({ ...emptyInput, discussions: source(message, discussion, 'decision') }));
            expect(countInboxNeedsYou(model)).toBe(1);
            expect(countInbox(model)).toBe(1);
        }
        expect(countInbox(countsFor(buildInboxItems({ ...emptyInput, discussions: { scope, entries: [] } })))).toBe(0);
        expect(buildInboxItems({ ...emptyInput, discussions: { scope, entries: [] } }, before)).toEqual([]);
    });
    it.each(['blocked', 'decision', undefined] as const)('projects the canonical pending question subtype %s', async type => {
        const current = await input({ pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 1,
            agentState: { requests: { question: { tool: 'AskUserQuestion', kind: 'user_action',
                arguments: { questions: [{ question: 'What next?' }] }, createdAt: 100,
                questionV1: SessionQuestionContextV1Schema.parse({ mode: 'continue', assumption: 'Keep working',
                    lasting: false, ...(type ? { type } : {}) }),
            } } },
        });
        expect(current.sessionPresentation.sessionsNeedingAttention[0]?.pendingUserActions[0]?.questionV1?.type).toBe(type);
        expect(buildInboxItems(current)).toEqual([expect.objectContaining({ type: type ?? 'decision', view: 'needs_you' })]);
    });

    it('keeps oldest-question selection, approval precedence, and unavailable-request fallback', async () => {
        const request = { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 100 };
        const agentState = { requests: {
            newer: { ...request, createdAt: 200, questionV1: SessionQuestionContextV1Schema.parse({
                mode: 'wait', type: 'blocked', lasting: false }) },
            older: { ...request, questionV1: SessionQuestionContextV1Schema.parse({
                mode: 'wait', type: 'decision', lasting: false }) },
        } };
        const current = await input({ pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 2, agentState });
        expect(current.sessionPresentation.sessionsNeedingAttention[0]?.pendingUserActions.map(value => value.id))
            .toEqual(['older', 'newer']);
        expect(buildInboxItems(current)[0]).toMatchObject({ type: 'decision' });
        const approval = await input({ pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 2, agentState });
        expect(buildInboxItems(approval)[0]).toMatchObject({ type: 'approval' });
        const unavailable = await input({ pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 1 });
        expect(unavailable.sessionPresentation.sessionsNeedingAttention[0]?.pendingUserActions).toEqual([]);
        expect(buildInboxItems(unavailable)[0]).toMatchObject({ type: 'decision' });
    });

    it('joins a live owner and a private plugin notice without retaining settled live work', async () => {
        const current = await input();
        const artifact = createAccountNoticeArtifactFixture({ header: { body: 'Review the change', excerpt: 'Opened preview' } });
        const notice = { artifact, header: AccountNoticeArtifactHeaderV1Schema.parse(artifact.rawHeader) };
        const named = { ...current, notices: [notice], pluginDisplayNames: new Map([['acme.review', 'Acme Review']]) };
        const rows = buildInboxItems(named);
        expect(rows.map(row => [row.producer, row.view])).toEqual([['live', 'needs_you'], ['notice', 'updates']]);
        expect(rows[0]?.source).toMatchObject({ displayName: current.sessionPresentation.sessionsNeedingAttention[0]?.candidate.title });
        expect(rows[1]).toMatchObject({ source: { displayName: 'Acme Review' }, author: null, excerpt: 'Review the change' });
        expect(buildInboxItems(named, rows)).toBe(rows);
        const renamed = buildInboxItems({ ...named, pluginDisplayNames: new Map([['acme.review', 'Review renamed']]) }, rows);
        expect(renamed[0]).toBe(rows[0]);
        expect(renamed[1]).not.toBe(rows[1]);
        expect(renamed[1]?.source.displayName).toBe('Review renamed');
        expect(buildInboxItems({ ...current, notices: [notice] })[1]).toMatchObject({ source: { displayName: null }, author: null });
        expect(rows[1]?.pageRoute).toBe('/plugins/acme.review/reviews/42');
        const settled = buildInboxItems({ ...named, workGroups: [] }, rows);
        expect(settled).toHaveLength(1);
        expect(settled[0]).toBe(rows[1]);
    });

    it('leaves an open usage notice to its own card instead of a second generic row', () => {
        // A host usage notice is drawn once, by its usage/Machines card from the same Artifact's usage projection.
        const usage = createAccountNoticeArtifactFixture({ id: 'usage-notice', header: { title: 'Reset credit expires soon',
            source: { kind: 'host', topic: 'connected_service_usage' }, page: undefined, notice: usageNoticeFixture, body: JSON.stringify(usageNoticeFixture) } });
        const plugin = createAccountNoticeArtifactFixture({ id: 'plugin-notice' });
        const rows = buildInboxItems({ ...emptyInput, notices: [usage, plugin].map(artifact =>
            ({ artifact, header: AccountNoticeArtifactHeaderV1Schema.parse(artifact.rawHeader) })) });
        expect(rows.map(row => row.source.id)).toEqual(['plugin-notice']);
    });
    it('keeps read Mentions visible without counting them as fresh or moving them into Needs you', () => {
        const artifact = createAccountNoticeArtifactFixture({ header: { title: 'You were mentioned', type: 'mention', readAt: 2_000 } });
        const rows = buildInboxItems({ ...emptyInput, notices: [
            { artifact, header: AccountNoticeArtifactHeaderV1Schema.parse(artifact.rawHeader) },
        ] });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ view: 'mentions', type: 'mention', read: true });
    });

    it('retains the Automation attention owner Home instead of the ambient Account Home', async () => {
        const { createAutomationRunFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
        const run = createAutomationRunFixture({ id: 'run-1', automationId: 'automation-1', state: 'failed' });
        const row = { id: run.id, revision: run.revision, updatedAt: run.updatedAt, summary: null, metadata: null, automation: run };
        const rows = buildInboxItems({ ...emptyInput, workGroups: [{ key: 'automation:served-home:automation-1',
            root: { kind: 'automation', automationId: run.automationId, serverId: 'served-home', runId: run.id },
            items: [{ kind: 'automation_run', key: 'automation-run:run-1', row }],
        }] });
        expect(rows[0]).toMatchObject({ source: { serverId: 'served-home' }, focus: { serverId: 'served-home' } });
        expect(rows[0]?.pageRoute).toBe('/workflows/runs/run-1?target=occurrence&automationId=automation-1&serverId=served-home');
    });
    it('carries the current question handler and continue assumption from the same live request', async () => {
        const current = await input();
        const group = current.workGroups[0]!;
        const item = group.items[0]!;
        if (item.kind !== 'session') throw new Error('Expected Session fixture');
        const request = { id: 'question', kind: 'user_action' as const, tool: 'AskUserQuestion',
            arguments: {}, createdAt: 1_000, currentHandler: { kind: 'session' as const, sessionId: 'manager' },
            questionV1: { mode: 'continue' as const, assumption: 'Use the default', lasting: false } };
        const rows = buildInboxItems({ ...current, workGroups: [{ ...group, items: [{ ...item,
            entry: { ...item.entry, pendingPermissions: [], pendingUserActions: [request] } }] }] });
        expect(rows[0]).toMatchObject({ question: { requestId: 'question', mode: 'continue', assumption: 'Use the default',
            currentHandler: { kind: 'session', address: { serverId: 'home-a', sessionId: 'manager' } } } });
    });
});
