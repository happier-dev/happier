import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import type { ActionOperationDeclarationV1 } from '@happier-dev/protocol';
import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const daemonDescribe = vi.hoisted(() => vi.fn());
const homeIds = vi.hoisted(() => new Map<string, string>());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

// Install the real network boundary before loading Sync once. Per-case module
// reloads repeatedly cold-loaded the complete graph inside the hook deadline
// and detached cached transport factories from their boundary's request log.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
const { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
const { useDaemonMergedProjectionInputs } = await import('./useDaemonMergedProjectionInputs');
const { storage } = await import('@/sync/domains/state/storage');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { createAccountTokenForTests, waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
afterAll(async () => { await network.dispose(); });

function readyResponse(generation: number) {
    return { protocolVersion: 1 as const, projection: { v: 2 as const, generation, familiesById: {} } };
}

function browserActionProjection(operation?: ActionOperationDeclarationV1) {
    const targetId = 'browserTarget:acme.preview:home-b';
    const actionId = 'browserAction:acme.preview:open-preview';
    return PluginProjectionV2Schema.parse({
        v: 2, generation: 7,
        actionsById: { 'acme.preview/open-preview': {
            id: 'open-preview', pluginId: 'acme.preview', occurrenceId: 'home-b-occurrence',
            title: 'Open preview', scopes: ['session'], surfaces: ['ui'],
            execution: { target: 'daemon' }, dangerLevel: 'safe', available: true,
            ...(operation ? { operation } : {}),
        } },
        familiesById: { pluginBrowser: { family: 'pluginBrowser', entriesById: {
            [targetId]: {
                id: targetId, pluginId: 'acme.preview', occurrenceId: 'home-b-occurrence',
                contributionKind: 'browserTarget', contributionId: 'home-b',
                target: { kind: 'externalUrl', targetId, url: 'https://home-b-preview.example.test/' },
                display: { title: 'Home B preview' }, currentUrl: 'https://home-b-preview.example.test/',
                launchMode: 'currentView', profileMode: 'session',
            },
            [actionId]: {
                id: actionId, pluginId: 'acme.preview', occurrenceId: 'home-b-occurrence',
                contributionKind: 'browserAction', contributionId: 'open-preview',
                qualifiedActionId: 'acme.preview/open-preview', targetId,
                placement: 'toolbar', display: { title: 'Open preview' },
            },
        } } },
    });
}

describe('useDaemonMergedProjectionInputs', () => {
    let serverId: string;
    let otherServerId: string;

    beforeEach(async () => {
        network.resetRequests();
        storage.setState(storage.getInitialState(), true);
        daemonDescribe.mockReset();
        daemonDescribe.mockResolvedValue(readyResponse(1));
        // The network fixture publishes plain machine key markers. Admit the
        // same real Account mode before Sync restores its focused connection.
        network.setHttpResponder(async (input) => new URL(String(input)).pathname === '/v1/account/encryption'
            ? Response.json({ mode: 'plain', updatedAt: 1 })
            : null);
        const home = await network.addHome('https://projection-hook.example.test', 'account-a');
        const otherHome = await network.addHome('https://projection-hook-other.example.test', 'account-a');
        serverId = home.id;
        otherServerId = otherHome.id;
        homeIds.clear();
        homeIds.set(home.serverUrl, serverId);
        homeIds.set(otherHome.serverUrl, otherServerId);
        network.setRpcAckResponder(async (request) => {
            if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            }
            return { ok: true, result: await daemonDescribe({ machineId: request.targetId, serverId: homeIds.get(request.serverUrl), method: request.method, payload: request.payload }) };
        });
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        clearDaemonMergedProjectionCacheForTests();
    });
    afterEach(async () => {
        standardCleanup();
        clearDaemonMergedProjectionCacheForTests();
        await disconnectActiveServerConnection();
        await serverScopedRpcSocketPool.stopAll();
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
    });

    async function primeCache(generation: number, failRefresh = false) {
        daemonDescribe.mockResolvedValueOnce(readyResponse(generation));
        const scope = { machineId: 'machine-1', serverId };
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        expect(accountLifetime).not.toBeNull();
        await loadDaemonMergedProjectionCacheEntry({ ...scope, accountLifetime });
        if (failRefresh) {
            daemonDescribe.mockRejectedValueOnce(new Error('Transport unavailable'));
            await loadDaemonMergedProjectionCacheEntry({ ...scope, accountLifetime });
        }
        daemonDescribe.mockClear();
    }
    async function settledHook() {
        const hook = await renderHook(() => useDaemonMergedProjectionInputs({ machineId: 'machine-1', serverId }));
        await flushHookEffects({ cycles: 3, turns: 2 });
        await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('ready'));
        return hook;
    }

    async function writeRealHomeCredentials(homeB: Readonly<{ id: string; serverUrl: string; token: string }>) {
        // Restore the real credential reader: native storage remains the only
        // credential boundary beneath real parsing, binding and mutation.
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockRestore();
        expect(await TokenStorage.setCredentialsForServerUrl('https://projection-hook.example.test', { serverId }, {
            token: createAccountTokenForTests('account-a'),
        })).toBe(true);
        expect(await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, {
            token: homeB.token,
        })).toBe(true);
    }

    it('admits a nonfocused Home Browser projection through that Home’s distinct Account credentials', async () => {
        const homeB = await network.addHome('https://projection-browser-home-b.example.test', 'account-b');
        homeIds.set(homeB.serverUrl, homeB.id);
        await writeRealHomeCredentials(homeB);
        const { storage, useEndpointStatus, useMachineCliDetectionTarget } = await import('@/sync/domains/state/storage');
        const { prepareWarmCacheEncryptionKey } = await import('@/sync/domains/state/warmCacheEncryptionKey');
        const { usePluginUiProjectionCurrentness } = await import('@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness');
        const { parseToken } = await import('@/utils/auth/parseToken');
        const { isMachineOnline } = await import('@/utils/sessions/machineUtils');
        const { resolveServerScopedMachine } = await import('@/sync/store/domains/machines/resolveServerScopedMachine');
        const { readCachedDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const { getMachineContributionRegistryProjectionRevision } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
        await prepareWarmCacheEncryptionKey();
        storage.getState().activateProfileScope({ serverId, accountId: 'account-a' });
        const machine = createMachineFixture({ id: 'shared-machine', active: true, activeAt: 0 });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        storage.getState().applyMachines([machine], true, { sourceServerId: homeB.id });
        await waitForHomeGovernance(() => expect(storage.getState().endpointStatus).toBe('online'));
        const lifetimeA = captureActiveServerAccountScopeLifetime();
        expect(lifetimeA?.scope).toMatchObject({ serverId, accountId: 'account-a' });
        expect(lifetimeA?.isCurrent()).toBe(true);
        const targetId = 'browserTarget:acme.preview:home-b';
        const browserProjection = PluginProjectionV2Schema.parse({
            v: 2,
            generation: 7,
            familiesById: {
                pluginBrowser: {
                    family: 'pluginBrowser',
                    entriesById: {
                        [targetId]: {
                            id: targetId, pluginId: 'acme.preview', occurrenceId: 'home-b-occurrence',
                            contributionKind: 'browserTarget', contributionId: 'home-b',
                            target: { kind: 'externalUrl', targetId, url: 'https://home-b-preview.example.test/' },
                            display: { title: 'Home B preview' },
                            currentUrl: 'https://home-b-preview.example.test/',
                            launchMode: 'currentView', profileMode: 'session',
                        },
                    },
                },
            },
        });
        daemonDescribe.mockImplementation(async (request: Readonly<{ serverId: string }>) => request.serverId === homeB.id
            ? { protocolVersion: 1, projection: browserProjection }
            : readyResponse(7));
        const hook = await renderHook(() => ({
            focused: usePluginUiProjectionCurrentness({ machineId: machine.id, serverId }),
            background: usePluginUiProjectionCurrentness({ machineId: machine.id, serverId: homeB.id }),
            admission: { endpointStatus: useEndpointStatus(), machine: useMachineCliDetectionTarget(machine.id) },
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().focused.phase, JSON.stringify({
            endpointStatus: storage.getState().endpointStatus,
            machinePresent: Boolean(storage.getState().machines[machine.id]),
            machineOnline: Boolean(storage.getState().machines[machine.id]
                && isMachineOnline(storage.getState().machines[machine.id])),
            accountCurrent: lifetimeA?.isCurrent(),
            describeRequests: network.requests.filter((request) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
                .map((request) => ({ serverUrl: request.serverUrl, accountId: request.token ? parseToken(request.token) : null })),
        })).toBe('current'));
        await waitForHomeGovernance(() => {
            const background = hook.getCurrent().background;
            const state = storage.getState();
            const scopedMachine = resolveServerScopedMachine(state, homeB.id, machine.id);
            const cache = readCachedDaemonMergedProjectionCacheEntry({ serverId: homeB.id, machineId: machine.id });
            expect(background, JSON.stringify({
                phase: background.phase,
                endpointStatus: state.endpointStatus,
                admission: hook.getCurrent().admission,
                accountScope: background.accountLifetime?.scope,
                accountCurrent: background.accountLifetime?.isCurrent(),
                scopedMachinePresent: scopedMachine !== null,
                scopedMachineOnline: scopedMachine ? isMachineOnline(scopedMachine) : false,
                focusedMachineOnline: state.machines[machine.id] ? isMachineOnline(state.machines[machine.id]) : false,
                projectionRevision: getMachineContributionRegistryProjectionRevision({ serverId: homeB.id, machineId: machine.id }),
                cacheKind: cache?.kind,
                cacheFailureReason: cache?.kind === 'error' ? cache.reason : undefined,
                homeBCredentialRequests: network.credentialRequests.filter((request) => request.serverUrl === homeB.serverUrl),
                homeBHttpPaths: network.httpRequests.filter((request) => new URL(request.url).origin === homeB.serverUrl)
                    .map((request) => new URL(request.url).pathname),
                describeRequests: network.requests.filter((request) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
                    .map((request) => ({ serverUrl: request.serverUrl, accountId: request.token ? parseToken(request.token) : null })),
            })).toMatchObject({
                phase: 'current', interactionEnabled: true, serverId: homeB.id,
                pluginBrowserProjection: { targetsById: { [targetId]: {
                    occurrenceId: 'home-b-occurrence', currentUrl: 'https://home-b-preview.example.test/',
                } } },
            });
        });
        expect(network.requests.filter((request) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            && request.serverUrl === homeB.serverUrl).map((request) => request.token ? parseToken(request.token) : null))
            .toEqual(['account-b']);
        expect(lifetimeA?.isCurrent()).toBe(true);
        expect(hook.getCurrent().focused.phase).toBe('current');
        const lifetimeB = hook.getCurrent().background.accountLifetime;
        expect(lifetimeB?.scope).toMatchObject({ serverId: homeB.id, accountId: 'account-b' });
        expect(lifetimeB?.isCurrent()).toBe(true);
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await act(async () => { await disconnectActiveServerConnection(); });
        expect(lifetimeA?.isCurrent()).toBe(false);
        expect(lifetimeB?.isCurrent()).toBe(true);
        const retainedMachineB = resolveServerScopedMachine(storage.getState(), homeB.id, machine.id);
        expect(retainedMachineB?.id).toBe(machine.id);
        expect(retainedMachineB && isMachineOnline(retainedMachineB)).toBe(true);
        expect(hook.getCurrent().background, JSON.stringify({
            focusedEndpointStatus: storage.getState().endpointStatus,
            focusedMachinePresent: Boolean(storage.getState().machines[machine.id]),
            backgroundAccountCurrent: lifetimeB?.isCurrent(),
        })).toMatchObject({
            phase: 'current', interactionEnabled: true,
            pluginBrowserProjection: { targetsById: { [targetId]: {
                occurrenceId: 'home-b-occurrence', currentUrl: 'https://home-b-preview.example.test/',
            } } },
        });

        // A Home selection can settle its credential projection before that
        // Home becomes the applied endpoint. Disconnect then publishes the
        // selected Home without changing the already-connecting status or its
        // independent qualified Machine observation.
        const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
        const { getAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        await act(async () => { await setActiveServer({ serverId: homeB.id }); });
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().background).toMatchObject({ phase: 'current', interactionEnabled: true });
            expect(hook.getCurrent().background.accountLifetime?.isCurrent()).toBe(true);
        });
        expect(getAppliedActiveServerSnapshot().serverId).toBe(serverId);
        const settledLifetimeB = hook.getCurrent().background.accountLifetime;
        expect(settledLifetimeB?.scope).toMatchObject({ serverId: homeB.id, accountId: 'account-b' });
        const endpointBeforeHomePublication = storage.getState().endpointStatus;
        expect(endpointBeforeHomePublication).toBe('connecting');
        await act(async () => { await disconnectActiveServerConnection(); });
        expect(getAppliedActiveServerSnapshot().serverId).toBe(homeB.id);
        expect(storage.getState().endpointStatus).toBe(endpointBeforeHomePublication);
        expect(settledLifetimeB?.isCurrent()).toBe(true);
        const focusedMachineB = resolveServerScopedMachine(storage.getState(), homeB.id, machine.id);
        expect(focusedMachineB && isMachineOnline(focusedMachineB)).toBe(true);
        expect(hook.getCurrent().background).toMatchObject({
            phase: 'retainedOffline', interactionEnabled: false, pluginBrowserProjection: null,
        });
    });

    it('admits a nonfocused Home Browser projection from a machine absent from the focused Home inventory', async () => {
        const homeB = await network.addHome('https://projection-browser-machine-b.example.test', 'account-b');
        homeIds.set(homeB.serverUrl, homeB.id);
        await writeRealHomeCredentials(homeB);
        const { storage, useEndpointStatus } = await import('@/sync/domains/state/storage');
        const { prepareWarmCacheEncryptionKey } = await import('@/sync/domains/state/warmCacheEncryptionKey');
        const { usePluginUiProjectionCurrentness } = await import('@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness');
        const { parseToken } = await import('@/utils/auth/parseToken');
        const { isMachineOnline } = await import('@/utils/sessions/machineUtils');
        const { resolveServerScopedMachine } = await import('@/sync/store/domains/machines/resolveServerScopedMachine');
        await prepareWarmCacheEncryptionKey();
        storage.getState().activateProfileScope({ serverId, accountId: 'account-a' });
        const machineA = createMachineFixture({ id: 'focused-machine-a', active: true, activeAt: 0 });
        const machineB = createMachineFixture({ id: 'background-only-machine-b', active: true, activeAt: 0 });
        storage.getState().applyMachines([machineA], true, { sourceServerId: serverId });
        storage.getState().applyMachines([machineB], true, { sourceServerId: homeB.id });
        expect(storage.getState().machines[machineB.id]).toBeUndefined();
        await waitForHomeGovernance(() => expect(storage.getState().endpointStatus).toBe('online'));
        const targetId = 'browserTarget:acme.preview:background-machine';
        const browserProjection = PluginProjectionV2Schema.parse({
            v: 2, generation: 8,
            familiesById: { pluginBrowser: { family: 'pluginBrowser', entriesById: {
                [targetId]: {
                    id: targetId, pluginId: 'acme.preview', occurrenceId: 'background-machine-occurrence',
                    contributionKind: 'browserTarget', contributionId: 'background-machine',
                    target: { kind: 'externalUrl', targetId, url: 'https://background-machine.example.test/' },
                    display: { title: 'Background machine preview' },
                    currentUrl: 'https://background-machine.example.test/',
                    launchMode: 'currentView', profileMode: 'session',
                },
            } } },
        });
        daemonDescribe.mockImplementation(async (request: Readonly<{ serverId: string }>) => request.serverId === homeB.id
            ? { protocolVersion: 1, projection: browserProjection }
            : readyResponse(8));
        const hook = await renderHook(() => ({
            focused: usePluginUiProjectionCurrentness({ machineId: machineA.id, serverId }),
            background: usePluginUiProjectionCurrentness({ machineId: machineB.id, serverId: homeB.id }),
            backgroundAdmissionGate: {
                endpointStatus: useEndpointStatus(),
            },
        }));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().focused.phase).toBe('current'));
            await waitForHomeGovernance(() => expect(hook.getCurrent().background.accountLifetime?.scope)
                .toMatchObject({ serverId: homeB.id, accountId: 'account-b' }));
            expect(hook.getCurrent().background.accountLifetime?.isCurrent()).toBe(true);
            const qualifiedMachineB = resolveServerScopedMachine(storage.getState(), homeB.id, machineB.id);
            expect(qualifiedMachineB?.id).toBe(machineB.id);
            expect(qualifiedMachineB && isMachineOnline(qualifiedMachineB)).toBe(true);
            await waitForHomeGovernance(() => expect({
                ...hook.getCurrent().background,
                publicAdmissionGate: hook.getCurrent().backgroundAdmissionGate,
                describeRequests: network.requests
                    .filter((request) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
                    .map((request) => ({ serverUrl: request.serverUrl, machineId: request.targetId })),
            }).toMatchObject({
                phase: 'current', interactionEnabled: true, machineId: machineB.id, serverId: homeB.id,
                pluginBrowserProjection: { targetsById: { [targetId]: {
                    currentUrl: 'https://background-machine.example.test/',
                } } },
            }));
            expect(network.requests.filter((request) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
                && request.serverUrl === homeB.serverUrl).map((request) => ({
                machineId: request.targetId, accountId: request.token ? parseToken(request.token) : null,
            }))).toEqual([{ machineId: machineB.id, accountId: 'account-b' }]);
            expect(hook.getCurrent().focused.phase).toBe('current');
        } finally {
            await hook.unmount();
        }
    });

    it('presents an operation-bearing Browser action for its borrowed nonfocused Home Account', async () => {
        const homeB = await network.addHome('https://projection-browser-operation-b.example.test', 'account-b');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { executePluginBrowserAction, normalizePluginBrowserProjection } = await import('@/sync/domains/plugins/browser/actions');
        const { createPluginUiProjectedActionResolver, normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
        const { DaemonPluginStructuredMessageActionExecuteRequestSchema } = await import('@happier-dev/protocol/plugins/actions/daemonInvocationV1');
        const { ActionOperationSnapshotV1Schema } = await import('@happier-dev/protocol/actions/operations/v1');
        const { qualifyActionOperationSnapshot } = await import('@/sync/domains/actionOperations/qualifiedActionOperation');
        const { actionOperationPresentationCoordinator } = await import('@/components/inbox/actionOperations/actionOperationPresentationRuntime');
        const { Modal } = await import('@/modal');
        const { randomUUID } = await import('@/platform/randomUUID');
        const { parseToken } = await import('@/utils/auth/parseToken');
        const { storage } = await import('@/sync/domains/state/storage');
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockRestore();
        expect(await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, {
            token: createAccountTokenForTests('account-b'),
        })).toBe(true);
        storage.getState().activateProfileScope({ serverId, accountId: 'account-a' });
        expect(captureActiveServerAccountScopeLifetime()?.scope).toMatchObject({ serverId, accountId: 'account-a' });
        const hook = await renderHook(() => useServerCredentialAccountScopeBinding(homeB.id));
        const presented: unknown[] = [];
        // Modal's provider is the native/web presentation boundary. The real
        // launch coordinator and operation observation remain unmocked.
        const unregisterModal = Modal.registerProvider({
            showModal: (config) => { presented.push(config); return randomUUID(); },
            hideModal: () => {}, hideAllModals: () => {}, updateCustomModalProps: () => {},
        });
        actionOperationPresentationCoordinator.reset();
        try {
            await vi.waitFor(() => expect(hook.getCurrent().binding?.scope.accountId).toBe('account-b'));
            const lifetimeB = hook.getCurrent().binding;
            if (!lifetimeB) throw new Error('Home B credential lifetime was not admitted');
            const raw = browserActionProjection({
                version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' },
            });
            const uiProjection = normalizePluginUiProjection(raw);
            const action = normalizePluginBrowserProjection(raw).actionsById['browserAction:acme.preview:open-preview'];
            const operationObserved = createDeferred<ReturnType<typeof ActionOperationSnapshotV1Schema.parse>>();
            network.setRpcAckResponder(async (request) => {
                if (request.method !== RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                    return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
                }
                const payload = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request.payload);
                const accountId = request.token ? parseToken(request.token) : null;
                if (!accountId || !payload.requestId) throw new Error('Operation issuance lacked Account/request authority');
                // The external daemon boundary allocates its operation identity
                // and echoes the request id actually generated by the real launch.
                operationObserved.resolve(ActionOperationSnapshotV1Schema.parse({
                    version: 1, operationId: randomUUID(), revision: 1,
                    actionId: payload.qualifiedActionId, requestId: payload.requestId,
                    state: 'running', scope: { accountId, machineId: request.targetId, sessionId: payload.sessionId },
                    title: 'Open preview', createdAt: 1, startedAt: 2, cancellation: 'unsupported',
                }));
                return { ok: true, result: { ok: true, result: { preview: 'opened' } } };
            });
            expect(await executePluginBrowserAction({
                action, machineId: 'shared-machine', serverId: homeB.id, accountLifetime: lifetimeB,
                sessionId: 'browser-session', input: {}, pluginUiProjection: uiProjection,
                resolveContributedAction: createPluginUiProjectedActionResolver(uiProjection.actionsById),
            })).toEqual({ ok: true, result: { preview: 'opened' } });
            const observed = await operationObserved.promise;
            expect(observed).toMatchObject({ scope: { accountId: 'account-b' } });
            actionOperationPresentationCoordinator.observe(qualifyActionOperationSnapshot(homeB.id, observed));
            expect(presented).toMatchObject([{ type: 'custom', props: { serverId: homeB.id, operationId: observed.operationId } }]);
            expect(captureActiveServerAccountScopeLifetime()?.scope).toMatchObject({ serverId, accountId: 'account-a' });
        } finally {
            actionOperationPresentationCoordinator.reset();
            unregisterModal();
            await hook.unmount();
            await TokenStorage.removeCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id });
        }
    });

    it('does not issue a Home Browser action after its real credential lifetime retires and preserves an already-issued acknowledgement', async () => {
        const homeB = await network.addHome('https://projection-browser-action-home-b.example.test', 'account-b');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { executePluginBrowserAction, normalizePluginBrowserProjection } = await import('@/sync/domains/plugins/browser/actions');
        const { createPluginUiProjectedActionResolver, normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
        const { parseToken } = await import('@/utils/auth/parseToken');
        const { storage } = await import('@/sync/domains/state/storage');
        // This case needs the real parser, device custody and mutation fanout, not the
        // network harness's shortcut credential getter. Storage uses the canonical OS boundary.
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockRestore();
        const credentialsB = { token: createAccountTokenForTests('account-b') };
        const credentialsC = { token: createAccountTokenForTests('account-c') };
        expect(await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, credentialsB)).toBe(true);
        storage.getState().activateProfileScope({ serverId, accountId: 'account-a' });
        const lifetimeA = captureActiveServerAccountScopeLifetime();
        expect(lifetimeA?.scope).toMatchObject({ serverId, accountId: 'account-a' });
        expect(lifetimeA?.isCurrent()).toBe(true);
        const hook = await renderHook(() => useServerCredentialAccountScopeBinding(homeB.id));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().binding?.scope.accountId).toBe('account-b'));
            const initialLifetimeB = hook.getCurrent().binding;
            if (!initialLifetimeB) throw new Error('Home B credential lifetime was not admitted');
            let lifetimeB = initialLifetimeB;
            const actionId = 'browserAction:acme.preview:open-preview';
            const raw = browserActionProjection();
            const uiProjection = normalizePluginUiProjection(raw);
            const browserAction = normalizePluginBrowserProjection(raw).actionsById[actionId];
            expect(browserAction).toBeDefined();
            const execute = () => executePluginBrowserAction({
                action: browserAction, machineId: 'shared-machine', serverId: homeB.id,
                sessionId: 'browser-session', input: {}, pluginUiProjection: uiProjection,
                accountLifetime: lifetimeB,
                resolveContributedAction: createPluginUiProjectedActionResolver(uiProjection.actionsById),
                isCurrent: lifetimeB.isCurrent,
            });
            network.setRpcAckResponder(async (request) => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE
                ? { ok: true, result: { ok: true, result: { preview: 'opened' } } }
                : { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
            // Establish actual dispatch before probing retirement, so an unrelated transport
            // refusal cannot make an empty issuance record look like correct fencing.
            expect(await execute()).toEqual({ ok: true, result: { preview: 'opened' } });
            expect(network.requests.filter((request) => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)
                .map((request) => request.token ? parseToken(request.token) : null)).toEqual(['account-b']);
            const knownIssued = createDeferred<string | null>();
            const knownAcknowledgement = createDeferred<void>();
            network.setRpcAckResponder(async (request) => {
                if (request.method !== RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                    return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
                }
                knownIssued.resolve(request.token ? parseToken(request.token) : null);
                await knownAcknowledgement.promise;
                return { ok: true, result: { ok: true, result: { preview: 'opened' } } };
            });
            const knownPending = execute();
            try {
                expect(await knownIssued.promise).toBe('account-b');
                await act(async () => {
                    expect(await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, credentialsC)).toBe(true);
                });
                expect(lifetimeB.isCurrent()).toBe(false);
            } finally {
                knownAcknowledgement.resolve(undefined);
            }
            expect(await knownPending).toEqual({ ok: true, result: { preview: 'opened' } });
            await vi.waitFor(() => expect(hook.getCurrent().binding?.scope.accountId).toBe('account-c'));
            // The next invocation is an independent action from a newly admitted
            // B source, not a retry of the physical effect whose ACK was consumed.
            await act(async () => {
                expect(await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, credentialsB)).toBe(true);
            });
            await vi.waitFor(() => expect(hook.getCurrent().binding?.scope.accountId).toBe('account-b'));
            const successorLifetimeB = hook.getCurrent().binding;
            if (!successorLifetimeB) throw new Error('Successor Home B credential lifetime was not admitted');
            lifetimeB = successorLifetimeB;
            const mutationCompleted = createDeferred<void>();
            const issued: Array<Readonly<{ accountId: string | null; sourceCurrent: boolean }>> = [];
            network.setRpcAckResponder(async (request) => {
                if (request.method !== RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                    return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
                }
                issued.push({ accountId: request.token ? parseToken(request.token) : null, sourceCurrent: lifetimeB.isCurrent() });
                // An already-issued known ACK stays authoritative even if credentials retire
                // while that external reply is in flight. No server effect is cancelled here.
                await mutationCompleted.promise;
                return { ok: true, result: { ok: true, result: { preview: 'opened' } } };
            });
            let outcome: Awaited<ReturnType<typeof executePluginBrowserAction>> | undefined;
            await act(async () => {
                const pending = execute();
                try {
                    expect(await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, credentialsC)).toBe(true);
                } finally {
                    mutationCompleted.resolve(undefined);
                }
                outcome = await pending;
            });
            expect(lifetimeB.isCurrent()).toBe(false);
            await vi.waitFor(() => expect(hook.getCurrent().binding?.scope.accountId).toBe('account-c'));
            expect(issued.filter((request) => !request.sourceCurrent)).toEqual([]);
            if (issued.length > 0) {
                expect(issued).toEqual([{ accountId: 'account-b', sourceCurrent: true }]);
                expect(outcome).toEqual({ ok: true, result: { preview: 'opened' } });
            } else {
                expect(outcome).toMatchObject({ ok: false });
            }
            expect(lifetimeA?.isCurrent()).toBe(true);
        } finally {
            await hook.unmount();
            await TokenStorage.removeCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id });
        }
    });

    it('reloads the authoritative projection when plugin mutation invalidates the active machine scope', async () => {
        const hook = await settledHook();
        expect(hook.getCurrent().inputs?.pluginProjectionV2?.generation).toBe(1);
        const reload = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockImplementationOnce(() => reload.promise);
        await act(async () => publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId }));
        expect(hook.getCurrent()).toMatchObject({ phase: 'loading', inputs: { pluginProjectionV2: { generation: 1 } } });
        reload.resolve(readyResponse(2));
        await vi.waitFor(() => expect(hook.getCurrent().inputs?.pluginProjectionV2?.generation).toBe(2));
        expect(daemonDescribe).toHaveBeenCalledTimes(2);
    });
    it('retains the last ready projection as stale metadata when an invalidation refresh fails', async () => {
        const hook = await settledHook();
        daemonDescribe.mockRejectedValueOnce(new Error('Transport unavailable'));
        await act(async () => publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId }));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'error', failureReason: 'error', inputs: { pluginProjectionV2: { generation: 1 } } }));
    });
    it('serves only the cached projection and never asks the machine when loading is off', async () => {
        await primeCache(4);
        const hook = await renderHook(() => useDaemonMergedProjectionInputs({ machineId: 'machine-1', serverId, load: false }));
        await flushHookEffects({ cycles: 3, turns: 2 });
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 4 } } }));
        expect(daemonDescribe).not.toHaveBeenCalled();
    });
    it('restores inert stale metadata from an error cache entry after remount', async () => {
        await primeCache(1, true);
        daemonDescribe.mockRejectedValueOnce(new Error('Transport still unavailable'));
        const hook = await renderHook(() => useDaemonMergedProjectionInputs({ machineId: 'machine-1', serverId }));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'error', inputs: { pluginProjectionV2: { generation: 1 } } }));
    });
    it('revalidates instead of serving a fresh cached failure as authoritative', async () => {
        await primeCache(1, true);
        const phases: string[] = [];
        const hook = await renderHook(() => {
            const state = useDaemonMergedProjectionInputs({ machineId: 'machine-1', serverId });
            phases.push(state.phase);
            return state;
        });
        expect(phases[0]).toBe('loading');
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 1 } } }));
        expect(daemonDescribe).toHaveBeenCalledTimes(1);
    });
    it('does not publish a fresh cached ready entry from the previous revision on first mount', async () => {
        await primeCache(1);
        publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId });
        const pending = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockImplementationOnce(() => pending.promise);
        const hook = await renderHook(() => useDaemonMergedProjectionInputs({ machineId: 'machine-1', serverId }));
        expect(hook.getCurrent().phase).toBe('loading');
        await vi.waitFor(() => expect(daemonDescribe).toHaveBeenCalledTimes(1));
        pending.resolve(readyResponse(2));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 2 } } }));
    });
    it('does not expose the previous machine projection while a newly selected machine loads', async () => {
        const pending = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockImplementation((request: Readonly<{ machineId: string }>) => request.machineId === 'machine-2' ? pending.promise : readyResponse(1));
        const hook = await renderHook((machineId: string) => useDaemonMergedProjectionInputs({ machineId, serverId }), { initialProps: 'machine-1' });
        await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('ready'));
        await hook.rerender('machine-2');
        expect(hook.getCurrent()).toEqual({ phase: 'loading', inputs: null });
        pending.resolve(readyResponse(2));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 2 } } }));
    });
    it('does not expose a projection from another server when the machine id is unchanged', async () => {
        const pending = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockImplementation((request: Readonly<{ serverId: string }>) => request.serverId === otherServerId ? pending.promise : readyResponse(1));
        const hook = await renderHook((selectedServerId: string) => useDaemonMergedProjectionInputs({ machineId: 'machine-1', serverId: selectedServerId }), { initialProps: serverId });
        await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('ready'));
        await hook.rerender(otherServerId);
        expect(hook.getCurrent()).toEqual({ phase: 'loading', inputs: null });
        pending.resolve(readyResponse(2));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 2 } } }));
    });
    it('withdraws retained metadata on a real credential replacement within the same Home', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { parseToken } = await import('@/utils/auth/parseToken');
        // Keep real device custody, token parsing and credential-mutation fanout.
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockRestore();
        const homeUrl = 'https://projection-hook.example.test';
        expect(await TokenStorage.setCredentialsForServerUrl(homeUrl, { serverId }, {
            token: createAccountTokenForTests('account-a'),
        })).toBe(true);
        const replacement = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockResolvedValueOnce(readyResponse(1));
        daemonDescribe.mockImplementation(() => replacement.promise);
        const observedRenders: Array<Readonly<{
            serverId: string | null;
            accountId: string | null;
            projectionGeneration: number | null;
        }>> = [];
        const hook = await renderHook(() => {
            const projection = useDaemonMergedProjectionInputs({
                machineId: 'machine-1', serverId, retainInputsAcrossScopeChange: true,
            });
            const account = useServerCredentialAccountScopeBinding(serverId);
            observedRenders.push({
                serverId: account.binding?.scope.serverId ?? null,
                accountId: account.binding?.scope.accountId ?? null,
                projectionGeneration: projection.inputs?.pluginProjectionV2?.generation ?? null,
            });
            return { projection, account };
        });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().projection).toMatchObject({
                phase: 'ready', inputs: { pluginProjectionV2: { generation: 1 } },
            }));
            const lifetimeA = hook.getCurrent().account.binding;
            expect(lifetimeA?.scope).toMatchObject({ serverId, accountId: 'account-a' });
            expect(lifetimeA?.isCurrent()).toBe(true);
            expect(network.requests.filter((request) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
                .map((request) => request.token ? parseToken(request.token) : null)).toEqual(['account-a']);
            await act(async () => {
                expect(await TokenStorage.setCredentialsForServerUrl(homeUrl, { serverId }, {
                    token: createAccountTokenForTests('account-b'),
                })).toBe(true);
            });
            expect(lifetimeA?.isCurrent()).toBe(false);
            await vi.waitFor(() => expect(hook.getCurrent().account.binding?.scope)
                .toMatchObject({ serverId, accountId: 'account-b' }));
            expect(observedRenders.filter((rendered) => rendered.serverId === serverId
                && rendered.accountId === 'account-b' && rendered.projectionGeneration === 1)).toEqual([]);
            expect(hook.getCurrent().projection.phase).not.toBe('ready');
            expect(hook.getCurrent().projection.inputs).toBeNull();
        } finally {
            replacement.resolve(readyResponse(2));
            await hook.unmount();
        }
    });

    it('retains inert metadata through a superseded Home route while ignoring its late projection', async () => {
        const homeC = await network.addHome('https://projection-hook-third.example.test', 'account-a');
        homeIds.set(homeC.serverUrl, homeC.id);
        const pendingB = createDeferred<ReturnType<typeof readyResponse>>();
        const pendingC = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockImplementation((request: Readonly<{ serverId: string }>) => (
            request.serverId === otherServerId ? pendingB.promise
                : request.serverId === homeC.id ? pendingC.promise
                    : readyResponse(1)
        ));
        const hook = await renderHook(
            (scope: Readonly<{ machineId: string; serverId: string }>) => useDaemonMergedProjectionInputs({
                ...scope, retainInputsAcrossScopeChange: true,
            }),
            { initialProps: { machineId: 'machine-1', serverId } },
        );
        try {
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({
                phase: 'ready', inputs: { pluginProjectionV2: { generation: 1 } },
            }));
            await hook.rerender({ machineId: 'machine-2', serverId: otherServerId });
            await vi.waitFor(() => expect(network.requests.some((request) => (
                request.serverUrl === 'https://projection-hook-other.example.test'
                && request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ))).toBe(true));
            expect(hook.getCurrent()).toMatchObject({
                phase: 'loading', inputs: { pluginProjectionV2: { generation: 1 } },
            });
            await hook.rerender({ machineId: 'machine-3', serverId: homeC.id });
            await vi.waitFor(() => expect(network.requests.some((request) => (
                request.serverUrl === homeC.serverUrl
                && request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ))).toBe(true));
            await act(async () => { pendingB.resolve(readyResponse(2)); });
            await flushHookEffects();
            expect(hook.getCurrent()).toMatchObject({
                phase: 'loading', inputs: { pluginProjectionV2: { generation: 1 } },
            });
            pendingC.resolve(readyResponse(3));
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({
                phase: 'ready', inputs: { pluginProjectionV2: { generation: 3 } },
            }));
        } finally {
            pendingB.resolve(readyResponse(2));
            pendingC.resolve(readyResponse(3));
            await hook.unmount();
        }
    });

    it('can retain inert projection metadata across a route-driven authority change', async () => {
        const pending = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockImplementation((request: Readonly<{ machineId: string }>) => request.machineId === 'machine-2' ? pending.promise : readyResponse(1));
        const hook = await renderHook(
            (scope: Readonly<{ machineId: string; serverId: string }>) => useDaemonMergedProjectionInputs({ ...scope, retainInputsAcrossScopeChange: true }),
            { initialProps: { machineId: 'machine-1', serverId } },
        );
        await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('ready'));
        await hook.rerender({ machineId: 'machine-2', serverId: otherServerId });
        expect(hook.getCurrent()).toMatchObject({ phase: 'loading', inputs: { pluginProjectionV2: { generation: 1 } } });
        pending.resolve(readyResponse(2));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 2 } } }));
    });
});
