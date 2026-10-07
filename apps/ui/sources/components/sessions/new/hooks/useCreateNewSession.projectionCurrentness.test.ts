import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderHook } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';
import { createNewSessionPromptStore } from './screenModel/newSessionPromptStore';
import { MACHINE_PLAIN_DATA_KEY_MARKER, PluginProjectionV2Schema, SessionSpawnNewInputV2Schema, type SessionSpawnNewInputV2, type SessionSpawnNewResultV1 } from '@happier-dev/protocol';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { useCreateNewSession } from './useCreateNewSession';
import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';

const identity = { pluginId: 'acme.review', localId: 'provider' } as const;
const agentId = 'acme.review/provider';
const agentTarget = { kind: 'agent', identity } as const;
const spawnTarget = { kind: 'backend', backendId: agentId } as const;
const spawnRequests: SessionSpawnNewInputV2[] = [];
let spawnResult: ReturnType<typeof createDeferred<SessionSpawnNewResultV1>>;
let authoringHttp: ReturnType<typeof createAuthoringMemoryHttpBoundary>;

beforeEach(() => {
    spawnRequests.length = 0;
    spawnResult = createDeferred<SessionSpawnNewResultV1>();
    authoringHttp = createAuthoringMemoryHttpBoundary();
});
installNewSessionScreenModelCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness({
    request: async (url, init) => {
        if (new URL(String(url)).pathname === '/v1/machines/m1') {
            return Response.json({ machine: { id: 'm1', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
        }
        return await authoringHttp.handle(url, init);
    },
    configureSocket: (socket) => {
        socket.connected = true;
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
            if (!payload || typeof payload !== 'object' || !('method' in payload)
                || typeof payload.method !== 'string' || !('params' in payload)) {
                throw new Error('Malformed daemon RPC');
            }
            const method = payload.method.slice(payload.method.indexOf(':') + 1);
            if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: true, result: {
                    protocolVersion: 1,
                    projection: PluginProjectionV2Schema.parse({
                        v: 2, generation: 7, agentsById: {
                            [agentId]: { id: agentId, identity, title: 'Acme Review Provider' },
                        },
                        installedPackagesById: {}, actionsById: {}, toolsById: {}, commandsById: {},
                        resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [],
                    }),
                } };
            }
            if (method === RPC_METHODS.SESSION_SPAWN_NEW) {
                spawnRequests.push(SessionSpawnNewInputV2Schema.parse(payload.params));
                return { ok: true, result: await spawnResult.promise };
            }
            return { ok: false, error: 'RPC method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        });
    },
});

async function readCurrentProjection() {
    const { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    clearDaemonMergedProjectionCacheForTests();
    const inputs = await loadDaemonMergedProjectionInputs({
        machineId: 'm1', serverId: runtime.serverId,
        accountLifetime: captureActiveServerAccountScopeLifetime(),
    });
    expect(inputs?.mergedProviderProjectionById[agentId]?.identity).toEqual(identity);
    return inputs;
}

async function mount(inputs: DaemonMergedProjectionInputs | null, authoringCommitPending = false) {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { useCreateNewSession: owner } = await import('./useCreateNewSession');
    const machine = createMachineFixture({ id: 'm1' });
    storage.getState().applyMachines([machine], true, { sourceServerId: runtime.serverId });
    const params: Parameters<typeof useCreateNewSession>[0] = {
        launchIntentSignature: 'projection-currentness-launch-intent',
        authoringCommitPending,
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: machine.id, selectedPath: '/tmp', selectedMachine: machine,
        setIsCreating: vi.fn(), setIsResumeSupportChecking: vi.fn(),
        settings: storage.getState().settings,
        useProfiles: false, selectedProfileId: null, profileMap: new Map(),
        recentMachinePaths: [],
        agentType: agentId, staticAgentId: null, runtimeCarrierAgentId: agentId,
        backendTarget: agentTarget, spawnBackendTarget: spawnTarget,
        permissionMode: 'default', modelMode: 'default',
        promptStore: createNewSessionPromptStore(''), resumeSessionId: '', agentNewSessionOptions: null,
        machineEnvPresence: { isPreviewEnvSupported: false, isLoading: false, meta: {}, refreshedAt: null, refresh: () => {} },
        secrets: [], secretBindingsByProfileId: {}, selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference: (ref) => ({
            ref, kind: 'personal', status: 'temporarily_unavailable',
            entry: null, secret: null, revision: null, fingerprint: null,
        }),
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: runtime.serverId, allowedTargetServerIds: [runtime.serverId],
        draftScope: { serverId: runtime.serverId, accountId: 'account-a' },
        daemonMergedProjectionInputs: inputs,
    };
    return await renderHook(() => owner(params), { wrapper: runtime.Wrapper });
}

describe('useCreateNewSession (projection currentness admission)', () => {
    it('emits the exact qualified Agent identity of the current projection on the spawn payload', async () => {
        const hook = await mount(await readCurrentProjection());
        let pending: void | Promise<void> = undefined;
        try {
            await act(async () => { pending = hook.getCurrent().handleCreateSession(); });
            await vi.waitFor(() => expect(spawnRequests).toHaveLength(1));
            expect(spawnRequests[0]?.agentTarget).toEqual(agentTarget);
            expect(spawnRequests[0]?.agentTarget.identity).toEqual(identity);
        } finally {
            spawnResult.resolve({ type: 'error', code: 'machine_offline', retryable: true });
            await act(async () => { await pending; });
            await hook.unmount();
        }
    });

    it('does not issue a Session request while an authoring selection commit is pending', async () => {
        const hook = await mount(await readCurrentProjection(), true);
        await act(async () => { await Promise.resolve(hook.getCurrent().handleCreateSession()); });
        expect(spawnRequests).toEqual([]);
    });

    it('fails closed without emitting a spawn payload when the current projection cannot qualify the target', async () => {
        const hook = await mount(null);
        await act(async () => { await Promise.resolve(hook.getCurrent().handleCreateSession()); });
        expect(spawnRequests).toEqual([]);
        expect(hook.getCurrent()).toBeTruthy();
    });
});
