import type { ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { SessionSharedMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { V2SessionByIdNotFoundSchema } from '@happier-dev/protocol/sessions/control/contract';
import { PluginUiSessionStateV1Schema } from '@happier-dev/protocol/plugins/ui';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { SessionMessageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
import { router } from 'expo-router';
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
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { listPendingRequestListsFromSession } = await import('@/sync/domains/session/pending/listPendingSessionRequests');
const { listSessionPendingPermissions } = await import('@/sync/ops/sessionPendingPermissions');
const { projectSessionSummaryCard } = await import('@/components/sessions/companion/summary/sessionSummaryProjection');
const { projectUiSessionAwareness } = await import('@/sync/domains/session/awareness/sessionAwareness');
const { createCanonicalPluginReactNativeHostApiAdapter } = await import('@/components/plugins/reactNative/hostApi');
const { createPluginSurfaceContextFixture } = await import('@/dev/testkit/fixtures/pluginSurfaceContextFixture');
const { createSessionAccessFixture, createSessionFixture, createSessionViewerFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { storage } = await import('@/sync/domains/state/storage');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
import type { Session } from '@/sync/domains/state/storageTypes';
const { buildSessionListRenderableFromSession, deriveSessionListRenderableHasUnreadMessagesFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
import { UNSUPPORTED_AGENT_SESSION_CAPABILITIES } from '@happier-dev/agents';

const { createBoundPluginSurfaceController } = await import('./boundPluginSurfaceController');

const initialStorageState = storage.getState();

function applyRevealHome(serverId: string, serverUrl = 'https://input.test') {
    const previous = getAppliedActiveServerSnapshot();
    const available = isAppliedActiveServerRuntimeAvailable();
    // The network boundary has completed an Account connection. Publish the
    // actual connection owner's applied facts; merely selecting a saved Home
    // does not establish active Account authority.
    storage.setState({ profileScope: { serverId, accountId: 'account-a' } });
    publishAppliedActiveServerSnapshot({ serverId, serverUrl, generation: previous.generation + 1 });
    return () => publishAppliedActiveServerSnapshot(previous, available);
}

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
        vi.mocked(router.push).mockClear();
        await homes.reset();
        installHomeGovernanceBoundaries(homes);
        storage.setState(initialStorageState, true);
        mockSessionRpcWithPreferredSessionScope.mockReset();
        mockSessionRpcWithPreferredSessionScope.mockResolvedValue(undefined);
        clearDaemonMergedProjectionCacheForTests();
        mockMachineRpcWithServerScope.mockReset();
    });

    it('reads only an exact visible Machine display from the mounted Account without scanning its inventory', async () => {
        const scope = CURRENT_ACCOUNT_LIFETIME.scope;
        const display: MachineDisplayRenderable = { id: 'same-machine-id', updatedAt: 1, active: false, activeAt: 1,
            metadataVersion: 1, metadata: { displayName: 'Studio', host: 'studio.local' } };
        const displays = new Proxy(Object.fromEntries<MachineDisplayRenderable>([display, ...Array.from({ length: 128 }, (_, index) => ({
            ...display, id: `unrelated-${index}`, metadata: { displayName: `Other ${index}` },
        }))].map(machine => [machine.id, machine])), {
            ownKeys() { throw new Error('Machine display reads must not scan the inventory'); },
        });
        storage.setState({ profileScope: scope, machineDisplayById: displays });
        const mounted = mountSurface();
        try {
            await expect(mounted.api.readMachineDisplayName({ serverId: scope.serverId, machineId: display.id }))
                .resolves.toEqual({ status: 'ready', displayName: 'Studio' });
            await expect(mounted.api.readMachineDisplayName({ serverId: 'other-home', machineId: display.id }))
                .resolves.toEqual({ status: 'unavailable' });
            await expect(mounted.api.readMachineDisplayName({ serverId: scope.serverId, machineId: 'unknown' }))
                .resolves.toEqual({ status: 'unavailable' });
            await expect(mounted.api.readMachineDisplayName({ serverId: scope.serverId, machineId: 'toString' }))
                .resolves.toEqual({ status: 'unavailable' });
            displays[display.id] = { ...display, revokedAt: 1 };
            await expect(mounted.api.readMachineDisplayName({ serverId: scope.serverId, machineId: display.id }))
                .resolves.toEqual({ status: 'unavailable' });
            displays[display.id] = display;
            storage.setState({ profileScope: { ...scope, accountId: 'other-account' } });
            await expect(mounted.api.readMachineDisplayName({ serverId: scope.serverId, machineId: display.id }))
                .resolves.toEqual({ status: 'unavailable' });
            expect(mockMachineRpcWithServerScope).not.toHaveBeenCalled();
        } finally { mounted.dispose(); }
    });

    it('reveals an exact committed input through the mounted host and canonical scoped transcript route without scanning history', async () => {
        const serverId = await homes.addHome({ name: 'Input Home', serverUrl: 'https://input.test', accountId: 'account-a', currentAccount: true });
        const restoreAppliedHome = applyRevealHome(serverId);
        const localId = 'plugin-input/exact:opaque';
        const sessionId = 'session/exact';
        const path = `/v2/sessions/${encodeURIComponent(sessionId)}/messages/by-local-id/${encodeURIComponent(localId)}`;
        homes.answer(serverId, path, { body: { message: SessionMessageV1Schema.parse({
            id: 'committed-input', localId, seq: 21, messageRole: 'user', createdAt: 1,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'PR update' } } },
        }) } });
        const mounted = mountSurface({ serverId, accountId: 'account-a' });
        try {
            await mounted.api.revealSessionInput({ sessionId, localId });
            expect(router.push).toHaveBeenCalledWith(`/session/session%2Fexact/message/server%3Acommitted-input?serverId=${encodeURIComponent(serverId)}`);
            expect(homes.requestsFor(path)).toHaveLength(1);
            expect(homes.requests.filter(request => request.path.includes('/messages') && request.path !== path)).toEqual([]);
        } finally { mounted.dispose(); restoreAppliedHome(); }
    });

    it.each(['wrongLocalId', 'notInput', 'sidechain', 'retired', 'cancelled', 'otherAccount', 'otherHome'] as const)(
        'refuses input reveal without navigation when %s changes before commitment', async fault => {
            const serverId = await homes.addHome({ name: 'Input Home', serverUrl: 'https://input.test', accountId: 'account-a', currentAccount: true });
            const restoreAppliedHome = applyRevealHome(serverId);
            const ready = createDeferred<void>();
            const release = createDeferred<void>();
            homes.answer(serverId, '/v2/sessions/exact-session/messages/by-local-id/exact-input', { select: async () => {
                ready.resolve();
                await release.promise;
                return { body: { message: SessionMessageV1Schema.parse({ id: 'committed', seq: 21,
                    localId: fault === 'wrongLocalId' ? 'other-input' : 'exact-input',
                    messageRole: fault === 'notInput' ? 'agent' : 'user',
                    sidechainId: fault === 'sidechain' ? 'other-run' : null, createdAt: 1,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'PR update' } } },
                }) } };
            } });
            const mounted = mountSurface({ serverId, accountId: 'account-a' });
            const abort = new AbortController();
            try {
                const outcome = mounted.api.revealSessionInput({ sessionId: 'exact-session', localId: 'exact-input' }, { signal: abort.signal });
                const rejected = expect(outcome).rejects.toMatchObject({ code: expect.stringMatching(/unavailable|stale_surface/) });
                await Promise.race([ready.promise, outcome.then(() => { throw new Error('Reveal completed before the exact input read'); })]);
                if (fault === 'retired') mounted.dispose();
                if (fault === 'cancelled') abort.abort();
                if (fault === 'otherAccount') storage.setState({ profileScope: { serverId, accountId: 'different-account' } });
                if (fault === 'otherHome') {
                    const other = await homes.addHome({ name: 'Other Home', serverUrl: 'https://other-input.test', accountId: 'account-a', currentAccount: true });
                    applyRevealHome(other, 'https://other-input.test');
                }
                release.resolve();
                await rejected;
                expect(router.push).not.toHaveBeenCalled();
            } finally { release.resolve(); mounted.dispose(); restoreAppliedHome(); }
        },
    );

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

    it.each([
        [{ sessionCapabilities: { ...UNSUPPORTED_AGENT_SESSION_CAPABILITIES, compaction: { events: true, manual: true } } }, 'supported'],
        [{ sessionCapabilities: UNSUPPORTED_AGENT_SESSION_CAPABILITIES }, 'unsupported'],
        [undefined, 'unknown'],
    ] as const)('exposes manual compact evidence through the public plugin Session reader: %s', async (publication, status) => {
        const base = waitingSession();
        storage.getState().applySessions([{ ...base, metadata: { ...base.metadata!, flavor: 'external/agent',
            runtimeDescriptorV1: { v: 1, agentId: 'external/agent', agent: {} },
            ...(publication ? { agentRuntimeCapabilitiesV1: publication } : {}) } }]);
        const mounted = mountSurface();
        try {
            const state = await mounted.api.readSession('linked-1');
            expect(state).toMatchObject({ compaction: { status } });
            expect(PluginUiSessionStateV1Schema.parse(state).compaction).toEqual(state?.compaction);
        } finally { mounted.dispose(); }
    });

    it('keeps unavailable owner capability evidence unknown despite compact-capable presentation', async () => {
        const base = waitingSession();
        storage.getState().applySessions([{ ...base, ownerMetadataView: null,
            metadata: { ...base.metadata!, flavor: 'codex' } }]);
        const mounted = mountSurface();
        try {
            expect(await mounted.api.readSession(base.id)).toMatchObject({ compaction: { status: 'unknown' } });
        } finally { mounted.dispose(); }
    });

    it('reads what a waiting Session wants to run, where, and which answers the viewer may give', async () => {
        storage.getState().applySessions([waitingSession({ viewer: createSessionViewerFixture({
            attention: { needsAttention: true, reasons: ['permission_required'], primary: 'permission_required', presentation: 'full' },
        }) })]);
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
        expect(PluginUiSessionStateV1Schema.parse(state).workStatus).toEqual(state?.workStatus);
        mounted.dispose();
    });

    it('tracks the list title from the real transcript producer and later saved title', async () => {
        const serverId = await homes.addHome({ name: 'Session titles', serverUrl: 'https://session-titles.test', accountId: 'account-a', currentAccount: true });
        const restoreHome = applyRevealHome(serverId);
        const session = waitingSession({ serverId, agentState: null });
        storage.getState().applySessions([session]);
        const mounted = mountSurface({ serverId, accountId: 'account-a' });
        const events: ResourceSubscriptionEvent[] = [];
        const subscription = await mounted.api.watchSession(session.id, (event) => { events.push(event); });
        try {
            await expect(mounted.api.readSession(session.id)).resolves.toMatchObject({ title: 'repo' });
            storage.getState().applyMessages(session.id, [{
                id: 'first-prompt', role: 'user', localId: null, createdAt: 1, seq: 2, isSidechain: false,
                content: { type: 'text', text: 'Investigate the mobile panel' },
            }]);
            await vi.waitFor(() => expect(events).toHaveLength(1));
            await expect(mounted.api.readSession(session.id)).resolves.toMatchObject({ title: 'Investigate the mobile panel' });
            const { getSessionName } = await import('@/utils/sessions/sessionUtils');
            const row = storage.getState().sessionListRowsByServerId[serverId]![session.id]!;
            expect(getSessionName(row, serverId)).toBe('Investigate the mobile panel');
            storage.getState().applySessions([{ ...session, metadataVersion: session.metadataVersion + 1,
                metadata: { ...session.metadata!, summary: { text: 'Saved investigation', updatedAt: 2 } } }]);
            await expect(mounted.api.readSession(session.id)).resolves.toMatchObject({ title: 'Saved investigation' });
        } finally { subscription.dispose(); mounted.dispose(); restoreHome(); }
    });

    it('keeps missing credential readiness distinct from terminal Session absence', async () => {
        const serverId = await homes.addHome({ name: 'Credentials pending', serverUrl: 'https://credentials-pending.test', accountId: null });
        const mounted = mountSurface({ serverId, accountId: 'account-a' });
        try {
            await expect(mounted.api.readSession('credential-pending-session')).rejects.toMatchObject({ code: 'unavailable', retryable: true });
            expect(homes.requests.filter(request => request.path.startsWith('/v2/sessions/'))).toEqual([]);
        } finally { mounted.dispose(); }
    });

    it.each([404, 403, 503] as const)('distinguishes terminal missing Sessions from a retryable HTTP %s hydration failure', async (status) => {
        const serverId = await homes.addHome({ name: 'Missing linked Session', serverUrl: 'https://missing-linked-session.test', accountId: 'account-a' });
        const sessionId = `missing-linked-${status}`;
        const body = status === 404 ? V2SessionByIdNotFoundSchema.parse({ error: 'Session not found' })
            : { error: status === 503 ? 'server_unavailable' : 'forbidden' };
        homes.answer(serverId, `/v2/sessions/${sessionId}`, { status, body });
        homes.answer(serverId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, { status, body });
        if (status === 404) storage.getState().applySessions([waitingSession({ id: sessionId, serverId: 'other-home' })]);
        const mounted = mountSurface({ serverId, accountId: 'account-a' });
        try {
            if (status === 503) await expect(mounted.api.readSession(sessionId)).rejects.toMatchObject({ code: 'http_error', retryable: true });
            else await expect(mounted.api.readSession(sessionId)).resolves.toBeNull();
            if (status === 404) expect(storage.getState().sessions[sessionId]?.serverId).toBe('other-home');
            else expect(storage.getState().sessions[sessionId]).toBeUndefined();
        } finally { mounted.dispose(); }
    });

    it('keeps concurrent reads and watches pending until exact-Account hydration, then follows pushed changes', async () => {
        const serverId = await homes.addHome({ name: 'Cold linked Session', serverUrl: 'https://cold-linked-session.test', accountId: 'account-a' });
        const held = createDeferred<void>();
        installSessionActionFixture({
            homes: { ...homes, answer(serverId, path, answer) { homes.answer(serverId, path, { ...answer, respondAfter: held.promise }); } },
            storage, serverId, session: waitingSession({ id: 'cold-linked', metadata: {
                ...waitingSession().metadata!,
                name: 'Verdant Supply',
            } }),
        });
        storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
        const mounted = mountSurface({ serverId, accountId: 'account-a' });
        const events: ResourceSubscriptionEvent[] = [];
        let readSettled = false;
        let watchSettled = false;
        const read = mounted.api.readSession('cold-linked').finally(() => { readSettled = true; });
        const watch = mounted.api.watchSession('cold-linked', event => events.push(event))
            .finally(() => { watchSettled = true; });
        // Observe rejection immediately too: a refused watch must fail this test, not become an unhandled rejection.
        const outcomes = Promise.all([read, watch]);
        void outcomes.catch(() => undefined);
        try {
            await vi.waitFor(() => expect(homes.requests.some(request => request.path.startsWith('/v2/sessions/cold-linked'))).toBe(true));
            expect({ readSettled, watchSettled }).toEqual({ readSettled: false, watchSettled: false });
            expect(storage.getState().sessions['cold-linked']).toBeUndefined();
            expect(events).toEqual([]);
            expect(homes.requests.filter(request => new URL(request.path, request.serverUrl).pathname === '/v2/sessions/cold-linked')).toHaveLength(1);
            held.resolve();
            const [state, subscription] = await outcomes;
            expect(state).toMatchObject({ sessionId: 'cold-linked', serverId, title: 'Verdant Supply' });

            storage.getState().applySessions([waitingSession({ id: 'unrelated', serverId })]);
            expect(events).toEqual([]);
            const session = storage.getState().sessions['cold-linked']!;
            const ownerField = session.metadataLayoutVersion === 1 ? 'ownerMetadataView' : 'metadata';
            storage.getState().applySessions([{ ...session, [ownerField]: {
                ...session[ownerField]!, name: 'Renamed Verdant Supply',
            } }]);
            expect(events).toMatchObject([{ kind: 'invalidated' }]);
            await expect(mounted.api.readSession('cold-linked')).resolves.toMatchObject({ title: 'Renamed Verdant Supply' });
            subscription.dispose();
            storage.getState().applySessions([{ ...session, [ownerField]: {
                ...session[ownerField]!, name: 'After disposal',
            } }]);
            expect(events).toHaveLength(1);
        } finally {
            held.resolve();
            mounted.dispose();
            await outcomes.catch(() => undefined);
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
            waitingSession({ id: 'lead', agentState: null, latestTurnStatus: 'completed', managedSessions: {
                total: 1, finished: 0, attentionPrimary: null, working: 1, needsYou: 0, stalled: 0,
            } }),
            // Presence describes reachability; a completed turn remains settled after detachment.
            waitingSession({ id: 'finished-offline', agentState: null, active: false, activeAt: 1, presence: 1, latestTurnStatus: 'completed' }),
            waitingSession({ id: 'offline', agentState: null, active: false, activeAt: 1, presence: 1, latestTurnStatus: null }),
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
        await expect(mounted.api.readSession('finished-offline')).resolves.toMatchObject({
            runtime: 'offline',
            workStatus: { state: 'ready', bucket: 'finished', tone: 'neutral', attentionType: null },
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
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            });
            expect(await mounted.api.readSession('unknown-agent')).not.toHaveProperty('agent');
            expect(await mounted.api.readSession('unknown-agent')).not.toHaveProperty('agentTarget');
        } finally {
            mounted.dispose();
        }
    });

    it('reads an exact configured Agent definition from admitted creation metadata', async () => {
        const agentTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-a' } as const;
        const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1,
            sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'agent-target-read' }),
            recipe: { execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/work/repo' } },
                organization: { folderId: null, tagIds: [] }, agentTarget, modelSelection: null, profileId: null,
                requestedPermissionMode: null, agentModeId: null, configuration: null, connectedServices: null,
                capabilitySelection: null, transcriptStorage: null, terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null,
            } });
        const base = waitingSession();
        storage.getState().applySessions([waitingSession({ metadataLayoutVersion: 1,
            metadata: SessionSharedMetadataV1Schema.parse({ v: 1, agentPresentation: { agentId: 'custom-acp' } }) as unknown as Session['metadata'],
            ownerMetadataView: { ...base.metadata!, flavor: 'custom-acp', sessionCreationCorrespondenceV1: correspondence },
        })]);
        const mounted = mountSurface();
        try {
            await expect(mounted.api.readSession(base.id)).resolves.toMatchObject({ agentTarget });
            storage.getState().applySessions([waitingSession({ metadataLayoutVersion: 1,
                metadata: SessionSharedMetadataV1Schema.parse({ v: 1, agentPresentation: { agentId: 'custom-acp' } }) as unknown as Session['metadata'],
                ownerMetadataView: null,
            })]);
            expect(await mounted.api.readSession(base.id)).not.toHaveProperty('agentTarget');
        } finally { mounted.dispose(); }
    });

    it.each(['accepted', 'ambiguous', 'private', 'incomplete', 'wrongHome', 'wrongAccount'] as const)('exposes %s accepted checkout facts through the existing census owner', async (scenario) => {
        const scope = CURRENT_ACCOUNT_LIFETIME.scope;
        const censusScope = scenario === 'wrongAccount' ? { ...scope, accountId: 'other-account' } : scope;
        const repository = { kind: 'github', deployment: 'https://github.com', repository: 'example/repo' } as const;
        const checkout = { id: 'checkout', serverId: scope.serverId, machineId: 'machine-1', rootPath: '/work/repo',
            createdAtMs: 1, repositoryIdentity: repository };
        const priorProfileScope = storage.getState().profileScope;
        storage.setState({ profileScope: censusScope });
        storage.getState().activateProjectAccountRowsScope(censusScope);
        storage.getState().applyProjectAccountRowsForScope(censusScope, { scope: censusScope, status: 'ready',
            coverage: scenario === 'incomplete' ? 'partial' : 'complete',
            workspaceRefs: scenario === 'ambiguous' ? [checkout, { ...checkout, id: 'other-checkout' }]
                : [{ ...checkout, ...(scenario === 'wrongHome' ? { serverId: 'different-home' } : {}) }],
            relationships: [], organizations: [], revisionsByPhysicalKey: {},
        });
        const session = waitingSession({ ownerAccountId: scenario === 'private' ? 'someone-else' : scope.accountId,
            ...(scenario === 'private' ? { access: createSessionAccessFixture('view') } : {}) });
        storage.getState().applySessions([session]);
        const mounted = mountSurface();
        try {
            const state = await mounted.api.readSession(session.id);
            if (scenario === 'accepted') {
                expect(state).toMatchObject({ acceptedWorkspace: { checkout: { serverId: scope.serverId, workspaceId: checkout.id,
                    machineId: checkout.machineId, rootPath: checkout.rootPath }, repository } });
                const events: ResourceSubscriptionEvent[] = [];
                const subscription = await mounted.api.watchSession(session.id, event => { events.push(event); });
                storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
                    workspaceRefs: [checkout], relationships: [], organizations: [{ key: {
                        kind: 'project-organization', serverId: scope.serverId, projectKey: checkout.id,
                    }, revision: 1, value: { pinned: true } }], revisionsByPhysicalKey: {} });
                expect(events).toHaveLength(0);
                storage.getState().setProjectAccountRowsStatusForScope(scope, 'locked');
                await vi.waitFor(() => expect(events).toHaveLength(1));
                expect(await mounted.api.readSession(session.id)).not.toHaveProperty('acceptedWorkspace');
                subscription.dispose();
            } else expect(state).not.toHaveProperty('acceptedWorkspace');
        } finally { mounted.dispose(); storage.setState({ profileScope: priorProfileScope }); }
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
                actionsById: {}, resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [],
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
        }, 'authority');
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

    it('reads and answers an opaque offered permission through the real plugin UI bridge', async () => {
        const serverId = await homes.addHome({ name: 'Native approval Home', serverUrl: 'https://native-approval.test', accountId: 'account-a' });
        const nativeChoices = { requirementId: 'native-requirement', source: 'native-test', choices: [{
            id: 'grant:opaque', label: 'Grant the workspace', decision: 'approved_for_session' as const,
            scope: 'session' as const, response: { approved: true as const, decision: 'approved_for_session' as const },
        }] };
        installSessionActionFixture({ homes, storage, serverId, session: waitingSession({ agentState: { requests: {
            'req-1': { tool: 'Bash', arguments: { command: 'pwd' }, createdAt: NOW, turnId: 'native-turn', nativeChoices },
        } } }) });
        const mounted = mountSurface({ serverId, accountId: 'account-a' });
        try {
            await expect(mounted.api.readSession('linked-1')).resolves.toMatchObject({ pendingPermissions: [{
                requestId: 'req-1', nativeChoices, answers: [],
            }] });
            await expect(mounted.api.respondToSessionPermission({ sessionId: 'linked-1', requestId: 'req-1',
                nativeChoice: { requirementId: 'native-requirement', choiceId: 'grant:opaque' },
            })).resolves.toEqual({ status: 'answered' });
            expect(mockSessionRpcWithPreferredSessionScope.mock.calls.at(-1)?.[0]).toMatchObject({
                method: 'session.permission.respond', payload: { id: 'req-1', turnId: 'native-turn',
                    nativeChoice: { requirementId: 'native-requirement', choiceId: 'grant:opaque' } },
            });
        } finally { mounted.dispose(); }
    });

    it('reports native application separately from a failed offered catalog follow-up', async () => {
        const serverId = await homes.addHome({ name: 'Native catalog Home', serverUrl: 'https://native-catalog.test', accountId: 'account-a' });
        homes.answer(serverId, 'GET /v1/account/entity-rows/mcp', { body: { status: 'absent', revision: 0 } });
        const followUp = { actionId: 'mcp.servers.tools.set', input: { serverId: 'docs', tools: { write: 'allow' } } };
        const nativeChoices = { requirementId: 'native-requirement', source: 'native-test', choices: [{
            id: 'remember', label: 'Remember', decision: 'approved_for_session' as const, scope: 'session' as const,
            response: { approved: true }, followUp,
        }] };
        installSessionActionFixture({ homes, storage, serverId, session: waitingSession({ agentState: { requests: {
            'req-1': { tool: 'McpTool', arguments: {}, createdAt: NOW, nativeChoices },
        } } }) });
        const mounted = mountSurface({ serverId, accountId: 'account-a' });
        try {
            await expect(mounted.api.respondToSessionPermission({ sessionId: 'linked-1', requestId: 'req-1',
                nativeChoice: { requirementId: 'native-requirement', choiceId: 'remember' },
            })).resolves.toMatchObject({ status: 'answered', followUp, errorCode: expect.any(String) });
            expect(mockSessionRpcWithPreferredSessionScope.mock.calls.filter(([call]) => call.method === 'session.permission.respond')).toHaveLength(1);
        } finally { mounted.dispose(); }
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
        const missing = { status: 404, body: V2SessionByIdNotFoundSchema.parse({ error: 'Session not found' }) };
        homes.answer(serverId, '/v2/sessions/unknown-session', missing);
        homes.answer(serverId, '/v2/sessions/unknown-session?accessProjectionVersion=1', missing);
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
            managedSessions: { total: 1, finished: 0, attentionPrimary: null, working: 1, needsYou: 0, stalled: 0 },
        })]);
        const mounted = mountSurface();
        const events: ResourceSubscriptionEvent[] = [];
        const subscription = await mounted.api.watchSession('linked-1', (event) => { events.push(event); });

        storage.getState().applySessions([waitingSession({
            agentState: null, latestTurnStatus: 'completed', updatedAt: NOW + 2,
            managedSessions: { total: 1, finished: 0, attentionPrimary: null, working: 0, needsYou: 0, stalled: 0 },
        })]);

        await vi.waitFor(() => expect(events).toHaveLength(1));
        await expect(mounted.api.readSession('linked-1')).resolves.toMatchObject({
            operational: 'ready', workStatus: { bucket: 'finished', tone: 'neutral' },
        });
        subscription.dispose();
        mounted.dispose();
    });

    it.each([403, 404])('refuses to watch an inaccessible Session (HTTP %s)', async status => {
        const serverId = await homes.addHome({ name: 'Missing watched Session', serverUrl: 'https://missing-watched-session.test', accountId: 'account-a' });
        const body = status === 404 ? V2SessionByIdNotFoundSchema.parse({ error: 'Session not found' }) : { error: 'forbidden' };
        homes.answer(serverId, '/v2/sessions/unknown-session', { status, body });
        homes.answer(serverId, '/v2/sessions/unknown-session?accessProjectionVersion=1', { status, body });
        const mounted = mountSurface({ serverId, accountId: 'account-a' });
        await expect(mounted.api.watchSession('unknown-session', () => undefined))
            .rejects.toMatchObject({ code: 'unavailable' });
        mounted.dispose();
    });
});
