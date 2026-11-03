import type { ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';
import { SessionSharedMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { AgentStateSchema } from '@happier-dev/session-core/state';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionFixture } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const { mockSessionRpcWithPreferredSessionScope, mockMachineRpcWithServerScope } = vi.hoisted(() => ({
    mockSessionRpcWithPreferredSessionScope: vi.fn(),
    mockMachineRpcWithServerScope: vi.fn(),
}));

// Network transports and their encryption adapter are the substituted boundaries. The mounted
// controller, the React Native adapter and its subscription registry, the
// Session store, the awareness/pending-request/interaction owners and the
// permission-answer owner are all real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope', () => ({
    sessionRpcWithPreferredSessionScope: (...args: unknown[]) => mockSessionRpcWithPreferredSessionScope(...args),
}));
// The daemon catalog is reached through the real loader/parser/catalog, with
// only its machine RPC transport substituted.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => mockMachineRpcWithServerScope(...args),
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { listPendingRequestListsFromSession } = await import('@/sync/domains/session/pending/listPendingSessionRequests');
const { listSessionPendingPermissions } = await import('@/sync/ops/sessionPendingPermissions');
const { projectSessionSummaryCard } = await import('@/components/sessions/companion/summary/sessionSummaryProjection');
const { projectUiSessionAwareness } = await import('@/sync/domains/session/awareness/sessionAwareness');
const { createCanonicalPluginReactNativeHostApiAdapter } = await import('@/components/plugins/reactNative/hostApi');
const { createPluginSurfaceContextFixture } = await import('@/dev/testkit/fixtures/pluginSurfaceContextFixture');
import { createSessionAccessFixture, createSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
const { storage } = await import('@/sync/domains/state/storage');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
import type { Session } from '@/sync/domains/state/storageTypes';
import { buildSessionListRenderableFromSession, deriveSessionListRenderableHasUnreadMessagesFromSession } from '@/sync/domains/session/listing/sessionListRenderable';

const { createBoundPluginSurfaceController } = await import('./boundPluginSurfaceController');

const initialStorageState = storage.getState();

const CURRENT_ACCOUNT_LIFETIME = Object.freeze({
    scope: { serverId: 'server-1', accountId: 'account-a' },
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
});

const canonicalSurface = createPluginSurfaceContextFixture({ target: { kind: 'app' } });

function mountSurface(accountScope = CURRENT_ACCOUNT_LIFETIME.scope) {
    const controller = createBoundPluginSurfaceController({
        facts: {
            pluginId: 'acme.triage',
            contributionId: 'desk',
            surfaceId: 'surface_1',
            placement: 'appSurface',
            platform: 'ios',
            channel: 'internal',
            accountLifetime: { ...CURRENT_ACCOUNT_LIFETIME, scope: accountScope },
            interactionEnabled: true,
            daemonInteractionEnabled: false,
        },
    });
    const adapter = createCanonicalPluginReactNativeHostApiAdapter({
        surface: canonicalSurface,
        requestSurface: controller.surfaceContext,
        requestIdPrefix: 'rn-session',
        handleRequest: controller.hostApi.handleRequest,
        installedMethods: controller.hostApi.installedMethods,
    });
    const unsubscribe = controller.subscribeResourceInvalidations(
        (event) => { adapter.publishResourceSubscriptionEvent(event); },
    );
    return { controller, api: adapter.api, dispose: () => { unsubscribe(); adapter.dispose(); controller.dispose(); } };
}

// A live Session: awareness only reports what fresh runtime evidence supports.
const NOW = Date.now();

function waitingSession(overrides: Partial<Session> = {}): Session {
    return createSessionFixture({
        id: 'linked-1',
        active: true,
        createdAt: NOW,
        updatedAt: NOW,
        activeAt: NOW,
        metadata: {
            path: '/work/repo',
            host: 'box.local',
            homeDir: '/home/me',
            machineId: 'machine-1',
            flavor: 'claude',
        } as Session['metadata'],
        agentState: {
            requests: {
                'req-1': {
                    tool: 'Bash',
                    arguments: { command: 'yarn test' },
                    createdAt: NOW - 1_000,
                    turnId: 'turn-1',
                },
            },
        } as Session['agentState'],
        ...overrides,
    });
}

describe('mounted plugin UI linked-Session state (r0.42)', () => {
    beforeEach(async () => {
        await homes.reset();
        installHomeGovernanceBoundaries(homes);
        storage.setState(initialStorageState, true);
        mockSessionRpcWithPreferredSessionScope.mockReset();
        mockSessionRpcWithPreferredSessionScope.mockResolvedValue(undefined);
        clearDaemonMergedProjectionCacheForTests();
        mockMachineRpcWithServerScope.mockReset();
    });

    it.each(['ready', 'empty', 'hidden', 'unavailable', 'paged', 'missingWitness', 'modeMismatch'] as const)('publishes %s external-shareable activity through the real bound controller without marking read', async (outcome) => {
        const serverId = await homes.addHome({ name: 'Activity Home', serverUrl: 'https://activity.test', accountId: 'account-a' });
        const session = installSessionActionFixture({ homes, storage, serverId, session: waitingSession({
            id: 'activity-session', seq: 7, lastViewedSessionSeq: 1, agentState: null,
            viewer: createSessionViewerFixture({ readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: 2000 },
                attention: { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'full' } }),
            ...(outcome === 'hidden' ? { access: createSessionAccessFixture('owner', { readTranscript: false }) } : {}),
        }) });
        const row = (seq: number, role: string, text: string) => ({ id: `item-${seq}`, seq, localId: `local-${seq}`,
            messageRole: role, createdAt: seq * 1000, updatedAt: seq * 1000,
            content: { t: 'plain', v: { role, content: { type: 'text', text } } } });
        homes.answer(serverId, `GET /v1/sessions/${session.id}/messages`, { select: (_input, request) => {
            const query = new URL(request.url).searchParams;
            expect(query.get('projection')).toBe('externalShareableV1');
            if (outcome === 'paged' && !query.has('beforeSeq')) return { body: {
                messages: [row(7, 'agent', 'private draft')], hasMore: true, nextBeforeSeq: 7,
                publicationBlocked: false, externalShareableSnapshot: { turns: [] },
            } };
            const tool = { ...row(8, 'agent', ''), content: { t: 'plain', v: { role: 'agent', content: {
                type: 'codex', data: { type: 'tool-call', callId: 'tool-1', name: 'Bash', input: { command: 'private tool command' } },
            } } } };
            return outcome === 'unavailable' ? { status: 503, body: {} } : { body: {
                messages: outcome === 'empty' ? [] : outcome === 'modeMismatch'
                    ? [{ ...row(6, 'agent', ''), content: { t: 'encrypted', c: 'unopenable' } }]
                    : [tool, row(7, 'agent', 'private draft'), row(6, 'agent', 'safe final'), row(5, 'user', 'private prompt')]
                        .filter(item => !query.has('beforeSeq') || item.seq < Number(query.get('beforeSeq'))),
                hasMore: false, nextBeforeSeq: null, publicationBlocked: false,
                ...(outcome === 'missingWitness' ? {} : { externalShareableSnapshot: { turns: [{ turnId: 'completed', status: 'completed', startedAt: 1, updatedAt: 6,
                    transcriptAnchors: { startSeqInclusive: 6, endSeqInclusive: 6, userMessageSeqs: [], finalAssistantMessageSeq: 6 } }] } }),
            } };
        } });
        const mounted = mountSurface({ serverId, accountId: 'account-a' });
        try {
            const state = await mounted.api.readSession(session.id);
            const kind = outcome === 'paged' ? 'ready' : outcome === 'missingWitness' || outcome === 'modeMismatch' ? 'unavailable' : outcome;
            expect(state).toMatchObject({ hasUnreadMessages: deriveSessionListRenderableHasUnreadMessagesFromSession(session),
                latestActivity: kind === 'ready' ? { kind: 'ready', text: 'safe final', createdAt: 6000 } : { kind } });
            expect(JSON.stringify(state)).not.toContain('private draft');
            expect(JSON.stringify(state)).not.toContain('private prompt');
            expect(JSON.stringify(state)).not.toContain('private tool command');
            expect(storage.getState().sessions[session.id]?.lastViewedSessionSeq).toBe(1);
            expect(homes.requests.filter(request => request.path.includes('/read-state'))).toHaveLength(0);
            if (outcome === 'ready') {
                expect(state?.hasUnreadMessages).toBe(true);
                const events: ResourceSubscriptionEvent[] = [];
                const watch = await mounted.api.watchSession(session.id, event => events.push(event));
                try {
                    storage.getState().applySessions([{ ...storage.getState().sessions[session.id]!,
                        viewer: createSessionViewerFixture() }]);
                    await vi.waitFor(() => expect(events.some(event => event.kind === 'invalidated')).toBe(true));
                    await expect(mounted.api.readSession(session.id)).resolves.toMatchObject({ hasUnreadMessages: false });
                    const count = events.length;
                    storage.getState().applySessions([{ ...storage.getState().sessions[session.id]!, seq: 8 }]);
                    await vi.waitFor(() => expect(events.length).toBeGreaterThan(count));
                } finally { watch.dispose(); }
            }
        } finally { mounted.dispose(); }
    });

    it('reads what a waiting Session wants to run, where, and which answers the viewer may give', async () => {
        storage.getState().applySessions([waitingSession()]);
        const mounted = mountSurface();

        const state = await mounted.api.readSession('linked-1');

        expect(state).toMatchObject({
            sessionId: 'linked-1',
            title: 'repo',
            serverId: CURRENT_ACCOUNT_LIFETIME.scope.serverId,
            operational: 'permission_required',
            workStatus: { state: 'permission_required', bucket: 'needs_you', tone: 'attention',
                attentionType: 'approval', word: expect.any(String) },
            workspace: { path: '/work/repo' },
            pendingPermissions: [{
                requestId: 'req-1',
                toolName: 'Bash',
                command: 'yarn test',
                createdAtMs: NOW - 1_000,
                answers: ['allowOnce', 'allowForSession', 'deny'],
            }],
        });
        mounted.dispose();
    });

    it('tracks the host title when its Home-qualified list projection changes', async () => {
        const session = waitingSession({ serverId: CURRENT_ACCOUNT_LIFETIME.scope.serverId, agentState: null });
        storage.getState().applySessions([session]);
        const mounted = mountSurface();
        const events: ResourceSubscriptionEvent[] = [];
        const subscription = await mounted.api.watchSession(session.id, (event) => { events.push(event); });
        try {
            const row = buildSessionListRenderableFromSession(session, undefined, [{
                id: 'first-prompt', kind: 'user-text', localId: null, createdAt: 1,
                text: 'Investigate the mobile panel',
            }]);
            storage.setState({ sessionListRowsByServerId: { [CURRENT_ACCOUNT_LIFETIME.scope.serverId]: { [session.id]: row } } });
            await vi.waitFor(() => expect(events).toHaveLength(1));
            await expect(mounted.api.readSession(session.id)).resolves.toMatchObject({ title: 'Investigate the mobile panel' });
        } finally { subscription.dispose(); mounted.dispose(); }
    });

    it.each(['read', 'watch'] as const)('hydrates a reachable linked Session outside the loaded client window before %s', async (method) => {
        const serverId = await homes.addHome({ name: 'Cold linked Session', serverUrl: 'https://cold-linked-session.test', accountId: 'account-a' });
        installSessionActionFixture({ homes, storage, serverId, session: waitingSession({ id: 'cold-linked' }) });
        storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
        const mounted = mountSurface({ serverId, accountId: 'account-a' });
        try {
            if (method === 'watch') {
                const watch = await mounted.api.watchSession('cold-linked', () => {});
                watch.dispose();
            }
            await expect(mounted.api.readSession('cold-linked')).resolves.toMatchObject({
                sessionId: 'cold-linked', serverId,
            });
            expect(storage.getState().sessions['cold-linked']).toBeDefined();
        } finally {
            mounted.dispose();
        }
    });

    it.each(['read', 'watch'] as const)('does not publish cold Session hydration after its mount retires (%s)', async (method) => {
        const serverId = await homes.addHome({ name: 'Retired linked Session', serverUrl: 'https://retired-linked-session.test', accountId: 'account-a' });
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        installSessionActionFixture({
            homes: { ...homes, answer(serverId, path, answer) { homes.answer(serverId, path, { ...answer, respondAfter: held }); } },
            storage, serverId, session: waitingSession({ id: 'cold-retired' }),
        });
        storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
        const mounted = mountSurface({ serverId, accountId: 'account-a' });
        const pending = method === 'read' ? mounted.api.readSession('cold-retired')
            : mounted.api.watchSession('cold-retired', () => {});
        try {
            await vi.waitFor(() => expect(homes.requests.some((request) => request.path.startsWith('/v2/sessions/cold-retired'))).toBe(true));
            mounted.dispose();
            release();
            await expect(pending).rejects.toBeInstanceOf(Error);
            expect(storage.getState().sessions['cold-retired']).toBeUndefined();
        } finally {
            release();
            mounted.dispose();
            await pending.catch(() => undefined);
        }
    });

    it('projects the shared Work classification, including outstanding reports and offline settlement', async () => {
        storage.getState().applySessions([
            waitingSession({ id: 'working', agentState: null, thinking: true, thinkingAt: NOW, latestTurnStatus: 'in_progress' }),
            waitingSession({ id: 'finished', agentState: null, latestTurnStatus: 'completed' }),
            waitingSession({ id: 'lead', agentState: null, latestTurnStatus: 'completed', managedSessions: { total: 1, working: 1, needsYou: 0, stalled: 0, finished: 0, attentionPrimary: null } }),
            waitingSession({ id: 'offline', agentState: null, active: false, activeAt: 1, presence: 1, latestTurnStatus: 'completed' }),
        ]);
        const mounted = mountSurface();

        await expect(mounted.api.readSession('working')).resolves.toMatchObject({
            workStatus: { state: 'thinking', bucket: 'working', tone: 'neutral', attentionType: null, word: expect.any(String) },
        });
        await expect(mounted.api.readSession('finished')).resolves.toMatchObject({
            workStatus: { state: 'ready', bucket: 'finished', tone: 'neutral', attentionType: null },
        });
        await expect(mounted.api.readSession('lead')).resolves.toMatchObject({
            workStatus: { state: 'ready', bucket: 'idle', tone: 'neutral', attentionType: null },
        });
        await expect(mounted.api.readSession('offline')).resolves.toMatchObject({
            workStatus: { state: 'disconnected', bucket: 'offline', tone: 'neutral', attentionType: null },
        });
        mounted.dispose();
    });

    it('projects the catalog Agent identity and never assigns a brand to an unknown Session', async () => {
        const session = waitingSession();
        storage.getState().applySessions([
            waitingSession({ metadata: { ...session.metadata!, flavor: 'codex' } }),
            waitingSession({ id: 'unknown-agent', metadata: null }),
        ]);
        const mounted = mountSurface();
        try {
            await expect(mounted.api.readSession('linked-1')).resolves.toMatchObject({
                agent: { agentId: 'codex', displayName: 'Codex', brand: { pluginId: 'happier.agent.codex' } },
            });
            expect(await mounted.api.readSession('unknown-agent')).not.toHaveProperty('agent');
        } finally {
            mounted.dispose();
        }
    });

    it('resolves a cold installed Agent from its own catalog package, never its backing Agent', async () => {
        const session = waitingSession();
        storage.getState().applySessions([waitingSession({
            metadataLayoutVersion: 1,
            // The store's flattened Metadata type predates its strict shared envelope; fixture the real wire boundary.
            metadata: SessionSharedMetadataV1Schema.parse({
                v: 1, agentPresentation: { agentId: 'acme.agent/fork' },
            }) as unknown as Session['metadata'],
            ownerMetadataView: session.metadata,
        })]);
        mockMachineRpcWithServerScope.mockResolvedValue({
            protocolVersion: 1,
            projection: {
                v: 2, generation: 1, installedPackagesById: {},
                agentsById: { 'acme.agent/fork': {
                    id: 'acme.agent/fork', identity: { pluginId: 'acme.agent', localId: 'fork' },
                    title: 'Acme Agent', channel: 'plugin', isBuiltIn: false,
                    catalogAgentId: 'codex', iconAgentId: 'codex', providerOwnedEnvironmentKeys: [],
                } },
                actionsById: {},   resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [],
            },
        });
        const mounted = mountSurface();
        try {
            await expect(mounted.api.readSession('linked-1')).resolves.toMatchObject({
                agent: { agentId: 'acme.agent/fork', displayName: 'Acme Agent', brand: { pluginId: 'acme.agent' } },
            });
        } finally {
            mounted.dispose();
        }
    });

    it('watches the linked machine catalog and releases its old machine on relocation and disposal', async () => {
        const session = waitingSession();
        storage.getState().applySessions([session]);
        const mounted = mountSurface();
        const events: ResourceSubscriptionEvent[] = [];
        const watch = await mounted.api.watchSession('linked-1', (event) => { events.push(event); });
        const invalidate = (machineId: string) => publishMachineContributionRegistryProjectionInvalidation({
            machineId, serverId: CURRENT_ACCOUNT_LIFETIME.scope.serverId,
        });
        invalidate('machine-1');
        await vi.waitFor(() => expect(events).toHaveLength(1));
        storage.getState().applySessions([waitingSession({ metadata: { ...session.metadata!, machineId: 'machine-2' } })]);
        await vi.waitFor(() => expect(events).toHaveLength(2));
        events.length = 0;
        invalidate('machine-1');
        expect(events).toEqual([]);
        invalidate('machine-2');
        await vi.waitFor(() => expect(events).toHaveLength(1));
        watch.dispose();
        events.length = 0;
        invalidate('machine-2');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(events).toEqual([]);
        mounted.dispose();
    });

    it('answers through the Session permission decision owner, attributed to the viewer', async () => {
        const serverId = await homes.addHome({ name: 'Plugin approval Home', serverUrl: 'https://plugin-approval.test', accountId: 'account-a' });
        installSessionActionFixture({ homes, storage, serverId, session: waitingSession() });
        const mounted = mountSurface({ serverId, accountId: 'account-a' });

        await expect(mounted.api.respondToSessionPermission({
            sessionId: 'linked-1',
            requestId: 'req-1',
            answer: 'allowForSession',
        })).resolves.toEqual({ status: 'answered' });

        const call = mockSessionRpcWithPreferredSessionScope.mock.calls.at(-1)?.[0] as
            Readonly<{ sessionId: string; method: string; payload: Record<string, unknown> }>;
        expect(call.sessionId).toBe('linked-1');
        expect(call).toMatchObject({ serverId });
        expect(call.method).toBe('session.permission.respond');
        expect(call.payload).toMatchObject({
            id: 'req-1',
            turnId: 'turn-1',
            approved: true,
            allowedTools: ['Bash'],
        });
        mounted.dispose();
    });

    it.each(['claude', 'codex'])('keeps native once-only Bash answers shared with Companion for %s', async flavor => {
        const session = waitingSession();
        storage.getState().applySessions([waitingSession({ metadata: { ...session.metadata!, flavor },
            agentState: { requests: { 'req-1': { tool: 'Bash', arguments: { command: 'pwd' },
                createdAt: NOW, turnId: 'native-turn', source: 'native_tool_approval_once' } } } })]);
        const mounted = mountSurface();
        try {
            const state = await mounted.api.readSession('linked-1');
            expect(state?.pendingPermissions[0]?.answers).toEqual(['allowOnce', 'deny']);
            const loaded = storage.getState().sessions['linked-1']!;
            const { messages } = reducer(createReducer(), [], AgentStateSchema.parse(loaded.agentState));
            const transcriptOnly = { ...loaded, agentState: null };
            const pending = listPendingRequestListsFromSession(transcriptOnly, messages);
            const shared = listSessionPendingPermissions(transcriptOnly, CURRENT_ACCOUNT_LIFETIME.scope, pending.permissionRequests);
            const companion = projectSessionSummaryCard({ awareness: projectUiSessionAwareness(loaded, NOW),
                agentLabel: null, activity: null, openApprovalCount: 0, scm: null, usage: null, pendingPermissions: shared });
            expect(companion.needsYou?.request).toMatchObject({ requestId: 'req-1', turnId: 'native-turn',
                source: 'native_tool_approval_once', answers: state?.pendingPermissions[0]?.answers });
            await expect(mounted.api.respondToSessionPermission({ sessionId: 'linked-1', requestId: 'req-1', answer: 'allowForSession' }))
                .resolves.toEqual({ status: 'refused', reason: 'answerUnavailable' });
            expect(mockSessionRpcWithPreferredSessionScope).not.toHaveBeenCalled();
        } finally { mounted.dispose(); }
    });

    it('refuses a Session the Account cannot reach, a request that is not pending, and an answer the viewer may not give', async () => {
        const serverId = await homes.addHome({ name: 'Missing linked Session', serverUrl: 'https://missing-linked-session.test', accountId: 'account-a' });
        storage.getState().applySessions([
            waitingSession({ serverId }),
            waitingSession({ serverId, id: 'view-only', canApprovePermissions: false, accessLevel: 'view' }),
        ]);
        const mounted = mountSurface({ serverId, accountId: 'account-a' });

        await expect(mounted.api.readSession('unknown-session')).resolves.toBeNull();
        await expect(mounted.api.respondToSessionPermission({
            sessionId: 'unknown-session',
            requestId: 'req-1',
            answer: 'allowOnce',
        })).resolves.toEqual({ status: 'refused', reason: 'sessionUnavailable' });
        await expect(mounted.api.respondToSessionPermission({
            sessionId: 'linked-1',
            requestId: 'req-gone',
            answer: 'allowOnce',
        })).resolves.toEqual({ status: 'refused', reason: 'requestNotPending' });

        const viewOnly = await mounted.api.readSession('view-only');
        expect(viewOnly?.pendingPermissions[0]?.answers).toEqual([]);
        await expect(mounted.api.respondToSessionPermission({
            sessionId: 'view-only',
            requestId: 'req-1',
            answer: 'allowOnce',
        })).resolves.toEqual({ status: 'refused', reason: 'answerUnavailable' });

        expect(mockSessionRpcWithPreferredSessionScope).not.toHaveBeenCalled();
        mounted.dispose();
    });

    it('signals a watcher when the Session state changes, and stops after disposal', async () => {
        storage.getState().applySessions([waitingSession()]);
        const mounted = mountSurface();
        const events: ResourceSubscriptionEvent[] = [];

        const subscription = await mounted.api.watchSession('linked-1', (event) => { events.push(event); });
        // An unrelated Session changing is not this watch's news.
        storage.getState().applySessions([waitingSession({ id: 'other', agentState: null })]);
        expect(events).toHaveLength(0);

        storage.getState().applySessions([waitingSession({ agentState: null, updatedAt: NOW + 2 })]);
        await vi.waitFor(() => expect(events).toHaveLength(1));
        expect(events[0]).toMatchObject({ kind: 'invalidated' });
        await expect(mounted.api.readSession('linked-1')).resolves.toMatchObject({ pendingPermissions: [] });

        subscription.dispose();
        storage.getState().applySessions([waitingSession({ updatedAt: NOW + 3 })]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(events).toHaveLength(1);
        mounted.dispose();
    });

    it('invalidates when outstanding reports change the Work presentation without changing awareness', async () => {
        storage.getState().applySessions([waitingSession({
            agentState: null, latestTurnStatus: 'completed',
            managedSessions: { total: 1, working: 1, needsYou: 0, stalled: 0, finished: 0, attentionPrimary: null },
        })]);
        const mounted = mountSurface();
        const events: ResourceSubscriptionEvent[] = [];
        const subscription = await mounted.api.watchSession('linked-1', (event) => { events.push(event); });

        storage.getState().applySessions([waitingSession({
            agentState: null, latestTurnStatus: 'completed', updatedAt: NOW + 2,
            managedSessions: { total: 1, working: 0, needsYou: 0, stalled: 0, finished: 0, attentionPrimary: null },
        })]);

        await vi.waitFor(() => expect(events).toHaveLength(1));
        await expect(mounted.api.readSession('linked-1')).resolves.toMatchObject({
            operational: 'ready', workStatus: { bucket: 'finished', tone: 'neutral' },
        });
        subscription.dispose();
        mounted.dispose();
    });

    it('refuses to watch a Session the Account cannot reach', async () => {
        const serverId = await homes.addHome({ name: 'Missing watched Session', serverUrl: 'https://missing-watched-session.test', accountId: 'account-a' });
        const mounted = mountSurface({ serverId, accountId: 'account-a' });
        await expect(mounted.api.watchSession('unknown-session', () => undefined))
            .rejects.toMatchObject({ code: 'unavailable' });
        mounted.dispose();
    });
});
