import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import type { MachineAgentInventoryItem, PluginProjectionV2 } from '@happier-dev/protocol';
import { FeaturesResponseSchema, PluginProjectionV2Schema } from '@happier-dev/protocol';
import { isMachineAgentReady } from './resolveMachineAgentState';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

// Install physical HTTP/Socket.IO before loading the real scoped-RPC owner.
const network = await installSessionOpsNetworkBoundary();
// This responder supplies daemon ACK bodies; it never replaces internal RPC logic.
const rpc = vi.fn();
const { storage } = await import('@/sync/domains/state/storageStore');
const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
const { EMPTY_MACHINE_AGENTS, machineAgentInventoryStore } = await import('./machineAgentInventoryStore');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { installConnectedAccountDescriptorProjection, retireConnectedAccountDescriptorProjection } = await import('@/sync/domains/connectedServices/connectedServiceRegistry');
const { loadDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
const { refreshMachineAgents, useMachineAgents, useMachineAgentsByMachine } = await import('./useMachineAgents');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');

const item: MachineAgentInventoryItem = { agentId: 'review', title: 'Review', installed: true, version: '1', latestVersion: '1', update: { supported: false, command: null }, signIn: { status: 'signedIn', loginSupport: 'status_only' }, platform: { supported: true }, install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [] };
const emptyProjection: PluginProjectionV2 = { v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {}, familiesById: {}, toolsById: {}, commandsById: {}, resourcesById: {}, settingsById: {}, diagnostics: [] };

beforeEach(() => {
    network.resetRequests();
    network.setHttpResponder(async (input) => new URL(String(input)).pathname === '/v1/account/encryption'
        ? Response.json({ mode: 'plain', updatedAt: 1 }) : null);
    network.setRpcAckResponder(async (request) => ({ ok: true, result: await rpc({
        method: request.method, payload: request.payload,
    }) }));
});
afterEach(async () => {
    standardCleanup();
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    rpc.mockReset();
    storage.setState(storage.getInitialState(), true);
});
afterAll(() => network.dispose());

describe('machine inventory lifecycle boundary', () => {
    it('loads selected Agent readiness and expands the same inventory when the picker opens', async () => {
        const server = await network.addHome('https://selected-agent-inventory.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const machine = createMachineFixture({ id: 'selected-agent-machine', active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: Object.fromEntries(['review', 'other'].map(id => [id, {
            id, title: id, capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        }])) });
        const probed = new Set<string>();
        rpc.mockImplementation(async ({ method, payload }: { method: string; payload?: { requests?: { id: string }[] } }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: Object.fromEntries((payload?.requests ?? []).map(({ id }) => {
                probed.add(id);
                return [id, { ok: true, checkedAt: 12, data: { ...item, agentId: id.slice(4) } }];
            })) };
            return { jobs: [] };
        });
        const initialProps: { agentId?: string } = { agentId: 'review' };
        const hook = await renderHook(({ agentId }: { agentId?: string }) => useMachineAgents({ serverId: server.id, machineId: machine.id, agentId }),
            { initialProps });
        try {
            await vi.waitFor(() => expect(isMachineAgentReady(hook.getCurrent().agents.find(agent => agent.agentId === 'review'))).toBe(true));
            expect(probed).toEqual(new Set(['cli.review']));
            expect(network.requests.filter(({ method }) => method === 'capabilities.detect')).toEqual([
                expect.objectContaining({ serverUrl: server.serverUrl, token: server.token, targetId: machine.id }),
            ]);
            await hook.rerender({});
            await vi.waitFor(() => expect(isMachineAgentReady(hook.getCurrent().agents.find(agent => agent.agentId === 'other'))).toBe(true));
            expect(isMachineAgentReady(hook.getCurrent().agents.find(agent => agent.agentId === 'review'))).toBe(true);
        } finally { await hook.unmount(); }
    });

    it('does not replace current Agent facts with a detect response from an invalidated registry', async () => {
        const server = await network.addHome('https://inventory-inflight.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: 'inflight-machine', active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        const oldDetect = createDeferred<unknown>();
        let detected = false;
        let first = true;
        const answer = (installed: boolean) => ({ protocolVersion: 1, results: { 'cli.review': { ok: true, checkedAt: installed ? 12 : 24, data: { ...item, installed } } } });
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') {
                if (first) { first = false; detected = true; return await oldDetect.promise; }
                return answer(false);
            }
            return { jobs: [] };
        });
        const previous = refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        await vi.waitFor(() => expect(detected).toBe(true));
        publishMachineContributionRegistryProjectionInvalidation({ serverId: server.id, machineId: machine.id });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        expect(machineAgentInventoryStore.read(key)).toMatchObject({ lastCheckedAt: 24, agents: [{ state: 'notInstalled' }] });
        oldDetect.resolve(answer(true));
        await previous;
        expect(machineAgentInventoryStore.read(key)).toMatchObject({ lastCheckedAt: 24, agents: [{ state: 'notInstalled' }] });
    });

    it.each(['detail', 'summary'] as const)('retains ready Agent facts across unrelated daemon publications and refreshes on registry invalidation (%s)', async (mode) => {
        const server = await network.addHome(`https://inventory-freshness-${mode}.example.test`, 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: `freshness-${mode}-machine`, active: true, activeAt: Date.now(), daemonStateVersion: 1 });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        let installed = true;
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: { 'cli.review': { ok: true, checkedAt: 12, data: { ...item, installed } } } };
            return { jobs: [] };
        });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        expect(isMachineAgentReady(machineAgentInventoryStore.read(key).agents[0])).toBe(true);
        const readInventory = mode === 'detail'
            ? () => useMachineAgents({ serverId: server.id, machineId: machine.id })
            : () => useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: true }).get(machine.id) ?? EMPTY_MACHINE_AGENTS;
        const hook = await renderHook(readInventory);
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        const readyAgent = hook.getCurrent().agents[0];
        rpc.mockClear();
        await act(async () => storage.setState({ machineListByServerId: { [server.id]: [{ ...machine, daemonStateVersion: 2 }] } }));
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().agents[0]).toBe(readyAgent);
        expect(rpc.mock.calls.filter(([request]) => request.method === 'capabilities.detect')).toHaveLength(0);
        installed = false;
        await act(async () => publishMachineContributionRegistryProjectionInvalidation({ serverId: server.id, machineId: machine.id }));
        await vi.waitFor(() => expect(hook.getCurrent().agents[0]?.state).toBe('notInstalled'));
        await hook.unmount();
    });

    it('retains descriptors and last-good facts but denies readiness when a projection refresh fails', async () => {
        const server = await network.addHome('https://inventory-projection-failure.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: 'failed-projection-machine', active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Current review descriptor', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        let failed = false;
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) {
                if (failed) throw new Error('transport disconnected');
                return { protocolVersion: 1, projection };
            }
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: { 'cli.review': { ok: true, checkedAt: 12, data: item } } };
            return { jobs: [] };
        });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        failed = true;
        publishMachineContributionRegistryProjectionInvalidation({ serverId: server.id, machineId: machine.id });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        const hook = await renderHook(() => useMachineAgents({ serverId: server.id, machineId: machine.id, load: false }));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'error', lastCheckedAt: 12,
            agents: [{ title: 'Current review descriptor', installed: true, stale: true }] }));
        expect(isMachineAgentReady(hook.getCurrent().agents[0])).toBe(false);
        await hook.unmount();
    });

    it('keeps connected Account authentication current for a passive inventory reader without probing the machine', async () => {
        const server = await network.addHome('https://passive-auth-inventory.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: 'passive-auth-machine', active: true, activeAt: Date.now(), daemonStateVersion: 1 });
        const service = { pluginId: 'acme.review', localId: 'account' };
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope, profile: {
            ...storage.getState().profile,
            connectedAccountsV4: [{ ref: { service, accountId: 'work' }, revisionSemantics: 'revisioned', credentialRevision: 'revision-1',
                status: 'connected', kind: 'oauth', authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null,
                displayName: 'Work account', scopes: [] }],
        } });
        installConnectedAccountDescriptorProjection({ scopeKey: server.id, status: 'ready', conflicts: [], errorReason: null, descriptors: [{
            id: 'account', serviceId: 'account', pluginId: service.pluginId, title: 'Review account', provenance: 'external', sourceKind: 'installed',
            authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', pkce: 'required', outcomeReconciliation: 'providerCheck' }] },
            capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
        }] });
        primeServerFeaturesSnapshot({ serverId: server.id, snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({
            features: {}, capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } },
        }) } });
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', connectedAccounts: [{ purpose: 'primary', service, credentialKinds: ['oauth'] }],
            capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        rpc.mockResolvedValue({ protocolVersion: 1, projection });
        await loadDaemonMergedProjectionInputs({ serverId: server.id, machineId: machine.id,
            accountLifetime });
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        machineAgentInventoryStore.publish(key, { status: 'ready', items: [{ ...item, signIn: { status: 'signedOut', loginSupport: 'login_terminal' } }], lastCheckedAt: 12 });
        rpc.mockClear();
        try {
            const hook = await renderHook(() => useMachineAgents({ serverId: server.id, machineId: machine.id, load: false }));
            await vi.waitFor(() => expect(hook.getCurrent().agents[0]).toMatchObject({ state: 'ready', signIn: {
                status: 'signedIn', via: { kind: 'connected', profileLabel: 'Work account' },
            } }));
            expect(rpc).not.toHaveBeenCalled();
            await act(async () => storage.setState({ profile: { ...storage.getState().profile, connectedAccountsV4: [] } }));
            expect(hook.getCurrent().agents[0]).toMatchObject({ state: 'needsSignIn', signIn: { status: 'signedOut' } });
            await hook.unmount();
        } finally {
            retireConnectedAccountDescriptorProjection(accountLifetime);
            resetServerFeaturesClientForTests();
        }
    });

    it('keeps Account agent defaults available when no administration machine is selected', async () => {
        const { useAgentAdministrationCatalog } = await import('@/components/settings/agents/collection/useAgentAdministrationCatalog');
        const { useAgentCollection } = await import('@/components/settings/agents/collection/AgentCollectionList');
        const hook = await renderHook(() => {
            const catalog = useAgentAdministrationCatalog();
            return { target: catalog.executionTarget, ...useAgentCollection(catalog, '') };
        });

        expect(hook.getCurrent().target).toBeNull();
        expect(hook.getCurrent().detecting).toBe(false);
        expect(rpc).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('accepts an authoritative empty session roster without asking for CLI probes', async () => {
        const server = await network.addHome('https://empty-inventory.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const machine = createMachineFixture({ id: 'empty-roster', active: true, activeAt: Date.now(), daemonStateVersion: 1 });
        storage.setState({ machineListByServerId: { [server.id]: [machine] } });
        rpc.mockResolvedValue({ protocolVersion: 1, projection: emptyProjection });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) } });
        expect(machineAgentInventoryStore.read(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id))).toMatchObject({ status: 'ready', agents: [] });
        expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('marks retained summary facts stale on disconnect and does not probe on mount or reconnect', async () => {
        const server = await network.addHome('https://summary-inventory.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const machine = createMachineFixture({ id: 'summary-machine', active: true, activeAt: Date.now(), daemonStateVersion: 1 });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        machineAgentInventoryStore.publish(key, { status: 'ready', items: [item], lastCheckedAt: 12 });
        const hook = await renderHook(() => useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: false }));
        await vi.waitFor(() => expect(hook.getCurrent().get(machine.id)?.agents[0]?.stale).toBe(false));
        await act(async () => storage.setState({ machineListByServerId: { [server.id]: [{ ...machine, active: false, activeAt: 0 }] } }));
        expect(hook.getCurrent().get(machine.id)).toMatchObject({ status: 'offline', agents: [{ installed: true, stale: true }], lastCheckedAt: 12 });
        await act(async () => storage.setState({ machineListByServerId: { [server.id]: [machine] } }));
        expect(hook.getCurrent().get(machine.id)?.agents[0]?.stale).toBe(true);
        expect(rpc).not.toHaveBeenCalled();
        await hook.unmount();
    });
});
