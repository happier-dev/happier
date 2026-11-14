import { act } from 'react-test-renderer';
import { createElement, Profiler, useLayoutEffect, type ProfilerOnRenderCallback, type PropsWithChildren } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import type { MachineAgentInventoryItem} from '@happier-dev/protocol/capabilities/machineAgentInventory';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { buildConfiguredAcpAgentSelectionV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { FeaturesResponseSchema} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { QualifiedConnectedAccountGroupV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRecordV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { QualifiedConnectedAccountPurposeV1Schema } from '@happier-dev/protocol/connect/connected-account-purposes';
import { buildDeferredDaemonProjectionSections, DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { isMachineAgentReady } from './resolveMachineAgentState';
import { resolveMachineAgentPickerPlacement, resolveMachineAgentStatus } from '@/components/machines/agents/machineAgentPresentation';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import * as serverProfiles from '@/sync/domains/server/serverProfiles';
import { countStoreNotifications } from '@/dev/testkit/performance/counts';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';

// Socket.IO is hoisted to the harness boundary: the static imports above load scoped-RPC consumers,
// and a consumer that binds the real client before the harness installs never reaches the RPC responder.
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/sessionOpsNetworkBoundary')
).createSessionOpsSocketIoClientBoundary(importOriginal));
// Install physical HTTP/Socket.IO before loading the real scoped-RPC owner.
const network = await installSessionOpsNetworkBoundary();
const { resolvePreferredBackendTarget } = await import('@/agents/backendCatalog/resolvePreferredBackendTarget');
const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
const { isAgentSelectableForNewSession } = await import('@/components/sessions/new/modules/newSessionAgentSelection');
// This responder supplies daemon ACK bodies; it never replaces internal RPC logic.
const rpc = vi.fn();
const { storage } = await import('@/sync/domains/state/storageStore');
const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
const { EMPTY_MACHINE_AGENTS, machineAgentInventoryStore } = await import('./machineAgentInventoryStore');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { installConnectedAccountDescriptorProjection, retireConnectedAccountDescriptorProjection } = await import('@/sync/domains/connectedServices/connectedServiceRegistry');
const { loadDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
const { refreshMachineAgents, readMachineAgentsForScope, useMachineAgents, useMachineAgent, useMachineAgentsByMachine, useRefreshMachineAgents, selectMachineAgentUpdateFacts } = await import('./useMachineAgents');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } = await import('@/sync/domains/machines/reachability/machineReachability');
const { applyAcpCatalogSnapshot, getAcpCatalogSnapshot } = await import('@/sync/store/settings/acpCatalogSnapshot');
const { applyConnectedAccountCatalogSnapshot } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');

const item: MachineAgentInventoryItem = { agentId: 'review', title: 'Review', installed: true, version: '1', latestVersion: '1', update: { supported: false, command: null }, signIn: { status: 'signedIn', loginSupport: 'status_only' }, platform: { supported: true }, install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [] };
const emptyProjection: PluginProjectionV2 = { v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {}, familiesById: {}, resourcesById: {}, settingsById: {}, diagnostics: [] };

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
    clearMachineRequestReachabilityForTest();
    storage.setState(storage.getInitialState(), true);
});
afterAll(() => network.dispose());

describe('machine inventory lifecycle boundary', () => {
    it.each(['detail', 'fleet'] as const)('shows machine-published last-known Agents on a cold offline %s without inventing authentication or probing', async surface => {
        const server = await network.addHome(`https://${surface}-offline-published-agents.test`, 'offline-inventory-account');
        const scope = { serverId: server.id, accountId: 'offline-inventory-account' };
        let machine = createMachineFixture({ id: `${surface}-offline-published-agents`, active: false, activeAt: 0 });
        machine = { ...machine, metadata: { ...machine.metadata!, agentInventory: {
            checkedAt: 10, installedAgentIds: ['claude', 'codex', 'custom-acp'],
        } } };
        storage.setState({ profileScope: scope });
        storage.getState().applyMachines([machine], true, { sourceServerId: server.id, sourceAccountId: scope.accountId });
        const hook = await renderHook(surface === 'detail'
            ? () => useMachineAgents({ serverId: server.id, machineId: machine.id, load: false })
            : () => useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: false }).get(machine.id) ?? EMPTY_MACHINE_AGENTS);
        try {
            expect(hook.getCurrent()).toMatchObject({ status: 'offline', agents: [
                { agentId: 'claude', installed: true, state: 'unknown', stale: true, signIn: { status: 'unknown' } },
                { agentId: 'codex', installed: true, state: 'unknown', stale: true, signIn: { status: 'unknown' } },
            ] });
            expect(hook.getCurrent().agents.every(agent => !isMachineAgentReady(agent))).toBe(true);
            const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
            const changed = vi.fn();
            const off = machineAgentInventoryStore.subscribe(key, changed);
            const previous = hook.getCurrent().agents;
            try {
                for (let checkedAt = 11; checkedAt <= 13; checkedAt++) await act(async () => {
                    machine = { ...machine, seq: machine.seq + 1, metadataVersion: machine.metadataVersion + 1,
                        metadata: { ...machine.metadata!, agentInventory: {
                            checkedAt, installedAgentIds: ['claude', 'codex', 'custom-acp'],
                        } } };
                    storage.getState().applyMachines([machine], false, { sourceServerId: server.id, sourceAccountId: scope.accountId });
                });
                await act(async () => machineAgentInventoryStore.publishJobs(key, new Map()));
                expect(hook.getCurrent().agents).toBe(previous);
                expect(changed).not.toHaveBeenCalled();
                await act(async () => {
                    machine = { ...machine, seq: machine.seq + 1, metadataVersion: machine.metadataVersion + 1,
                        metadata: { ...machine.metadata!, agentInventory: { checkedAt: 14, installedAgentIds: ['claude'] } } };
                    storage.getState().applyMachines([machine], false, { sourceServerId: server.id, sourceAccountId: scope.accountId });
                });
                expect(hook.getCurrent().agents.filter(agent => agent.installed).map(agent => agent.agentId)).toEqual(['claude']);
                expect(hook.getCurrent().agents[0]).toBe(previous[0]);
                expect(changed).toHaveBeenCalledTimes(1);
                expect(rpc).not.toHaveBeenCalled();
            } finally { off(); }
        } finally { await hook.unmount(); }
    });

    it.each(['manage', 'use'] as const)('applies install-completion Machine pushes to picker placement without an acquired probe for %s', async role => {
        const { handleUpdateContainer } = await import('@/sync/engine/socket/socket');
        const { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } = await import('@happier-dev/protocol/machines/machineStoredContent');
        const accountId = role === 'manage' ? 'machine-owner' : 'machine-grantee';
        const server = await network.addHome(`https://${role}-install-projection.test`, accountId);
        const scope = { serverId: server.id, accountId };
        const machine = createMachineFixture({ id: `${role}-install-projection`, activeAt: Date.now(), storageMode: 'plain',
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            access: { custodian: { accountId: 'machine-owner', displayName: 'Owner' }, role, resourceMode: 'plain', accessState: 'ready' },
        });
        const metadata = { ...machine.metadata!, agentInventory: { checkedAt: 1, installedAgentIds: [] as string[] } };
        storage.setState({ profileScope: scope });
        storage.getState().applyMachines([{ ...machine, metadata }], true, { sourceServerId: server.id, sourceAccountId: accountId });
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        machineAgentInventoryStore.publish(key, { status: 'ready', lastCheckedAt: 1, items: [{ ...item,
            agentId: 'codex', title: 'Codex', installed: false, signIn: { status: 'signedOut', loginSupport: 'status_only' },
        }] });
        const hook = await renderHook(() => useMachineAgents({ serverId: server.id, machineId: machine.id, load: false }));
        const invalidateMachines = vi.fn();
        const push = async (version: number, installed: boolean) => {
            await act(async () => handleUpdateContainer({
                sourceServerId: server.id, encryption: null, readAccountMode: async () => 'plain',
                updateData: { id: `install-${version}`, seq: version, createdAt: version,
                    body: { t: 'update-machine', machineId: machine.id,
                        ...(version === 2 || version === 6 ? { daemonState: { version, value: encodePlainMachineStoredContent({
                            status: 'running', contributionRegistryProjectionRevision: version,
                        }) } } : {}),
                        metadata: { version, value: encodePlainMachineStoredContent({ ...metadata,
                            agentInventory: { checkedAt: version, installedAgentIds: installed ? ['codex'] : [] } }) } } },
                artifactDataKeys: new Map(), applySessions: () => {}, fetchSessions: () => {}, applyMessages: () => {},
                onSessionVisible: () => {}, isSessionMessagesLoaded: () => false, getSessionMaterializedMaxSeq: () => 0,
                markSessionMaterializedMaxSeq: () => {}, onMessageGapDetected: () => {}, assumeUsers: async () => {},
                applyTodoSocketUpdates: async () => {}, invalidateMachines, invalidateSessions: () => {}, invalidateArtifacts: () => {},
                invalidateFriends: () => {}, invalidateFeed: () => {}, invalidateAutomations: () => {}, invalidateTodos: () => {}, log: { log: () => {} },
            }));
        };
        try {
            expect(resolveMachineAgentPickerPlacement(hook.getCurrent().agents[0] ?? null).group).toBe('notOnMachine');
            rpc.mockClear();
            await push(2, true);
            expect(hook.getCurrent().agents[0]).toMatchObject({ installed: true, signIn: { status: 'signedOut' } });
            expect(resolveMachineAgentPickerPlacement(hook.getCurrent().agents[0] ?? null).group).toBe('onMachine');
            const installedAgent = hook.getCurrent().agents[0];
            for (let version = 3; version <= 5; version++) await push(version, true);
            expect(hook.getCurrent().agents[0]).toBe(installedAgent);
            await push(6, false);
            expect(resolveMachineAgentPickerPlacement(hook.getCurrent().agents[0] ?? null).group).toBe('notOnMachine');
            expect(invalidateMachines).not.toHaveBeenCalled();
            expect(rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it.each(['detail', 'fleet'] as const)('uses shared Machine installation facts with requester sign-in in %s inventory without re-probing on publication', async surface => {
        const server = await network.addHome(`https://${surface}-shared-install.test`, 'use-grantee');
        const scope = { serverId: server.id, accountId: 'use-grantee' };
        let machine = createMachineFixture({ id: `${surface}-shared-machine`, active: true, activeAt: Date.now() });
        machine = { ...machine, metadata: { ...machine.metadata!, agentInventory: { checkedAt: 10, installedAgentIds: ['codex'] } } };
        storage.setState({ profileScope: scope });
        storage.getState().applyMachines([machine], true, { sourceServerId: server.id, sourceAccountId: scope.accountId });
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: { v: 1, definitions: [] } }, true);
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { codex: {
            id: 'codex', title: 'Codex', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        rpc.mockImplementation(async ({ method }: { method: string }) => method.includes('contributionRegistryProjection.describe')
            ? { protocolVersion: 1, projection }
            : method === 'capabilities.detect' ? { protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 12,
                data: { ...item, agentId: 'codex', title: 'Codex', installed: false, version: null,
                    signIn: { status: 'signedOut', loginSupport: 'status_only' } } } } } : { jobs: [] });
        const hook = await renderHook(surface === 'detail'
            ? () => useMachineAgents({ serverId: server.id, machineId: machine.id })
            : () => useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: true }).get(machine.id) ?? EMPTY_MACHINE_AGENTS);
        try {
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', agents: [
                { agentId: 'codex', installed: true, state: 'needsSignIn', signIn: { status: 'signedOut' } },
            ] }));
            const { createMachineAgentInventoryPersistence } = await import('./machineAgentInventoryPersistence');
            const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
            expect(createMachineAgentInventoryPersistence(getPersistenceStorage()).read(scope, machine.id)?.items[0])
                .toMatchObject({ installed: true, signIn: { status: 'signedOut' } });
            const { projectMachineAgentsToCliAvailability } = await import('./machineAgentCliAvailability');
            expect(projectMachineAgentsToCliAvailability({ ...hook.getCurrent(), refresh: async () => {} }).available.codex).toBe(true);
            const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
            const publications = vi.fn();
            const off = machineAgentInventoryStore.subscribe(key, publications);
            rpc.mockClear();
            try {
                for (let wake = 0; wake < 3; wake++) await act(async () => {
                    machine = { ...machine, seq: machine.seq + 1, metadataVersion: machine.metadataVersion + 1,
                        metadata: { ...machine.metadata!, agentInventory: { checkedAt: 20 + wake, installedAgentIds: ['codex'] } } };
                    storage.getState().applyMachines([machine], false, { sourceServerId: server.id, sourceAccountId: scope.accountId });
                });
                expect(publications).not.toHaveBeenCalled();
                await act(async () => {
                    machine = { ...machine, seq: machine.seq + 1, metadataVersion: machine.metadataVersion + 1,
                        metadata: { ...machine.metadata!, agentInventory: { checkedAt: 30, installedAgentIds: [] } } };
                    storage.getState().applyMachines([machine], false, { sourceServerId: server.id, sourceAccountId: scope.accountId });
                });
                await vi.waitFor(() => expect(hook.getCurrent().agents[0]).toMatchObject({ installed: false, state: 'notInstalled' }));
                expect(publications).toHaveBeenCalledTimes(1);
                expect(rpc.mock.calls.filter(([request]) => request.method === 'capabilities.detect')).toHaveLength(0);
            } finally { off(); }
        } finally { await hook.unmount(); }
    });

    it('keeps live New Session agent inventory selectable when persistence exceeds its quota', async () => {
        const server = await network.addHome('https://inventory-quota.test', 'quota-account');
        const scope = { serverId: server.id, accountId: 'quota-account' };
        const machine = createMachineFixture({ id: 'quota-machine', active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: { v: 1, definitions: [] } }, true);
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        rpc.mockImplementation(async ({ method }: { method: string }) => method.includes('contributionRegistryProjection.describe')
            ? { protocolVersion: 1, projection }
            : method === 'capabilities.detect' ? { protocolVersion: 1, results: { 'cli.review': { ok: true,
                checkedAt: 123, data: { ...item, authStatus: { state: 'logged_in', checkedAt: 123 } } } } } : { jobs: [] });
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const persisted = getPersistenceStorage();
        const originalSet = persisted.set.bind(persisted);
        let deniedWrites = 0;
        // The package testkit's MMKV storage adapter is the genuine device-storage boundary.
        const writes = vi.spyOn(persisted, 'set').mockImplementation((key, value) => {
            if (key.includes('machine-agents:v1:')) {
                deniedWrites++;
                throw new DOMException('Device storage is full', 'QuotaExceededError');
            }
            originalSet(key, value);
        });
        const hook = await renderHook(() => useMachineAgents({ serverId: server.id, machineId: machine.id, load: false }));
        try {
            await act(async () => { await expect(hook.getCurrent().refresh()).resolves.toBeUndefined(); });
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', agents: [
                { agentId: 'review', installed: true, state: 'ready', stale: false },
            ] }));
            expect(deniedWrites).toBeGreaterThan(0);
            expect(isAgentSelectableForNewSession({ agentId: 'review', machineAgentsById: { review: hook.getCurrent().agents[0] } })).toBe(true);
        } finally { writes.mockRestore(); await hook.unmount(); }
    });

    it.each(['inventory', 'agent', 'machines'] as const)('reads saved inventory after %s scope admission without hydration publications or remount reads', async (surface) => {
        const server = await network.addHome(`https://${surface}-saved-inventory.test`, 'saved-inventory-account');
        const scope = { serverId: server.id, accountId: 'saved-inventory-account' };
        const machine = createMachineFixture({ id: `${surface}-saved-machine`, active: false, activeAt: 1 });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const { createMachineAgentInventoryPersistence } = await import('./machineAgentInventoryPersistence');
        const persisted = getPersistenceStorage();
        createMachineAgentInventoryPersistence(persisted).write(scope, machine.id, { items: [item], lastCheckedAt: 1 });
        const reads = vi.spyOn(persisted, 'getString');
        const writes = vi.spyOn(persisted, 'set');
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        const identities = new WeakMap<object, number>();
        let nextIdentity = 1;
        const readIdentity = (value: object) => {
            const held = identities.get(value);
            if (held !== undefined) return held;
            const id = nextIdentity++;
            identities.set(value, id);
            return id;
        };
        const publications: Array<Readonly<{ snapshot: number; agents: number; status: string }>> = [];
        const changed = vi.fn(() => {
            const current = machineAgentInventoryStore.read(key);
            publications.push({ snapshot: readIdentity(current), agents: readIdentity(current.agents), status: current.status });
        });
        const off = machineAgentInventoryStore.subscribe(key, changed);
        const storeNotifications = countStoreNotifications(storage);
        const frames: Array<readonly MachineAgentInventoryItem['version'][]> = [];
        const observations: Array<Readonly<{ agents: number; snapshot: number; snapshotAgents: number;
            status: string; store: number; rootPublications: number; inventoryPublications: number }>> = [];
        const commits: Array<Readonly<{ phase: string; frame: number }>> = [];
        const onRender: ProfilerOnRenderCallback = (_id, phase) => { commits.push({ phase, frame: frames.length }); };
        const wrapper = ({ children }: PropsWithChildren) => createElement(Profiler, { id: 'saved-inventory', onRender }, children);
        const target = { serverId: server.id, machineId: machine.id, load: false };
        const useSaved = surface === 'inventory' ? () => useMachineAgents(target).agents
            : surface === 'agent' ? () => { const agent = useMachineAgent({ ...target, agentId: item.agentId }); return agent ? [agent] : []; }
                : () => useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: false }).get(machine.id)!.agents;
        const render = () => renderHook(() => {
            const agents = useSaved();
            const current = machineAgentInventoryStore.read(key);
            observations.push({ agents: readIdentity(agents), snapshot: readIdentity(current), snapshotAgents: readIdentity(current.agents),
                status: current.status, store: readIdentity(storage.getState()), rootPublications: storeNotifications.read().length,
                inventoryPublications: publications.length });
            frames.push(agents.map(agent => agent.version));
            return agents;
        }, { wrapper });
        try {
            const hook = await render();
            // Credential custody begins unbound; the detail projection also settles independently.
            // Neither lifecycle may introduce an empty scoped inventory frame or a hydration publication.
            await vi.waitFor(() => expect(hook.getCurrent().map(agent => agent.version)).toEqual(['1']));
            const firstSavedFrame = frames.findIndex(frame => frame.length > 0);
            const savedObservations = observations.slice(firstSavedFrame);
            const diagnostic = JSON.stringify({ observations, commits, publications, rootChanges: storeNotifications.read() });
            expect(frames.slice(firstSavedFrame).every(frame => frame.length === 1 && frame[0] === '1'), diagnostic).toBe(true);
            expect(new Set(savedObservations.map(observation => observation.snapshot)).size, diagnostic).toBe(1);
            expect(new Set(savedObservations.map(observation => observation.snapshotAgents)).size, diagnostic).toBe(1);
            expect(changed).not.toHaveBeenCalled();
            const inventoryReads = () => reads.mock.calls.filter(([key]) => key.includes('machine-agents:v1:')).length;
            expect(inventoryReads()).toBe(1);
            expect(writes.mock.calls.filter(([key]) => key.includes('machine-agents:v1:'))).toHaveLength(0);
            await hook.unmount();
            const remounted = await render();
            await vi.waitFor(() => expect(remounted.getCurrent().map(agent => agent.version)).toEqual(['1']));
            expect(inventoryReads()).toBe(1);
            await act(async () => { machineAgentInventoryStore.publish(key, { status: 'ready',
                items: [{ ...item, version: '2' }], lastCheckedAt: 2 }); });
            expect(remounted.getCurrent()[0]?.version).toBe('2');
            expect(changed).toHaveBeenCalledTimes(1);
            expect(inventoryReads()).toBe(1);
        } finally { off(); storeNotifications.stop(); reads.mockRestore(); writes.mockRestore(); }
    });

    it('publishes one cold Agent inventory while an unrelated projection section is still pending', async () => {
        const server = await network.addHome(['https:', '', 'cold-section.test'].join('/'), 'cold-section-account');
        const scope = { serverId: server.id, accountId: 'cold-section-account' };
        const machine = createMachineFixture({ id: 'cold-section-machine', active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: { v: 1, definitions: [] } }, true);
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        const deferred = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projectionDigest: 'c'.repeat(64), projection,
        }));
        const actionResponse = createDeferred<void>();
        let actionPending = false;
        let manifests = 0;
        rpc.mockImplementation(async ({ method, payload }: { method: string; payload?: {
            sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] };
        } }) => {
            if (method.includes('contributionRegistryProjection.describe')) {
                if (!payload?.sectionRead) { manifests++; return deferred.manifest; }
                if (payload.sectionRead.digest === deferred.manifest.sections.actionsById) {
                    actionPending = true;
                    await actionResponse.promise;
                }
                // Included indexes are optional ACK coalescing. Keep this
                // unrelated index out of peer ACKs so its own actual read can
                // stay pending while Agent inventory settles independently.
                return deferred.read(payload.sectionRead.digest, payload.sectionRead.offset,
                    payload.sectionRead.includeDigests?.filter(digest => digest !== deferred.manifest.sections.actionsById));
            }
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: {
                'cli.review': { ok: true, checkedAt: 12, data: { ...item, authStatus: { state: 'logged_in', checkedAt: 12 } } },
            } };
            return { jobs: [] };
        });
        const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const unrelated = loadDaemonMergedProjectionInputs({ serverId: server.id, machineId: machine.id,
            accountLifetime, sections: ['actionsById'] });
        await vi.waitFor(() => expect(actionPending).toBe(true));
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        let readyPublications = 0;
        const unsubscribe = machineAgentInventoryStore.subscribe(key, () => {
            if (machineAgentInventoryStore.read(key).status === 'ready') readyPublications++;
        });
        const hook = await renderHook(() => useMachineAgents({ serverId: server.id, machineId: machine.id }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
            const agents = Object.fromEntries(hook.getCurrent().agents.map(agent => [agent.agentId, agent]));
            expect(isAgentSelectableForNewSession({ agentId: 'review', machineAgentsById: agents })).toBe(true);
            // One manifest for each distinct demand; mounted inventory readers
            // share one cold acquisition and publish its readiness only once.
            expect(manifests).toBe(2);
            expect(readyPublications).toBe(1);
            const readyAgent = hook.getCurrent().agents[0];
            await act(async () => { actionResponse.resolve(); await unrelated; });
            expect(hook.getCurrent().agents[0]).toBe(readyAgent);
            expect(readyPublications).toBe(1);
            const { readCachedDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
            expect(readCachedDaemonMergedProjectionCacheEntry({ serverId: server.id, machineId: machine.id,
                sections: ['agentsById', 'actionsById'] })?.kind).toBe('ready');
        } finally {
            actionResponse.resolve();
            await unrelated;
            unsubscribe();
            await hook.unmount();
        }
    });

    it('makes no idle capability detects across presence arrivals and still enriches a demanded Machine agents view', async () => {
        const server = await network.addHome('https://capversion-idle.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const machine = createMachineFixture({ id: 'capversion-idle-machine', active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: { v: 1, definitions: [] } }, true);
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        let latestVersion = '2.0.0';
        rpc.mockImplementation(async ({ method, payload }: { method: string;
            payload?: { requests?: { id: string; params?: { includeLatestVersion?: boolean } }[] } }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: Object.fromEntries((payload?.requests ?? []).map(({ id, params }) => {
                if (id === 'tool.acpAgentInventory') return [id, { ok: true, checkedAt: Date.now(), data: { items: [] } }];
                const { latestVersion: _latestVersion, ...readiness } = item;
                return [id, { ok: true, checkedAt: Date.now(), data: { ...readiness, version: '1.0.0', updateSupported: true,
                    update: { supported: true, command: null }, authStatus: { state: 'logged_in', checkedAt: Date.now() },
                    ...(params?.includeLatestVersion ? { latestVersion } : {}) } }];
            })) };
            return { jobs: [] };
        });
        vi.useFakeTimers();
        const hook = await renderHook(({ open }: { open: boolean }) => useMachineAgents({
            serverId: server.id, machineId: machine.id, load: open,
        }), { initialProps: { open: false } });
        const detects = () => network.requests.filter(request => request.method === 'capabilities.detect').length;
        const idle = async () => {
            for (let beat = 0; beat < 30; beat++) await act(async () => {
                await vi.advanceTimersByTimeAsync(20_000);
                storage.setState({ machineListByServerId: { [server.id]: [{ ...machine, activeAt: Date.now() }] } });
            });
        };
        try {
            await idle();
            expect(detects()).toBe(0);
            await hook.rerender({ open: true });
            await vi.waitFor(() => expect(hook.getCurrent().agents[0]).toMatchObject({
                installed: true, version: '1.0.0', latestVersion: '2.0.0', state: 'updateAvailable',
            }));
            const acquired = detects();
            expect(acquired).toBe(2);
            await idle();
            expect(detects()).toBe(acquired);
            await hook.rerender({ open: false });
            await idle();
            expect(detects()).toBe(acquired);
            latestVersion = '3.0.0';
            await hook.rerender({ open: true });
            // Reopening keeps the last learned vendor fact under the existing
            // freshness policy; an explicit refresh requests the changed fact.
            await vi.waitFor(() => expect(hook.getCurrent().agents[0]?.latestVersion).toBe('2.0.0'));
            await act(async () => { await hook.getCurrent().refresh(); });
            await vi.waitFor(() => expect(hook.getCurrent().agents[0]?.latestVersion).toBe('3.0.0'));
        } finally { await hook.unmount(); vi.useRealTimers(); }
    });

    it.each(['active', 'manual', 'withdrawn'] as const)('keeps capability failure recovery owned by %s inventory demand', async demand => {
        const server = await network.addHome(`https://inventory-error-${demand}.example.test`, 'inventory-retry-account');
        const scope = { serverId: server.id, accountId: 'inventory-retry-account' };
        const machine = createMachineFixture({ id: `inventory-error-${demand}`, active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        let detections = 0;
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') {
                detections++;
                if (detections <= (demand === 'active' ? 1 : 2)) return { error: 'Temporary capability service failure' };
                return { protocolVersion: 1, results: { 'cli.review': { ok: true, checkedAt: Date.now(), data: {
                    ...item, authStatus: { state: 'logged_in', checkedAt: Date.now() },
                } } } };
            }
            return { jobs: [] };
        });
        vi.useFakeTimers();
        const hook = await renderHook(({ load }: { load: boolean }) => useMachineAgents({
            serverId: server.id, machineId: machine.id, agentId: 'review', load,
        }), { initialProps: { load: true } });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().status).toBe('error'));
            expect(detections).toBe(1);
            if (demand !== 'active') {
                await act(async () => { await hook.getCurrent().refresh(); });
                expect(hook.getCurrent().status).toBe('error');
                expect(detections).toBe(2);
            }
            if (demand === 'withdrawn') await hook.rerender({ load: false });
            // Presence remains live while the capability service recovers. These
            // actual store arrivals must not restart the unchanged detection demand.
            for (let beat = 0; beat < 3; beat++) await act(async () => {
                await vi.advanceTimersByTimeAsync(19_000);
                storage.setState({ machineListByServerId: { [server.id]: [{ ...machine, activeAt: Date.now() }] } });
            });
            await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
            if (demand !== 'withdrawn') {
                await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
                expect(detections).toBe(demand === 'active' ? 2 : 3);
            } else {
                expect(hook.getCurrent().status).toBe('error');
                expect(detections).toBe(2);
            }
        } finally { await hook.unmount(); vi.useRealTimers(); }
    });

    it('does not reacquire Home correspondence for unchanged Agent inventory notifications or per Machine on rerender', async () => {
        const server = await network.addHome('https://perf-b3-r4.example.test', 'perf-b3-r4');
        const rows = Array.from({ length: 100 }, (_, index) => createMachineFixture({ id: `perf-b3-${index}`, active: false, activeAt: 0 }));
        storage.setState({ machineListByServerId: { [server.id]: rows }, machineListStatusByServerId: { [server.id]: 'idle' },
            profileScope: { serverId: server.id, accountId: 'perf-b3-r4' } });
        let ids = [rows[0]!.id];
        const hook = await renderHook(() => useMachineAgentsByMachine({ serverId: server.id, machineIds: ids, load: false }));
        await vi.waitFor(() => expect(hook.getCurrent().get(ids[0])?.status).toBe('offline'));
        const resolve = vi.spyOn(serverProfiles, 'resolveServerProfileScopeIdForIdentifier');
        const active = vi.spyOn(serverProfiles, 'getActiveServerSnapshot');
        const capture = vi.spyOn(serverProfiles, 'captureServerProfileScopeResolver');
        try {
            for (let index = 0; index < 3; index++) await hook.rerender();
            const singleReads = { resolve: resolve.mock.calls.length, active: active.mock.calls.length, capture: capture.mock.calls.length };
            ids = rows.map(row => row.id);
            await hook.rerender();
            await vi.waitFor(() => expect(hook.getCurrent().size).toBe(100));
            resolve.mockClear(); active.mockClear(); capture.mockClear();
            for (let index = 0; index < 3; index++) await hook.rerender();
            expect({ resolve: resolve.mock.calls.length, active: active.mock.calls.length, capture: capture.mock.calls.length }).toEqual(singleReads);
            resolve.mockClear(); active.mockClear(); capture.mockClear();
            for (let index = 0; index < 10; index++) await act(async () => {
                storage.setState(state => ({ isDataReady: !state.isDataReady }));
            });
            expect(resolve).not.toHaveBeenCalled();
            expect(active).not.toHaveBeenCalled();
            expect(capture).not.toHaveBeenCalled();
            expect(hook.getCurrent().get(ids[0])?.status).toBe('offline');
            expect(rpc.mock.calls.filter(([request]) => request.method === 'capabilities.detect')).toHaveLength(0);
        } finally { resolve.mockRestore(); active.mockRestore(); capture.mockRestore(); await hook.unmount(); }
    });
    it('projects only the changed Machine for a mounted fleet summary during installation arrivals', async () => {
        const server = await network.addHome('https://fleet-arrival-cost.test', 'fleet-arrival-account');
        const scope = { serverId: server.id, accountId: 'fleet-arrival-account' };
        const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        // Reuse the incumbent 100-Machine owner stress shape above, not a product limit.
        const machines = Array.from({ length: 100 }, (_, index) => {
            const machine = createMachineFixture({ id: `fleet-arrival-${index}`, active: true, activeAt: Date.now() });
            return { ...machine, metadata: { ...machine.metadata!, agentInventory: { checkedAt: 10, installedAgentIds: [] as string[] } } };
        });
        storage.setState({ profileScope: scope });
        const apply = (rows: typeof machines) => storage.getState().applyMachines(rows, false,
            { sourceServerId: server.id, sourceAccountId: scope.accountId });
        apply(machines);
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: { v: 1, definitions: [] } }, true);
        // Real daemon ACKs populate the existing projection cache; the passive summary never probes.
        rpc.mockImplementation(async ({ method }: { method: string }) => method.includes('contributionRegistryProjection.describe')
            ? { protocolVersion: 1, projection: emptyProjection } : { jobs: [] });
        await Promise.all(machines.map(machine => loadDaemonMergedProjectionInputs({ serverId: server.id,
            machineId: machine.id, accountLifetime, sections: ['agentsById', 'familiesById.connectedAccounts'] })));
        const select = vi.fn(selectMachineAgentUpdateFacts);
        const hook = await renderHook(() => useMachineAgentsByMachine({ serverId: server.id,
            machineIds: machines.map(machine => machine.id), load: false }, select));
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        // Call through the genuine device-storage boundary, including unchanged hint writes.
        const writes = vi.spyOn(getPersistenceStorage(), 'set');
        // Instrument logical reads without replacing the canonical inventory owner.
        const reads = vi.spyOn(machineAgentInventoryStore, 'read');
        const changedMachineIds: string[] = [];
        const stops = machines.map(machine => machineAgentInventoryStore.subscribe(
            serverAccountScopedResourceKey(scope, 'machine-agents', machine.id), () => changedMachineIds.push(machine.id)));
        const inventoryWrites = () => writes.mock.calls.filter(([key]) => key.includes('machine-agents:v1:'));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().size).toBe(machines.length));
            expect(machines.every(machine => machineAgentInventoryStore.read(
                serverAccountScopedResourceKey(scope, 'machine-agents', machine.id)).status === 'ready')).toBe(true);
            select.mockClear(); writes.mockClear(); reads.mockClear(); changedMachineIds.length = 0;
            const held = hook.getCurrent();
            const unrelated = createMachineFixture({ id: 'fleet-unobserved', active: true, activeAt: Date.now() });
            await act(async () => storage.getState().applyMachines([unrelated], false,
                { sourceServerId: server.id, sourceAccountId: scope.accountId }));
            await act(async () => apply(machines));
            expect(select).not.toHaveBeenCalled();
            expect(reads).not.toHaveBeenCalled();
            expect(inventoryWrites()).toHaveLength(0);
            expect(changedMachineIds).toEqual([]);
            expect(hook.getCurrent()).toBe(held);

            for (const index of [0, machines.length - 1]) {
                select.mockClear(); writes.mockClear(); reads.mockClear(); changedMachineIds.length = 0;
                const before = hook.getCurrent();
                const previous = machines[index]!;
                const machine = { ...previous, seq: previous.seq + 1, metadataVersion: previous.metadataVersion + 1,
                    metadata: { ...previous.metadata, agentInventory: { checkedAt: 20, installedAgentIds: ['codex'] } } };
                machines[index] = machine;
                await act(async () => apply([machine]));
                expect(hook.getCurrent().get(machine.id)).toMatchObject([{ agentId: 'codex', installed: true, state: 'unknown' }]);
                expect(changedMachineIds).toEqual([machine.id]);
                expect.soft(select.mock.calls).toHaveLength(1);
                expect.soft([...new Set(reads.mock.calls.map(([key]) => key))]).toEqual([
                    serverAccountScopedResourceKey(scope, 'machine-agents', machine.id),
                ]);
                expect.soft(inventoryWrites()).toHaveLength(1);
                expect.soft(inventoryWrites().every(([key]) => key.includes(JSON.stringify(machine.id)))).toBe(true);
                expect([...hook.getCurrent()].filter(([id]) => id !== machine.id).every(([id, rows]) => rows === before.get(id))).toBe(true);
                await act(async () => apply([machine]));
                expect.soft(select.mock.calls).toHaveLength(1);
                expect.soft(inventoryWrites()).toHaveLength(1);
            }
            expect(rpc.mock.calls.some(([request]) => request.method === 'capabilities.detect')).toBe(false);
        } finally { stops.forEach(stop => stop()); reads.mockRestore(); writes.mockRestore(); await hook.unmount(); }
    });

    it('renews fleet membership and selectors while catching an inventory arrival before subscription', async () => {
        const server = await network.addHome('https://fleet-membership.test', 'fleet-membership-account');
        const scope = { serverId: server.id, accountId: 'fleet-membership-account' };
        const machines = ['fleet-member-a', 'fleet-member-b', 'fleet-member-c'].map(id => createMachineFixture({ id, active: false, activeAt: 0 }));
        storage.setState({ profileScope: scope });
        storage.getState().applyMachines(machines, true, { sourceServerId: server.id, sourceAccountId: scope.accountId });
        const key = (id: string) => serverAccountScopedResourceKey(scope, 'machine-agents', id);
        const publish = (id: string, version: number) => machineAgentInventoryStore.publish(key(id), {
            status: 'offline', items: [{ ...item, version: String(version) }], lastCheckedAt: version,
        });
        const first = vi.fn((snapshot: typeof EMPTY_MACHINE_AGENTS, previous: Readonly<{ label: string }> | undefined) => {
            const label = `first:${snapshot.agents[0]?.version}`;
            return previous?.label === label ? previous : { label };
        });
        const second = vi.fn((snapshot: typeof EMPTY_MACHINE_AGENTS, previous: Readonly<{ label: string }> | undefined) => {
            const label = `second:${snapshot.agents[0]?.version}`;
            return previous?.label === label ? previous : { label };
        });
        const hook = await renderHook(({ ids, select, arrival }: { ids: string[]; select: typeof first; arrival: number }) => {
            const summary = useMachineAgentsByMachine({ serverId: server.id, machineIds: ids, load: false }, select);
            // The new membership renders before its passive subscription attaches.
            useLayoutEffect(() => { publish(ids[ids.length - 1]!, arrival); }, [arrival, ids]);
            return summary;
        }, { initialProps: { ids: [machines[0]!.id, machines[1]!.id], select: first, arrival: 1 } });
        try {
            expect(hook.getCurrent().get(machines[1]!.id)).toEqual({ label: 'first:1' });
            const retained = hook.getCurrent().get(machines[1]!.id);
            const ids = [machines[1]!.id, machines[2]!.id];
            await hook.rerender({ ids, select: first, arrival: 2 });
            expect([...hook.getCurrent()]).toEqual([[machines[1]!.id, { label: 'first:1' }], [machines[2]!.id, { label: 'first:2' }]]);
            expect(hook.getCurrent().get(machines[1]!.id)).toBe(retained);
            first.mockClear();
            await act(async () => publish(machines[0]!.id, 3));
            expect(first).not.toHaveBeenCalled();
            await hook.rerender({ ids, select: second, arrival: 2 });
            expect([...hook.getCurrent()]).toEqual([[machines[1]!.id, { label: 'second:1' }], [machines[2]!.id, { label: 'second:2' }]]);
            expect(second.mock.calls[0]?.[1]).toBeUndefined();
        } finally { await hook.unmount(); }
    });

    it('uses acquired Connected Account descriptors without reparsing the raw machine family', async () => {
        const { publishDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters');
        const { useMachineAgentAuthentication } = await import('./useMachineAgentAuthentication');
        const server = await network.addHome('https://descriptor-proof.example.test', 'descriptor-proof');
        const scope = { serverId: server.id, accountId: 'descriptor-proof' };
        const service = { pluginId: 'happier.agent.codex', localId: 'account' };
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection,
            familiesById: { connectedAccounts: { family: 'connectedAccounts', entriesById: { 'happier.agent.codex/account': {
                id: 'account', serviceId: 'account', pluginId: service.pluginId, title: 'Acquired account', provenance: 'external', sourceKind: 'installed',
                authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'providerCheck' }] },
                capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
            } } } },
            agentsById: { codex: { id: 'codex', title: 'Codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                connectedAccounts: [{ purpose: 'primary', service, credentialKinds: ['oauth'] }],
                capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } } },
        });
        const acquired = publishDaemonMergedProjectionInputs({ projection });
        let reads = 0;
        const inputs = { ...acquired, pluginProjectionV2: new Proxy(projection, { get(target, key, receiver) {
            if (key === 'familiesById') reads++;
            return Reflect.get(target, key, receiver);
        } }) };
        storage.setState({ profileScope: scope });
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const hook = await renderHook(() => useMachineAgentAuthentication({ lifetime, serverId: server.id, enabled: false }));
        const read = () => hook.getCurrent()({ phase: 'ready', inputs });
        expect(read().connectedServicesByAgentId?.codex?.[0]?.title).toBe('Acquired account');
        expect(reads).toBe(0);
        expect(read().connectedServicesByAgentId?.codex?.[0]?.title).toBe('Acquired account');
        expect(reads).toBe(0);
        const withdrawn = publishDaemonMergedProjectionInputs({ projection: { ...projection, familiesById: {} } });
        expect(hook.getCurrent()({ phase: 'ready', inputs: withdrawn }).connectedServicesByAgentId?.codex?.[0]?.title)
            .toBe('happier.agent.codex/account');
    });
    it.each(['implicit', 'remembered', 'picker', 'draft', 'sending'] as const)('follows the exact Account-purpose default only for an implicit idle selection (%s)', async (selectionSource) => {
        const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
        await loadSyncSingletonForTests();
        const { useNewSessionBackendTargetState } = await import('@/components/sessions/new/hooks/screenModel/useNewSessionBackendTargetState');
        const { createResolvedAgentCatalogEntryFixture } = await import('@/dev/testkit/fixtures/agentCatalogFixtures');
        const { getResolvedBackendCatalogEntries } = await import('@/agents/backendCatalog/getResolvedBackendCatalogEntries');
        const server = await network.addHome('https://fresh-composer-account.example.test', 'fresh-composer-account');
        const scope = { serverId: server.id, accountId: 'fresh-composer-account' };
        const machine = createMachineFixture({ id: 'fresh-composer-machine', active: true, activeAt: Date.now() });
        const service = { pluginId: 'happier.agent.codex', localId: 'account' };
        const identity = { pluginId: 'happier.agent.codex', localId: 'codex' };
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection,
            familiesById: { connectedAccounts: { family: 'connectedAccounts', entriesById: { 'happier.agent.codex/account': {
                id: 'account', serviceId: 'account', pluginId: service.pluginId, title: 'Codex account', provenance: 'external', sourceKind: 'installed',
                authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'providerCheck' }] },
                capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
            } } } },
            agentsById: Object.fromEntries(['claude', 'codex'].map(agentId => [agentId, {
                id: agentId, title: agentId, identity: { pluginId: `happier.agent.${agentId}`, localId: agentId },
                ...(agentId === 'codex' ? { connectedAccounts: [{ purpose: 'primary', service, credentialKinds: ['oauth'] }] } : {}),
                capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
            },
            ])),
        });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope,
            settings: { ...storage.getState().settings, lastUsedAgent: null, lastUsedBackendTarget: null },
            profile: { ...storage.getState().profile, connectedAccountsV4: [{ ref: { service, accountId: 'work' },
                revisionSemantics: 'revisioned', credentialRevision: 'revision-1', status: 'connected', kind: 'oauth',
                authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null, displayName: 'Work account', scopes: [] }] },
        });
        primeServerFeaturesSnapshot({ serverId: server.id, snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({
            features: {}, capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } },
        }) } });
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: { v: 1, definitions: [] } }, true);
        const publishDefaults = (accountId: string | null, revision: number) => applyConnectedAccountCatalogSnapshot(scope, 'purposes', {
            status: 'ready', revision, record: { key: 'purposes', value: { v: 1, bindings: accountId ? [{
                purpose: { consumer: identity, purpose: 'primary' }, target: { kind: 'account', account: { service, accountId } },
            }] : [] } },
        }, true);
        publishDefaults(null, 1);
        rpc.mockImplementation(async ({ method }: { method: string }) => method.includes('contributionRegistryProjection.describe')
            ? { protocolVersion: 1, projection }
            : method === 'capabilities.detect' ? { protocolVersion: 1, results: Object.fromEntries(['claude', 'codex'].map(agentId => [
                `cli.${agentId}`, { ok: true, checkedAt: 12, data: { ...item, agentId, title: agentId,
                    signIn: { status: 'signedOut', loginSupport: 'login_terminal' }, isLoggedIn: false,
                    authStatus: { state: 'logged_out', checkedAt: 12 } } },
            ])) } : { jobs: [] });
        const entries = getResolvedBackendCatalogEntries({ enabledAgentIds: ['claude', 'codex'] }).map(entry => ({
            ...entry, agentCatalogEntry: createResolvedAgentCatalogEntryFixture({ agentId: entry.agentId }),
        }));
        const claude = entries.find(entry => entry.agentId === 'claude')!;
        if (selectionSource === 'remembered') {
            const { rememberLastUsedBackendSelection } = await import('@/sync/domains/state/newSessionTargetUiState');
            rememberLastUsedBackendSelection(storage.getState().settingsScope, { lastUsedAgent: 'claude', lastUsedBackendTarget: claude.backendTarget });
        }
        let isSending = selectionSource === 'sending';
        const hook = await renderHook(() => useNewSessionBackendTargetState({ entries, projectionPhase: 'ready', isSending,
            persistedBackendTarget: selectionSource === 'draft' ? claude.backendTarget : undefined,
            machineTarget: { machineId: machine.id, serverId: server.id, load: true } }));
        const agentId = () => hook.getCurrent().selectedCatalogAgentId;
        try {
            expect(agentId()).toBe('claude');
            await refreshMachineAgents({ serverId: server.id, machineId: machine.id,
                accountLifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) } });
            // A healthy unselected account is not launch authority.
            expect(agentId()).toBe('claude');
            if (selectionSource === 'picker') {
                await act(async () => hook.getCurrent().setBackendTarget(claude.backendTarget));
            }
            if (selectionSource === 'sending') {
                const codex = entries.find(entry => entry.agentId === 'codex')!;
                await act(async () => hook.getCurrent().setBackendTarget(codex.backendTarget));
                expect(agentId()).toBe('claude');
            }
            await act(async () => publishDefaults('missing-account', 2));
            // Selecting a default is independent of whether that credential can
            // launch. An unavailable default stays visible for repair.
            expect(agentId()).toBe(selectionSource === 'implicit' || selectionSource === 'remembered' ? 'codex' : 'claude');
            await act(async () => publishDefaults(null, 3));
            expect(agentId()).toBe('claude');
            await act(async () => publishDefaults('work', 4));
            if (selectionSource === 'picker' || selectionSource === 'draft' || selectionSource === 'sending') expect(agentId()).toBe('claude');
            if (selectionSource === 'picker' || selectionSource === 'draft') return;
            if (selectionSource === 'sending') {
                isSending = false;
                await hook.rerender();
            }
            await vi.waitFor(() => expect(agentId()).toBe('codex'));
            await act(async () => hook.getCurrent().setBackendTarget(claude.backendTarget));
            await act(async () => publishDefaults(null, 5));
            await act(async () => publishDefaults('work', 6));
            expect(agentId()).toBe('claude');
        } finally { await hook.unmount(); resetServerFeaturesClientForTests(); }
    });

    it('keeps an installed external Agent selectable across unrelated probe failures and reopening', async () => {
        const server = await network.addHome('https://isolated-inventory-facts.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: 'isolated-inventory-machine', active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: { v: 1, definitions: [] } }, true);
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: Object.fromEntries(
            ['review', 'other-agent'].map(id => [id, { id, title: id, identity: { pluginId: 'acme.review', localId: id },
                capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }]),
        ) });
        let ownAnswer = 'cli.foreign-agent';
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: {
                [ownAnswer]: { ok: true, checkedAt: Date.now(), data: { ...item,
                    signIn: { status: 'unknown', loginSupport: 'login_terminal' } } },
                'cli.other-agent': { ok: false, checkedAt: Date.now(), error: { code: 'probe_failed', message: 'Unavailable' } },
                'tool.acpAgentInventory': { ok: true, checkedAt: Date.now(), data: { items: [] } },
            } };
            return { jobs: [] };
        });
        const target = { serverId: server.id, machineId: machine.id, accountLifetime };
        await refreshMachineAgents(target);
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        // A healthy answer wired to a different Agent cannot certify Review.
        const unanswered = Object.fromEntries(machineAgentInventoryStore.read(key).agents.map(agent => [agent.agentId, agent]));
        expect(unanswered.review).toMatchObject({ installed: false, stale: true, unavailableReason: { reason: 'missing_result' } });
        expect(isAgentSelectableForNewSession({ agentId: 'review', machineAgentsById: unanswered })).toBe(false);
        ownAnswer = 'cli.review';
        await refreshMachineAgents({ ...target, force: true });
        const read = () => useMachineAgents({ serverId: server.id, machineId: machine.id, load: false });
        const assertEligibility = (snapshot: ReturnType<typeof read>) => {
            const agents = Object.fromEntries(snapshot.agents.map(agent => [agent.agentId, agent]));
            expect(snapshot.status).toBe('ready');
            expect(agents.review).toMatchObject({ installed: true, stale: false, signIn: { status: 'unknown' } });
            expect(isAgentSelectableForNewSession({ agentId: 'review', machineAgentsById: agents })).toBe(true);
            expect(agents['other-agent']).toMatchObject({ state: 'unknown', stale: true,
                unavailableReason: { reason: 'probe_failed', errorCode: 'probe_failed' } });
            expect(isAgentSelectableForNewSession({ agentId: 'other-agent', machineAgentsById: agents })).toBe(false);
        };
        const initial = await renderHook(read);
        try { assertEligibility(initial.getCurrent()); } finally { await initial.unmount(); }
        const reopened = await renderHook(read);
        try { assertEligibility(reopened.getCurrent()); } finally { await reopened.unmount(); }
    });

    it.each(['detect', 'projection'] as const)('retains the classified %s failure through inventory and its status without admitting stale facts', async (stage) => {
        const server = await network.addHome(`https://inventory-reason-${stage}.example.test`, 'inventory-reason-account');
        const scope = { serverId: server.id, accountId: 'inventory-reason-account' };
        const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: `inventory-reason-${stage}`, active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        let failed = false;
        network.setRpcAckResponder(async request => {
            if ((stage === 'projection' && request.method.includes('contributionRegistryProjection.describe')
                || stage === 'detect' && request.method === 'capabilities.detect') && failed) {
                return { ok: false, error: 'Private transport detail must not be published', errorCode: 'RPC_FORBIDDEN' };
            }
            return { ok: true, result: await rpc({ method: request.method, payload: request.payload }) };
        });
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: {
                'cli.review': { ok: true, checkedAt: Date.now(), data: item },
            } };
            return { jobs: [] };
        });
        const target = { serverId: server.id, machineId: machine.id, agentId: 'review', accountLifetime };
        await refreshMachineAgents(target);
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        expect(machineAgentInventoryStore.read(key).agents[0]?.state).toBe('ready');
        failed = true;
        await refreshMachineAgents({ ...target, force: true });
        const snapshot = machineAgentInventoryStore.read(key);
        expect(snapshot.status).toBe('error');
        expect(snapshot.failure?.errorCode, stage).toBe(stage === 'detect' ? 'RPC_FORBIDDEN' : 'access-denied');
        const row = snapshot.agents[0]!;
        expect(row.stale).toBe(true);
        expect(isMachineAgentReady(row)).toBe(false);
        expect(resolveMachineAgentStatus(row, undefined, snapshot.status)).toMatchObject({
            kind: 'unavailable', reason: { errorCode: stage === 'detect' ? 'RPC_FORBIDDEN' : 'access-denied' },
        });
        expect(JSON.stringify(snapshot)).not.toContain('Private transport detail');
        failed = false;
        await refreshMachineAgents({ ...target, force: true });
        const recovered = machineAgentInventoryStore.read(key);
        expect(recovered.status).toBe('ready');
        expect(recovered).not.toHaveProperty('failure');
        expect(isMachineAgentReady(recovered.agents[0])).toBe(true);
    });

    it.each(['selected', 'picker'] as const)('rechecks a failed %s Agent probe on the next inventory read and admits only the matching successful answer', async (surface) => {
        const server = await network.addHome(`https://probe-recovery-${surface}.example.test`, 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: `probe-recovery-${surface}`, active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: { v: 1, definitions: [] } }, true);
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        const checkedAt = Date.now();
        let answer: 'failed' | 'foreign' | 'ready' = 'failed';
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: {
                [answer === 'foreign' ? 'cli.other-agent' : 'cli.review']: answer === 'failed'
                    ? { ok: false, checkedAt, error: { code: 'probe_failed', message: 'Probe temporarily unavailable' } }
                    : { ok: true, checkedAt, data: item },
                'tool.acpAgentInventory': { ok: true, checkedAt, data: { items: [] } },
            } };
            return { jobs: [] };
        });
        const target = { serverId: server.id, machineId: machine.id, accountLifetime,
            ...(surface === 'selected' ? { agentId: 'review' } : {}) };
        await loadDaemonMergedProjectionInputs({ sections: 'complete', ...target });
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        const readAgent = () => machineAgentInventoryStore.read(key).agents.find(agent => agent.agentId === 'review');
        const selectable = () => isAgentSelectableForNewSession({ agentId: 'review', machineAgentsById: { review: readAgent() } });
        await refreshMachineAgents(target);
        expect(machineAgentInventoryStore.read(key).status).toBe('ready');
        expect(readAgent()).toMatchObject({ state: 'unknown', stale: true, unavailableReason: { reason: 'probe_failed' } });
        expect(resolveMachineAgentStatus(readAgent() ?? null)).toMatchObject({ kind: 'unavailable', reason: { reason: 'probe_failed' } });
        expect(selectable()).toBe(false);

        // A healthy answer for another Agent cannot recover this Agent's eligibility.
        answer = 'foreign';
        await refreshMachineAgents(target);
        expect(selectable()).toBe(false);
        answer = 'ready';
        await refreshMachineAgents(target);
        expect(readAgent()).toMatchObject({ state: 'ready', installed: true, stale: false });
        expect(readAgent()?.unavailableReason).toBeUndefined();
        expect(selectable()).toBe(true);
    });

    it.each(['manual', 'fleet'] as const)('releases a demanded inventory refresh on unmount and admits the next refresh of the same machine (%s)', async mode => {
        const server = await network.addHome(`https://cancel-inventory-${mode}.example.test`, 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const machine = createMachineFixture({ id: `cancel-inventory-${mode}-machine`, active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        rpc.mockImplementationOnce(() => new Promise(() => {}));
        const render = () => renderHook(() => {
            if (mode === 'manual') return { refresh: useRefreshMachineAgents(server.id), status: undefined };
            const fleet = useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: true });
            return { refresh: undefined, status: fleet.get(machine.id)?.status };
        });
        const hook = await render();
        const pending = hook.getCurrent().refresh?.(machine.id);
        let settled = false;
        void pending?.then(() => { settled = true; });
        await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
        await hook.unmount();
        if (mode === 'manual') await vi.waitFor(() => expect(settled).toBe(true));
        rpc.mockResolvedValueOnce({ protocolVersion: 1, projection: emptyProjection });
        const reopened = await render();
        try {
            if (mode === 'manual') await reopened.getCurrent().refresh?.(machine.id);
            else await vi.waitFor(() => expect(reopened.getCurrent().status).toBe('ready'));
            expect(rpc).toHaveBeenCalledTimes(2);
        } finally { await reopened.unmount(); }
    });

    it('keeps another fleet Machine acquisition admitted when one Machine registry changes', async () => {
        const server = await network.addHome('https://fleet-independent-acquisition.test', 'fleet-acquisition-account');
        const scope = { serverId: server.id, accountId: 'fleet-acquisition-account' };
        let changed = createMachineFixture({ id: 'fleet-restarted-machine', active: true, activeAt: Date.now(),
            daemonStateVersion: 1, daemonState: { status: 'running', contributionRegistryProjectionRevision: 0 } });
        const other = createMachineFixture({ id: 'fleet-pending-machine', active: true, activeAt: Date.now() });
        storage.setState({ profileScope: scope });
        storage.getState().applyMachines([changed, other], true, { sourceServerId: server.id, sourceAccountId: scope.accountId });
        const pending = createDeferred<void>();
        let otherDescriptions = 0;
        network.setRpcAckResponder(async request => {
            if (request.method.includes('contributionRegistryProjection.describe')) {
                if (request.targetId === other.id && ++otherDescriptions === 1) await pending.promise;
                return { ok: true, result: { protocolVersion: 1, projection: emptyProjection } };
            }
            return { ok: true, result: { ok: true, jobs: [] } };
        });
        const hook = await renderHook(() => useMachineAgentsByMachine({ serverId: server.id,
            machineIds: [changed.id, other.id], load: true }));
        const changedDescriptions = () => network.requests.filter(request => request.targetId === changed.id
            && request.method.includes('contributionRegistryProjection.describe')).length;
        try {
            await vi.waitFor(() => expect(hook.getCurrent().get(changed.id)?.status).toBe('ready'));
            expect(otherDescriptions).toBe(1);
            const before = changedDescriptions();
            changed = { ...changed, daemonStateVersion: 2,
                daemonState: { ...changed.daemonState!, contributionRegistryProjectionRevision: 1 } };
            await act(async () => storage.getState().applyMachines([changed], false,
                { sourceServerId: server.id, sourceAccountId: scope.accountId }));
            await vi.waitFor(() => expect(changedDescriptions()).toBeGreaterThan(before));
            expect(otherDescriptions).toBe(1);
            await act(async () => pending.resolve());
            await vi.waitFor(() => expect(hook.getCurrent().get(other.id)?.status).toBe('ready'));
        } finally { pending.resolve(); await hook.unmount(); }
    });

    it.each(['retained', 'cold'] as const)('selects a ready Codex pool over remembered signed-out Claude after a headless inventory refresh (%s purposes)', async purposes => {
        const server = await network.addHome(`https://headless-codex-pool-readiness-${purposes}.test`, 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: `headless-codex-pool-machine-${purposes}`, active: true, activeAt: Date.now() });
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const identity = BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex;
        const descriptor = {
            id: service.localId, serviceId: service.localId, pluginId: service.pluginId, title: 'ChatGPT',
            provenance: 'external', sourceKind: 'installed', capabilities: [], diagnostics: [],
            availability: { state: 'available', reason: 'resolved' },
            authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'providerCheck' }] },
        } satisfies NonNullable<PluginProjectionV2['familiesById']['connectedAccounts']>['entriesById'][string];
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection,
            familiesById: { connectedAccounts: { family: 'connectedAccounts', entriesById: { 'happier.agent.codex/openai-codex': descriptor } } },
            agentsById: {
                claude: { id: 'claude', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.claude, title: 'Claude',
                    capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
                codex: { id: 'codex', identity, title: 'Codex', connectedAccounts: [{ purpose: 'primary', service, credentialKinds: ['oauth'] }],
                    capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
            },
        });
        const deferred = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projectionDigest: 'd'.repeat(64), projection,
        }));
        const account = { ref: { service, accountId: 'work' }, revisionSemantics: 'revisioned' as const,
            credentialRevision: 'revision-1', status: 'connected' as const, kind: 'oauth' as const,
            authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null, displayName: 'Work account', scopes: [] };
        const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'pool' },
            incarnation: 'pool:1', displayName: 'Codex pool', generation: 1, runtimeStateRevision: 1, policy: {},
            activeConnectedAccountId: 'work', state: {}, members: [{ v: 1, connectedAccountId: 'work', state: {}, createdAt: 0, updatedAt: 0 }],
            createdAt: 0, updatedAt: 0 });
        storage.setState({ profileScope: scope,
            profile: { ...storage.getState().profile, connectedAccountsV4: [account], connectedAccountGroupsV4: [group] } });
        await publishMachineInventoryForTest(scope, [machine]);
        primeServerFeaturesSnapshot({ serverId: server.id, snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({
            features: {}, capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } },
        }) } });
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: { v: 1, definitions: [] } }, true);
        const purposeRecord = ConnectedAccountCatalogRecordV1Schema.parse({ key: 'purposes', value: { v: 1, bindings: [{
            purpose: { consumer: identity, purpose: 'primary' }, target: { kind: 'group', service, groupId: 'pool' },
        }] } });
        const purposeRead = createDeferred<void>();
        const purposeReply = createDeferred<void>();
        let purposeReads = 0;
        if (purposes === 'retained') applyConnectedAccountCatalogSnapshot(scope, 'purposes', {
            status: 'ready', revision: 1, record: purposeRecord,
        }, true);
        network.setHttpResponder(async request => {
            const path = new URL(String(request)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) {
                purposeReads++;
                purposeRead.resolve();
                await purposeReply.promise;
                return Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: purposeRecord } });
            }
            return null;
        });
        rpc.mockImplementation(async ({ method, payload }: { method: string; payload?: {
            sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] };
        } }) => {
            if (method.includes('contributionRegistryProjection.describe')) return payload?.sectionRead
                ? deferred.read(payload.sectionRead.digest, payload.sectionRead.offset, payload.sectionRead.includeDigests)
                : deferred.manifest;
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: Object.fromEntries(['claude', 'codex'].map(agentId => [
                `cli.${agentId}`, { ok: true, checkedAt: 12, data: { ...item, agentId, title: agentId, available: true,
                    signIn: { status: 'signedOut', loginSupport: 'login_terminal' }, isLoggedIn: false,
                    authStatus: { state: 'logged_out', reason: 'missing_credentials', checkedAt: 12 } } },
            ])) };
            return { jobs: [] };
        });
        try {
            let settled = false;
            const refreshing = refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime })
                .then(() => { settled = true; });
            if (purposes === 'cold') {
                await purposeRead.promise;
                await vi.waitFor(() => expect(readMachineAgentsForScope(lifetime, machine.id).status).toBe('ready'));
                expect(settled).toBe(false);
                purposeReply.resolve();
            }
            await refreshing;
            const machineAgents = readMachineAgentsForScope(lifetime, machine.id).agents;
            expect(machineAgents.find(agent => agent.agentId === 'claude')).toMatchObject({ state: 'needsSignIn', stale: false });
            expect(machineAgents.find(agent => agent.agentId === 'codex')).toMatchObject({ state: 'ready', stale: false,
                signIn: { status: 'signedIn', native: { status: 'signedOut' }, via: { kind: 'connected', profileLabel: 'Work account' } } });
            const codexTarget = { kind: 'agent' as const, identity };
            expect(resolvePreferredBackendTarget({ lastUsedAgent: 'claude',
                lastUsedBackendTarget: { kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.claude }, availableBackendTargets: [
                { kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.claude }, codexTarget,
            ], machineAgents })).toEqual(codexTarget);
            expect(purposeReads).toBe(purposes === 'cold' ? 1 : 0);
        } finally { purposeReply.resolve(); resetServerFeaturesClientForTests(); }
    });

    it('hydrates the selected Codex pool credential beside a successful signed-out native probe', async () => {
        const server = await network.addHome('https://codex-pool-readiness.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const machine = createMachineFixture({ id: 'codex-pool-machine', active: true, activeAt: Date.now() });
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const identity = { pluginId: 'happier.agent.codex', localId: 'codex' };
        const descriptor = {
            id: service.localId, serviceId: service.localId, pluginId: service.pluginId, title: 'ChatGPT',
            provenance: 'external', sourceKind: 'installed', capabilities: [], diagnostics: [],
            availability: { state: 'available', reason: 'resolved' },
            authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'providerCheck' }] },
        } satisfies NonNullable<PluginProjectionV2['familiesById']['connectedAccounts']>['entriesById'][string];
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection,
            familiesById: { connectedAccounts: { family: 'connectedAccounts', entriesById: { 'happier.agent.codex/openai-codex': descriptor } } },
            agentsById: { codex: { id: 'codex', identity, title: 'Codex', connectedAccounts: [{ purpose: 'primary', service, credentialKinds: ['oauth'] }],
                capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } } },
        });
        const deferred = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projectionDigest: 'd'.repeat(64), projection,
        }));
        const account = { ref: { service, accountId: 'work' }, revisionSemantics: 'revisioned' as const,
            credentialRevision: 'revision-1', status: 'connected' as const, kind: 'oauth' as const,
            authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null, displayName: 'Work account', scopes: [] };
        const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'pool' },
            incarnation: 'pool:1', displayName: 'Codex pool', generation: 1, runtimeStateRevision: 1, policy: {},
            activeConnectedAccountId: 'work', state: {}, members: [{ v: 1, connectedAccountId: 'work', state: {}, createdAt: 0, updatedAt: 0 }],
            createdAt: 0, updatedAt: 0 });
        storage.setState({ profileScope: scope,
            profile: { ...storage.getState().profile, connectedAccountsV4: [account], connectedAccountGroupsV4: [group] } });
        await publishMachineInventoryForTest(scope, [machine]);
        primeServerFeaturesSnapshot({ serverId: server.id, snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({
            features: {}, capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } },
        }) } });
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: { v: 1, definitions: [] } }, true);
        const publishDefault = (revision: number, selected: boolean) => applyConnectedAccountCatalogSnapshot(scope, 'purposes', {
            status: 'ready', revision, record: { key: 'purposes', value: { v: 1, bindings: selected ? [{
                purpose: { consumer: identity, purpose: 'primary' }, target: { kind: 'group', service, groupId: 'pool' },
            }] : [] } },
        }, true);
        publishDefault(1, true);
        const sectionsRead = new Set<string>();
        rpc.mockImplementation(async ({ method, payload }: { method: string; payload?: {
            sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] };
        } }) => {
            if (method.includes('contributionRegistryProjection.describe')) {
                if (!payload?.sectionRead) return deferred.manifest;
                sectionsRead.add(payload.sectionRead.digest);
                for (const digest of payload.sectionRead.includeDigests ?? []) sectionsRead.add(digest);
                // Real deferred responses expose only demanded sections, unlike the full-projection fixture.
                return deferred.read(payload.sectionRead.digest, payload.sectionRead.offset, payload.sectionRead.includeDigests);
            }
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: { 'cli.codex': {
                ok: true, checkedAt: 1793444255885, data: { ...item, agentId: 'codex', title: 'Codex', available: true,
                    signIn: { status: 'signedOut', loginSupport: 'login_terminal' }, isLoggedIn: false,
                    authStatus: { state: 'logged_out', reason: 'missing_credentials', checkedAt: 1793444255885 } },
            } } };
            return { jobs: [] };
        });
        const hook = await renderHook(() => ({
            inventory: useMachineAgents({ serverId: server.id, machineId: machine.id, agentId: 'codex' }),
            fleet: useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: false }),
        }));
        try {
            const rows = () => [hook.getCurrent().inventory.agents[0], hook.getCurrent().fleet.get(machine.id)?.agents[0]];
            await vi.waitFor(() => { for (const row of rows()) expect(row).toMatchObject({ state: 'ready', stale: false,
                signIn: { status: 'signedIn', native: { status: 'signedOut' }, via: { kind: 'connected', profileLabel: 'Work account' } } }); });
            for (const row of rows()) expect(row?.signIn.connectedServices[0]?.groups).toEqual([]);
            await act(async () => primeServerFeaturesSnapshot({ serverId: server.id, snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({
                features: { connectedServices: { enabled: true, accountGroups: { enabled: true } } },
                capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } },
            }) } }));
            await vi.waitFor(() => { for (const row of rows()) expect(row?.signIn.connectedServices[0]?.groups)
                .toEqual([expect.objectContaining({ groupId: 'pool', activeProfileId: 'work' })]); });
            const detects = network.requests.filter(request => request.method === 'capabilities.detect').length;
            expect(detects).toBe(1);
            expect(sectionsRead.has(deferred.manifest.sections['familiesById.connectedAccounts']!)).toBe(true);
            expect(sectionsRead.has(deferred.manifest.sections.actionsById!)).toBe(false);
            await act(async () => publishDefault(2, false));
            await vi.waitFor(() => { for (const row of rows()) expect(row).toMatchObject({ state: 'needsSignIn',
                signIn: { status: 'signedOut', via: null } }); });
            await act(async () => {
                storage.setState({ profile: { ...storage.getState().profile, connectedAccountsV4: [{ ...account, status: 'needs_reauth' }] } });
                publishDefault(3, true);
            });
            await vi.waitFor(() => { for (const row of rows()) expect(row).toMatchObject({ state: 'needsSignIn',
                signIn: { status: 'signedOut', connectedAccountFailure: { code: 'connected_service_credential_reconnect_required', profileId: 'work' } } }); });
            expect(network.requests.filter(request => request.method === 'capabilities.detect')).toHaveLength(detects);
        } finally { await hook.unmount(); resetServerFeaturesClientForTests(); }
    });

    it('projects Account purpose defaults into single-machine and fleet sign-in, including changes without a CLI probe', async () => {
        const { useMachineAgentAuthentication } = await import('./useMachineAgentAuthentication');
        const { publishDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters');
        const server = await network.addHome('https://default-auth-inventory.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: 'default-auth-machine', active: true, activeAt: Date.now() });
        const service = { pluginId: 'acme.review', localId: 'account' };
        const identity = { pluginId: 'acme.review', localId: 'review' };
        const descriptor = {
            id: 'account', serviceId: 'account', pluginId: service.pluginId, title: 'Review account', provenance: 'external', sourceKind: 'installed',
            authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'providerCheck' }] },
            capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
        } satisfies NonNullable<PluginProjectionV2['familiesById']['connectedAccounts']>['entriesById'][string];
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection,
            familiesById: { connectedAccounts: { family: 'connectedAccounts', entriesById: { 'acme.review/account': descriptor } } },
            agentsById: { review: { id: 'review', identity, title: 'Review', connectedAccounts: [{ purpose: 'primary', service, credentialKinds: ['oauth'] }],
                capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } } },
        });
        storage.setState({ profileScope: scope, profile: {
            ...storage.getState().profile,
            connectedAccountsV4: [{ ref: { service, accountId: 'work' }, revisionSemantics: 'revisioned', credentialRevision: 'revision-1',
                status: 'connected', kind: 'oauth', authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null,
                displayName: 'Work account', scopes: [] }],
        } });
        await publishMachineInventoryForTest(scope, [machine]);
        primeServerFeaturesSnapshot({ serverId: server.id, snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({
            features: {}, capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } },
        }) } });
        rpc.mockImplementation(async ({ method }: { method: string }) => method.includes('contributionRegistryProjection.describe')
            ? { protocolVersion: 1, projection }
            : method === 'capabilities.detect' ? { protocolVersion: 1, results: { 'cli.review': { ok: true, checkedAt: 12,
                data: { ...item, signIn: { status: 'signedOut', loginSupport: 'login_terminal' }, isLoggedIn: false,
                    authStatus: { state: 'logged_out', checkedAt: 12 } } } } } : { jobs: [] });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        const accountTarget: QualifiedConnectedAccountPurposeBindingTargetV1 = { kind: 'account', account: { service, accountId: 'work' } };
        const publishDefaults = (revision: number, target: QualifiedConnectedAccountPurposeBindingTargetV1 | null) => applyConnectedAccountCatalogSnapshot(scope, 'purposes', {
            status: 'ready', revision, record: { key: 'purposes', value: { v: 1, bindings: target ? [{
                purpose: { consumer: identity, purpose: 'primary' }, target,
            }] : [] } },
        }, true);
        publishDefaults(1, null);
        const hook = await renderHook(({ authenticationLifetime }: { authenticationLifetime: typeof lifetime }) => ({
            inventory: useMachineAgents({ serverId: server.id, machineId: machine.id, load: false }),
            fleet: useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: false }),
            authentication: useMachineAgentAuthentication({ lifetime: authenticationLifetime, serverId: server.id, enabled: true }),
        }), { initialProps: { authenticationLifetime: lifetime } });
        try {
            const rows = () => [hook.getCurrent().inventory.agents[0], hook.getCurrent().fleet.get(machine.id)?.agents[0]];
            await vi.waitFor(() => { for (const row of rows()) expect(row).toMatchObject({ signIn: { status: 'signedOut', via: null } }); });
            network.requests.length = 0;
            await act(async () => publishDefaults(2, accountTarget));
            await vi.waitFor(() => { for (const row of rows()) expect(row).toMatchObject({ signIn: {
                status: 'signedIn', via: { kind: 'connected', profileLabel: 'Work account' },
            } }); });
            const acquired = publishDaemonMergedProjectionInputs({ projection });
            const readAuthentication = () => hook.getCurrent().authentication({ phase: 'ready', inputs: acquired });
            const parse = vi.spyOn(QualifiedConnectedAccountPurposeV1Schema, 'parse');
            try {
                for (let index = 0; index < 100; index++) {
                    expect(readAuthentication().credentialSelectionsByAgentId?.review?.credentialBindings).toEqual({
                        v: 2, bindingsByServiceId: { 'acme.review/account': { source: 'connected', selection: 'profile', profileId: 'work' } },
                    });
                }
                expect(parse).toHaveBeenCalledTimes(0);
            } finally { parse.mockRestore(); }
            const connections = storage.getState().profile.connectedAccountsV4;
            await act(async () => storage.setState({ profile: { ...storage.getState().profile, connectedAccountsV4: [] } }));
            await vi.waitFor(() => { for (const row of rows()) expect(row?.signIn.status).toBe('signedOut'); });
            await act(async () => storage.setState({ profile: { ...storage.getState().profile, connectedAccountsV4: connections } }));
            await vi.waitFor(() => { for (const row of rows()) expect(row?.signIn.status).toBe('signedIn'); });
            const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
            await act(async () => machineAgentInventoryStore.publishJobs(key, new Map()));
            expect(machineAgentInventoryStore.read(key).agents[0]?.signIn.status).toBe('signedIn');
            const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'pool' },
                incarnation: 'pool:1', displayName: 'Pool', generation: 1, runtimeStateRevision: 1, policy: {},
                activeConnectedAccountId: 'work', state: {}, members: [{ v: 1, connectedAccountId: 'work', state: {}, createdAt: 0, updatedAt: 0 }],
                createdAt: 0, updatedAt: 0 });
            await act(async () => {
                storage.setState({ profile: { ...storage.getState().profile, connectedAccountGroupsV4: [group] } });
                publishDefaults(3, { kind: 'group', service, groupId: 'pool' });
            });
            await vi.waitFor(() => { for (const row of rows()) expect(row?.signIn.status).toBe('signedIn'); });
            expect(readAuthentication().credentialSelectionsByAgentId?.review?.credentialBindings).toEqual({
                v: 2, bindingsByServiceId: { 'acme.review/account': { source: 'connected', selection: 'group', groupId: 'pool' } },
            });
            await act(async () => storage.setState({ profile: { ...storage.getState().profile,
                connectedAccountGroupsV4: [{ ...group, activeConnectedAccountId: null }] } }));
            await vi.waitFor(() => { for (const row of rows()) expect(row?.signIn.status).toBe('signedOut'); });
            await act(async () => applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'unavailable', reason: 'unauthorized' }, true));
            await vi.waitFor(() => { for (const row of rows()) expect(row).toMatchObject({ state: 'unknown', signIn: { status: 'unknown', via: null } }); });
            // An authored Session choice remains independent of unread Account defaults.
            const { projectMachineAgentForCredential } = await import('./machineAgentModel');
            expect(projectMachineAgentForCredential(rows()[0], { credentialBindings: { v: 2, bindingsByServiceId: {
                'acme.review/account': { source: 'connected', selection: 'profile', profileId: 'work' },
            } } })).toMatchObject({ state: 'ready', signIn: { status: 'signedIn' } });
            await act(async () => publishDefaults(4, null));
            await vi.waitFor(() => { for (const row of rows()) expect(row).toMatchObject({ signIn: { status: 'signedOut', via: null } }); });
            expect(network.requests.filter(({ method }) => method === 'capabilities.detect')).toEqual([]);
            const successorScope = { ...scope, accountId: 'successor-account' };
            await hook.rerender({ authenticationLifetime: { ...lifetime, scope: successorScope } });
            expect(readAuthentication().credentialSelectionsByAgentId?.review).toMatchObject({
                credentialBindings: null, credentialBindingsReady: false,
            });
            await act(async () => applyConnectedAccountCatalogSnapshot(successorScope, 'purposes', { status: 'ready', revision: 1,
                record: { key: 'purposes', value: { v: 1, bindings: [{ purpose: { consumer: identity, purpose: 'primary' },
                    target: { kind: 'account', account: { service, accountId: 'successor-work' } } }] } } }, true));
            expect(readAuthentication().credentialSelectionsByAgentId?.review?.credentialBindings).toEqual({
                v: 2, bindingsByServiceId: { 'acme.review/account': { source: 'connected', selection: 'profile', profileId: 'successor-work' } },
            });
        } finally { await hook.unmount(); resetServerFeaturesClientForTests(); }
    });
    it('evaluates Connected Account sign-in once for single-machine and fleet observers that mount before the projection loads', async () => {
        const server = await network.addHome('https://auth-shape-inventory.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: 'auth-shape-machine', active: true, activeAt: Date.now() });
        const service = { pluginId: 'acme.review', localId: 'account' };
        const identity = { pluginId: 'acme.review', localId: 'review' };
        const descriptor = {
            id: 'account', serviceId: 'account', pluginId: service.pluginId, title: 'Review account', provenance: 'external', sourceKind: 'installed',
            authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'providerCheck' }] },
            capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
        } satisfies NonNullable<PluginProjectionV2['familiesById']['connectedAccounts']>['entriesById'][string];
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection,
            familiesById: { connectedAccounts: { family: 'connectedAccounts', entriesById: { 'acme.review/account': descriptor } } },
            agentsById: { review: { id: 'review', identity, title: 'Review', connectedAccounts: [{ purpose: 'primary', service, credentialKinds: ['oauth'] }],
                capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } } },
        });
        storage.setState({ profileScope: scope });
        await publishMachineInventoryForTest(scope, [machine]);
        // The Home's features are already settled before either observer mounts.
        primeServerFeaturesSnapshot({ serverId: server.id, snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({
            features: {}, capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } },
        }) } });
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'ready', revision: 1, record: { key: 'purposes', value: { v: 1, bindings: [] } } }, true);
        rpc.mockImplementation(async ({ method }: { method: string }) => method.includes('contributionRegistryProjection.describe')
            ? { protocolVersion: 1, projection }
            : method === 'capabilities.detect' ? { protocolVersion: 1, results: { 'cli.review': { ok: true, checkedAt: 12,
                data: { ...item, signIn: { status: 'signedOut', loginSupport: 'login_terminal' }, isLoggedIn: false,
                    authStatus: { state: 'logged_out', checkedAt: 12 } } } } } : { jobs: [] });
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        // Each publication of the shared inventory re-renders every consumer; record which sign-in shape it carried.
        const unevaluated: number[] = [];
        let publications = 0;
        const off = machineAgentInventoryStore.subscribe(key, () => {
            publications++;
            const connected = machineAgentInventoryStore.read(key).agents[0]?.signIn.connectedServices[0];
            if (connected && connected.profiles === undefined) unevaluated.push(publications);
        });
        const hook = await renderHook(() => ({
            inventory: useMachineAgents({ serverId: server.id, machineId: machine.id, load: false }),
            fleet: useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: false }),
        }));
        try {
            await act(async () => { await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime }); });
            await vi.waitFor(() => expect(hook.getCurrent().inventory.agents[0]?.signIn.connectedServices[0]?.profiles).toEqual([]));
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
            // Settled features never publish an "undetermined" Account shape that a later publication reverses.
            expect(unevaluated).toEqual([]);
        } finally { off(); await hook.unmount(); resetServerFeaturesClientForTests(); }
    });
    it.each(['signedIn', 'signedOut', 'unavailable'] as const)('keeps an untouched embedded Agent idle and settles its demanded probe to %s', async (outcome) => {
        const server = await network.addHome(`https://embedded-agent-${outcome}.example.test`, 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const machine = createMachineFixture({ id: `embedded-agent-${outcome}`, active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        const probe = createDeferred<unknown>();
        let probing = false;
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') { probing = true; return probe.promise; }
            return { jobs: [] };
        });
        const hook = await renderHook(({ demanded }: { demanded: boolean }) => useMachineAgents({
            serverId: server.id, machineId: machine.id, agentId: 'review', load: demanded,
        }), { initialProps: { demanded: false } });
        try {
            expect(hook.getCurrent().status).toBe('idle');
            expect(hook.getCurrent().agents.some(agent => agent.state === 'checking')).toBe(false);
            expect(resolveMachineAgentStatus(hook.getCurrent().agents[0] ?? null, undefined, hook.getCurrent().status).kind).toBe('unknown');
            expect(network.requests).toEqual([]);
            // Another surface may describe the machine before this composer is used.
            // Catalog metadata alone does not mean a capability probe is pending.
            const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
            await act(async () => { await loadDaemonMergedProjectionInputs({ sections: 'complete', serverId: server.id, machineId: machine.id, accountLifetime }); });
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'idle', agents: [{ state: 'unknown' }] }));
            expect(network.requests.filter(({ method }) => method === 'capabilities.detect')).toEqual([]);
            await hook.rerender({ demanded: true });
            await vi.waitFor(() => expect(probing).toBe(true));
            expect(hook.getCurrent()).toMatchObject({ status: 'loading', agents: [{ state: 'checking' }] });
            const signedIn = outcome === 'signedIn';
            await act(async () => {
                probe.resolve({ protocolVersion: 1, results: { 'cli.review': outcome === 'unavailable'
                    ? { ok: false, checkedAt: 12, error: { code: 'probe_failed', message: 'Agent unavailable' } }
                    : { ok: true, checkedAt: 12, data: { ...item,
                        signIn: { status: outcome, loginSupport: 'status_only' }, isLoggedIn: signedIn,
                        authStatus: { state: signedIn ? 'logged_in' : 'logged_out', checkedAt: 12 },
                    } },
                } });
            });
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', agents: [{
                state: outcome === 'signedIn' ? 'ready' : outcome === 'signedOut' ? 'needsSignIn' : 'unknown',
                stale: outcome === 'unavailable',
            }] }));
        } finally { probe.resolve({ protocolVersion: 1, results: {} }); await hook.unmount(); }
    });

    it('detects caller catalog definitions separately and clears them only for a ready-empty catalog', async () => {
        const server = await network.addHome('https://definition-inventory.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: 'definition-inventory-machine', active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: ['first', 'second'].map(id => ({
            id, name: id, title: `Caller ${id}`, launch: { kind: 'npm', package: 'fixture', version: '1.0', args: [] },
            env: { TOKEN: { t: 'literal', v: 'never-sent-secret' } }, createdAt: 1, updatedAt: 1,
        })) });
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record }, true);
        rpc.mockImplementation(async ({ method, payload }: { method: string; payload?: { requests?: { id: string; params?: { definitions?: { definitionId: string; title: string }[] } }[] } }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection: emptyProjection };
            if (method === 'capabilities.detect') {
                expect(JSON.stringify(payload)).not.toContain('never-sent-secret');
                const definitions = payload?.requests?.find(request => request.id === 'tool.acpAgentInventory')?.params?.definitions ?? [];
                return { protocolVersion: 1, results: { 'tool.acpAgentInventory': { ok: true, checkedAt: 24, data: {
                    items: definitions.map(definition => ({ ...item, agentId: 'custom-acp', definitionId: definition.definitionId, title: definition.title,
                        managed: true, fit: { kind: 'can_run', via: 'npm' }, version: definition.definitionId === 'first' ? '1.0' : '2.0' })),
                } } } };
            }
            return { jobs: [] };
        });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        expect(machineAgentInventoryStore.read(key).agents.map(agent => [agent.definitionId, agent.version])).toEqual([['first', '1.0'], ['second', '2.0']]);
        const hook = await renderHook(() => useMachineAgents({ serverId: server.id, machineId: machine.id, load: false }));
        try {
            await act(async () => applyAcpCatalogSnapshot(scope, { status: 'unavailable', reason: 'unreachable' }, true));
            expect(hook.getCurrent().agents).toMatchObject([{ definitionId: 'first', stale: true }, { definitionId: 'second', stale: true }]);
            await act(async () => applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 2, record: { v: 1, definitions: [] } }, true));
            expect(hook.getCurrent().agents).toEqual([]);
        } finally { await hook.unmount(); }
    });
    it('allows explicit refresh after an exact Account request failed while passive refresh remains offline', async () => {
        const server = await network.addHome('https://explicit-agent-retry.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: 'explicit-agent-retry-machine', active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        rpc.mockResolvedValue({ protocolVersion: 1, projection: emptyProjection });
        recordMachineRequestFailed({ ...scope, machineId: machine.id });
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime });
        expect(machineAgentInventoryStore.read(key).status).toBe('offline');
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime, force: true });
        expect(machineAgentInventoryStore.read(key).status).toBe('ready');
    });
    it('retries one machine inventory from the all-machine summary without probing on mount or trusting fresh cached facts', async () => {
        const server = await network.addHome('https://summary-agent-retry.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machines = ['retry-machine', 'untouched-machine'].map(id => createMachineFixture({ id, active: true, activeAt: Date.now() }));
        storage.setState({ machineListByServerId: { [server.id]: machines }, profileScope: scope });
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        let installed = true;
        let checkedAt = 12;
        let projectionFailed = false;
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) {
                if (projectionFailed) throw new Error('transport disconnected');
                return { protocolVersion: 1, projection };
            }
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: { 'cli.review': { ok: true, checkedAt, data: { ...item, installed } } } };
            return { jobs: [] };
        });
        for (const machine of machines) await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime });
        projectionFailed = true;
        publishMachineContributionRegistryProjectionInvalidation({ serverId: server.id, machineId: machines[0].id }, 'authority');
        await refreshMachineAgents({ serverId: server.id, machineId: machines[0].id, accountLifetime });
        network.requests.length = 0;
        const hook = await renderHook(() => ({
            snapshots: useMachineAgentsByMachine({ serverId: server.id, machineIds: machines.map(machine => machine.id), load: false }),
            refresh: useRefreshMachineAgents(server.id),
        }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().snapshots.get(machines[1].id)?.status).toBe('ready'));
            expect(hook.getCurrent().snapshots.get(machines[0].id)).toMatchObject({ status: 'error', lastCheckedAt: 12,
                agents: [{ installed: true, stale: true }] });
            const untouched = hook.getCurrent().snapshots.get(machines[1].id);
            expect(network.requests).toEqual([]);
            installed = false;
            checkedAt = 24;
            projectionFailed = false;
            await act(async () => hook.getCurrent().refresh(machines[0].id));
            expect(hook.getCurrent().snapshots.get(machines[0].id)).toMatchObject({ status: 'ready', lastCheckedAt: 24,
                agents: [{ installed: false, stale: false, state: 'notInstalled' }] });
            expect(hook.getCurrent().snapshots.get(machines[1].id)).toBe(untouched);
            expect(network.requests.filter(({ method }) => method === 'capabilities.detect')).toEqual([
                expect.objectContaining({ serverUrl: server.serverUrl, token: server.token, targetId: machines[0].id }),
            ]);
            installed = true;
            checkedAt = 36;
            network.requests.length = 0;
            await act(async () => hook.getCurrent().refresh(machines[0].id));
            expect(hook.getCurrent().snapshots.get(machines[0].id)).toMatchObject({ status: 'ready', lastCheckedAt: 36,
                agents: [{ installed: true, stale: false }] });
            expect(hook.getCurrent().snapshots.get(machines[1].id)).toBe(untouched);
            // An installed Agent first refreshes executable/authentication facts,
            // then enriches that same Machine with optional vendor update facts.
            expect(network.requests.filter(({ method }) => method === 'capabilities.detect')).toEqual([
                expect.objectContaining({ targetId: machines[0].id, payload: expect.objectContaining({ bypassCache: true,
                    requests: [{ id: 'cli.review', params: { includeLoginStatus: true } }],
                }) }),
                expect.objectContaining({ targetId: machines[0].id, payload: expect.objectContaining({ bypassCache: true,
                    requests: [{ id: 'cli.review', params: { includeLoginStatus: true, includeLatestVersion: true } }],
                }) }),
            ]);
            const refresh = hook.getCurrent().refresh;
            await hook.unmount();
            network.requests.length = 0;
            await refresh(machines[0].id);
            expect(network.requests).toEqual([]);
        } finally { await hook.unmount(); }
    });
    it('retains locked machine inventory without requesting executable Agent facts', async () => {
        const server = await network.addHome('https://locked-inventory.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: 'locked-inventory-machine', active: true, activeAt: Date.now(),
            availability: { kind: 'locked', reason: 'encryption_material_unavailable' } });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        machineAgentInventoryStore.publish(key, { status: 'ready', items: [item], lastCheckedAt: 12 });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime, force: true });
        expect(machineAgentInventoryStore.read(key)).toMatchObject({ status: 'offline', lastCheckedAt: 12 });
        expect(rpc).not.toHaveBeenCalled();
    });
    it.each(['detail', 'summary'] as const)('denies cached Agent readiness on exact-Home request failure and restores on success (%s)', async mode => {
        const server = await network.addHome(`https://inventory-reachability-${mode}.example.test`, 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: `reachability-${mode}-machine`, active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: { 'cli.review': { ok: true, checkedAt: 12, data: item } } };
            return { jobs: [] };
        });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        const hook = await renderHook(mode === 'detail'
            ? () => useMachineAgents({ serverId: server.id, machineId: machine.id, load: false })
            : () => useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: false }).get(machine.id) ?? EMPTY_MACHINE_AGENTS);
        try {
            expect(hook.getCurrent().status).toBe('ready');
            await act(async () => recordMachineRequestFailed({ serverId: 'other-home', accountId: scope.accountId, machineId: machine.id }));
            expect(isMachineAgentReady(hook.getCurrent().agents[0])).toBe(true);
            await act(async () => recordMachineRequestFailed({ ...scope, machineId: machine.id }));
            expect(hook.getCurrent()).toMatchObject({ status: 'offline', lastCheckedAt: 12 });
            expect(isMachineAgentReady(hook.getCurrent().agents[0])).toBe(false);
            await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
            expect(hook.getCurrent().status).toBe('offline');
            await act(async () => refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime, force: true }));
            expect(hook.getCurrent().status).toBe('ready');
            expect(isMachineAgentReady(hook.getCurrent().agents[0])).toBe(true);
        } finally { await hook.unmount(); }
    });
    it.each(['detail', 'summary'] as const)('does not wake a %s reader for reachability changes outside its Home, Account and Machine', async mode => {
        const server = await network.addHome(`https://inventory-reachability-scope-${mode}.example.test`, 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: `reachability-scope-${mode}-machine`, active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: { 'cli.review': { ok: true, checkedAt: 12, data: item } } };
            return { jobs: [] };
        });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return mode === 'detail'
                ? useMachineAgent({ serverId: server.id, machineId: machine.id, agentId: 'review', load: false })
                : useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: false });
        });
        try {
            await act(async () => {});
            const settled = renders;
            await act(async () => {
                recordMachineRequestFailed({ serverId: 'other-home', accountId: scope.accountId, machineId: machine.id });
                recordMachineRequestFailed({ ...scope, accountId: 'other-account', machineId: machine.id });
                if (mode === 'detail') recordMachineRequestFailed({ ...scope, machineId: 'other-machine' });
            });
            expect(renders).toBe(settled);
            await act(async () => recordMachineRequestFailed({ ...scope, machineId: machine.id }));
            expect(renders).toBeGreaterThan(settled);
        } finally { await hook.unmount(); }
    });
    it('keeps passive summary snapshots stable without a getSnapshot warning', async () => {
        const { useUpdatesSummary } = await import('@/updates/useUpdatesSummary');
        const server = await network.addHome('https://stable-summary-inventory.example.test', 'inventory-account');
        const machine = createMachineFixture({ id: 'stable-summary-machine', active: false, activeAt: 0 });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: { serverId: server.id, accountId: 'inventory-account' } });
        const errors = vi.spyOn(console, 'error');
        const hook = await renderHook(() => ({
            inventory: useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: false }),
            updates: useUpdatesSummary(),
        }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().inventory.get(machine.id)?.status).toBe('offline'));
            const snapshot = hook.getCurrent();
            await hook.rerender();
            expect(hook.getCurrent().inventory).toBe(snapshot.inventory);
            expect(hook.getCurrent().updates).toBe(snapshot.updates);
            expect(errors.mock.calls.filter(args => args.some(value => String(value).includes('getSnapshot should be cached')))).toEqual([]);
        } finally { await hook.unmount(); errors.mockRestore(); }
    });

    it.each(['detail', 'summary'] as const)('keeps one store snapshot stable as time passes and observes server withdrawal (%s)', async mode => {
        const server = await network.addHome(`https://presence-boundary-${mode}-inventory.example.test`, 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(10_000);
        const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
        const machine = createMachineFixture({ id: `presence-boundary-${mode}-machine`, active: true, activeAt: 10_000,
            presenceProtocolVersion: 1 });
        storage.setState({ profileScope: scope });
        storage.getState().applyMachines([machine], true, { sourceServerId: server.id, sourceAccountId: scope.accountId });
        machineAgentInventoryStore.publish(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id),
            { status: 'ready', items: [item], lastCheckedAt: 12 });
        const errors = vi.spyOn(console, 'error');
        let crossed = false;
        const hook = await renderHook(({ crossBoundary }: { crossBoundary: boolean }) => {
            if (crossBoundary && !crossed) {
                crossed = true;
                // A monotonic OS-clock boundary, with no intervening store write.
                clock.mockReturnValueOnce(10_000).mockReturnValue(11_001);
            }
            return mode === 'detail'
                ? useMachineAgents({ serverId: server.id, machineId: machine.id, load: false })
                : useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: false }).get(machine.id);
        }, { initialProps: { crossBoundary: false } });
        try {
            expect(hook.getCurrent()?.status).not.toBe('offline');
            await hook.rerender({ crossBoundary: true });
            expect(errors.mock.calls.filter(args => args.some(value => String(value).includes('getSnapshot should be cached')))).toEqual([]);
            // Reusing one observation must not hide a later expired presence read.
            await hook.rerender({ crossBoundary: false });
            // Drive the existing shared deadline, rather than advancing Date
            // while leaving its scheduled timer in an unrelated real clock.
            // The render need not consume the one-shot Date probe after it
            // delegates unchanged reads to the shared presence snapshot.
            clock.mockReset().mockReturnValue(11_001);
            await act(async () => { vi.advanceTimersByTime(1_001); });
            expect(hook.getCurrent()?.status).not.toBe('offline');
            await act(async () => storage.getState().applyMachineActivityUpdates([{ id: machine.id, active: false, activeAt: 11_001 }], { sourceServerId: server.id }));
            expect(hook.getCurrent()?.status).toBe('offline');
        } finally {
            await hook.unmount();
            errors.mockRestore();
            clock.mockRestore();
            vi.useRealTimers();
            vi.unstubAllEnvs();
        }
    });

    it('batches native and configured readiness when the Account definition catalog is already admitted', async () => {
        const server = await network.addHome('https://warm-catalog-inventory.example.test', 'warm-catalog-account');
        const scope = { serverId: server.id, accountId: 'warm-catalog-account' };
        const machine = createMachineFixture({ id: 'warm-catalog-machine', active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
            id: 'configured', name: 'configured', title: 'Configured Agent',
            launch: { kind: 'npm', package: 'fixture', version: '1.0', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
        }] });
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record }, true);
        const definitions = [{ definitionId: 'configured', title: 'Configured Agent', launch: record.definitions[0]!.launch }];
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        rpc.mockImplementation(async ({ method, payload }: { method: string;
            payload?: { requests?: { id: string }[] } }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: Object.fromEntries((payload?.requests ?? []).map(request =>
                [request.id, { ok: true, checkedAt: 12, data: request.id === 'tool.acpAgentInventory'
                    ? { items: [{ ...item, agentId: buildConfiguredAcpAgentSelectionV1('configured').agentId, definitionId: 'configured', title: 'Configured Agent',
                        managed: true, fit: { kind: 'can_run', via: 'npm' } }] }
                    : { ...item, authStatus: { state: 'logged_in', checkedAt: 12 } } }])) };
            return { jobs: [] };
        });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id,
            accountLifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) } });
        const observed = machineAgentInventoryStore.read(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id));
        expect(observed.agents).toHaveLength(2);
        expect(observed.agents.every(isMachineAgentReady)).toBe(true);
        expect(network.requests.filter(request => request.method === 'capabilities.detect').map(request => request.payload)).toEqual([
            { requests: [{ id: 'cli.review', params: { includeLoginStatus: true } },
                { id: 'tool.acpAgentInventory', params: { definitions } }] },
        ]);
    });

    it.each(['inventory', 'fleet', 'withdrawn'] as const)('loads native %s Agent readiness while the Account definition catalog is pending', async surface => {
        const server = await network.addHome(`https://${surface}-cold-catalog.example.test`, 'cold-catalog-account');
        const scope = { serverId: server.id, accountId: 'cold-catalog-account' };
        const machine = createMachineFixture({ id: `${surface}-cold-catalog-machine`, active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const catalogResponse = createDeferred<Response>();
        let catalogRequested = false;
        network.setHttpResponder(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) {
                catalogRequested = true;
                return catalogResponse.promise;
            }
            return null;
        });
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
            id: 'configured', name: 'configured', title: 'Configured Agent',
            launch: { kind: 'npm', package: 'fixture', version: '1.0', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
        }] });
        rpc.mockImplementation(async ({ method, payload }: { method: string;
            payload?: { requests?: { id: string; params?: { definitions?: { definitionId: string; title: string }[] } }[] } }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: Object.fromEntries((payload?.requests ?? []).map(request =>
                [request.id, { ok: true, checkedAt: 12, data: request.id === 'tool.acpAgentInventory'
                    ? { items: (request.params?.definitions ?? []).map(definition => ({ ...item, agentId: buildConfiguredAcpAgentSelectionV1(definition.definitionId).agentId,
                        definitionId: definition.definitionId, title: definition.title, managed: true, fit: { kind: 'can_run', via: 'npm' } })) }
                    : { ...item, authStatus: { state: 'logged_in', checkedAt: 12 } } }])) };
            return { jobs: [] };
        });
        const hook = await renderHook(() => surface !== 'inventory'
            ? useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: true }).get(machine.id) ?? EMPTY_MACHINE_AGENTS
            : useMachineAgents({ serverId: server.id, machineId: machine.id }));
        try {
            await vi.waitFor(() => expect(catalogRequested).toBe(true));
            await vi.waitFor(() => expect(isMachineAgentReady(hook.getCurrent().agents.find(agent => agent.agentId === 'review'))).toBe(true));
            const beforeCatalog = network.requests.filter(request => request.method === 'capabilities.detect');
            expect(beforeCatalog).toHaveLength(1);
            if (surface === 'withdrawn') await hook.unmount();
            await act(async () => catalogResponse.resolve(surface !== 'fleet'
                ? Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: record } })
                : Response.json({ error: 'catalog temporarily unavailable' }, { status: 503 })));
            await vi.waitFor(() => expect(getAcpCatalogSnapshot(scope)?.catalog.status).toBe(surface !== 'fleet' ? 'ready' : 'unavailable'));
            if (surface === 'withdrawn') {
                expect(network.requests.filter(request => request.method === 'capabilities.detect')).toEqual(beforeCatalog);
                return;
            }
            if (surface === 'inventory') await vi.waitFor(() =>
                expect(isMachineAgentReady(hook.getCurrent().agents.find(agent => agent.definitionId === 'configured')),
                    JSON.stringify({ inventory: hook.getCurrent(), requests: network.requests.filter(request => request.method === 'capabilities.detect')
                        .map(request => ({ targetId: request.targetId, payload: request.payload })) }))
                    .toBe(true));
            await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
            expect(isMachineAgentReady(hook.getCurrent().agents.find(agent => agent.agentId === 'review'))).toBe(true);
        } finally {
            catalogResponse.resolve(Response.json({ status: 'deleted', revision: 1 }));
            await hook.unmount();
        }
    });

    it.each(['selected', 'inventory', 'fleet'] as const)('loads %s Agent readiness without waiting for vendor updates and enriches the same inventory', async surface => {
        const server = await network.addHome(`https://${surface}-agent-inventory.example.test`, 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const machine = createMachineFixture({ id: `${surface}-agent-machine`, active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        // Hold the Account definition corpus constant while measuring detection
        // demand; a separately arriving catalog legitimately changes the request.
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1,
            record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [] }) }, true);
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: Object.fromEntries(['review', 'other'].map(id => [id, {
            id, title: id, capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        }])) });
        const probed = new Set<string>();
        const latestVersionRequests: boolean[] = [];
        const vendorUpdates = createDeferred<void>();
        rpc.mockImplementation(async ({ method, payload }: { method: string; payload?: { requests?: { id: string; params?: { includeLoginStatus?: boolean; includeLatestVersion?: boolean } }[] } }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') latestVersionRequests.push(Boolean(payload?.requests?.some(request => request.params?.includeLatestVersion)));
            // The vendor release registry is a network boundary. The daemon
            // awaits it only when latest-version information is requested.
            if (method === 'capabilities.detect' && payload?.requests?.some(request => request.params?.includeLatestVersion)) {
                await vendorUpdates.promise;
            }
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: Object.fromEntries((payload?.requests ?? []).map(({ id, params }) => {
                if (id === 'tool.acpAgentInventory') return [id, { ok: true, checkedAt: 12, data: { items: [] } }];
                probed.add(id);
                // Mirrors cliSnapshot.ts: a login-status request also returns isLoggedIn/authStatus.
                const loginStatus = params?.includeLoginStatus ? { isLoggedIn: true, authStatus: { state: 'logged_in' as const, checkedAt: 12 } } : {};
                // agentCliUpdates.ts advertises update support but omits the
                // latest-version fact until that optional lookup was requested.
                const { latestVersion, ...readinessFacts } = item;
                return [id, { ok: true, checkedAt: 12, data: { ...readinessFacts, updateSupported: false,
                    ...(params?.includeLatestVersion ? { latestVersion } : {}), agentId: id.slice(4), ...loginStatus } }];
            })) };
            return { jobs: [] };
        });
        const initialProps: { agentId?: string } = surface === 'selected' ? { agentId: 'review' } : {};
        let renders = 0;
        const hook = await renderHook(({ agentId }: { agentId?: string }) => {
            if (++renders > 100) throw new Error('Selected Agent inventory did not settle within 100 renders');
            return surface === 'fleet'
                ? useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: true }).get(machine.id) ?? EMPTY_MACHINE_AGENTS
                : useMachineAgents({ serverId: server.id, machineId: machine.id, agentId });
        },
            { initialProps });
        try {
            await vi.waitFor(() => expect(isMachineAgentReady(hook.getCurrent().agents.find(agent => agent.agentId === 'review'))).toBe(true));
            expect(hook.getCurrent().agents.find(agent => agent.agentId === 'review')?.latestVersion).toBeNull();
            expect(probed).toEqual(new Set(surface === 'selected' ? ['cli.review'] : ['cli.review', 'cli.other']));
            if (surface === 'selected') {
                expect(network.requests.filter(({ method }) => method === 'capabilities.detect')).toEqual([
                    expect.objectContaining({ serverUrl: server.serverUrl, token: server.token, targetId: machine.id }),
                ]);
                await hook.rerender({});
            }
            await act(async () => vendorUpdates.resolve());
            await vi.waitFor(() => expect(isMachineAgentReady(hook.getCurrent().agents.find(agent => agent.agentId === 'other'))).toBe(true));
            expect(isMachineAgentReady(hook.getCurrent().agents.find(agent => agent.agentId === 'review'))).toBe(true);
            await vi.waitFor(() => expect(hook.getCurrent().agents.find(agent => agent.agentId === 'review')?.latestVersion).toBe('1'));
            expect(latestVersionRequests).toEqual(surface === 'selected' ? [false, false, true] : [false, true]);
            await hook.rerender({});
            expect(latestVersionRequests).toEqual(surface === 'selected' ? [false, false, true] : [false, true]);
        } finally { vendorUpdates.resolve(); await hook.unmount(); }
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
        publishMachineContributionRegistryProjectionInvalidation({ serverId: server.id, machineId: machine.id }, 'authority');
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
        let machine = createMachineFixture({ id: `freshness-${mode}-machine`, active: true, activeAt: Date.now(), daemonStateVersion: 1,
            daemonState: { status: 'running', runtimeId: 'unchanged-runtime', contributionRegistryProjectionRevision: 0 } });
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
        for (let wake = 0; wake < 12; wake++) await act(async () => {
            machine = { ...machine, seq: machine.seq + 1, updatedAt: machine.updatedAt + 1,
                metadataVersion: machine.metadataVersion + 1, daemonStateVersion: machine.daemonStateVersion + 1,
                metadata: { ...machine.metadata! }, daemonState: { ...machine.daemonState!, status: 'running' } };
            storage.getState().applyMachines([machine], false, { sourceServerId: server.id, sourceAccountId: scope.accountId });
            storage.getState().applyMachineActivityUpdates([{ id: machine.id, active: true, activeAt: Date.now() + wake }],
                { sourceServerId: server.id, sourceAccountId: scope.accountId });
        });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().agents[0]).toBe(readyAgent);
        expect(rpc.mock.calls.filter(([request]) => request.method === 'capabilities.detect')).toHaveLength(0);
        installed = false;
        await act(async () => publishMachineContributionRegistryProjectionInvalidation({ serverId: server.id, machineId: machine.id }, 'authority'));
        await vi.waitFor(() => expect(hook.getCurrent().agents[0]?.state).toBe('notInstalled'));
        await hook.unmount();
    });

    it.each(['detail', 'fleet'] as const)('applies install, uninstall and daemon restart pushes only to the changed Machine inventory (%s)', async mode => {
        const { getMachineContributionRegistryProjectionRevision } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
        const server = await network.addHome(`https://inventory-install-push-${mode}.test`, 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        let changed = createMachineFixture({ id: `${mode}-installed-machine`, active: true, activeAt: Date.now(), daemonStateVersion: 1,
            daemonState: { status: 'running', runtimeId: 'before-restart', contributionRegistryProjectionRevision: 0 } });
        const other = createMachineFixture({ id: `${mode}-unchanged-machine`, active: true, activeAt: Date.now(), daemonStateVersion: 1,
            daemonState: { status: 'running', runtimeId: 'other-runtime', contributionRegistryProjectionRevision: 0 } });
        storage.setState({ profileScope: scope });
        storage.getState().applyMachines([changed, other], true, { sourceServerId: server.id, sourceAccountId: scope.accountId });
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        let installed = false;
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: {
                'cli.review': { ok: true, checkedAt: Date.now(), data: { ...item, installed } },
            } };
            return { ok: true, jobs: [] };
        });
        for (const machine of [changed, other]) await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        // The transport fixture's missing catalog route leaves a stale Account
        // read. Hold that separate authority constant while measuring Machine pushes.
        expect(getAcpCatalogSnapshot(scope)).toMatchObject({ stale: true, catalog: { status: 'unavailable' } });
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: { v: 1, definitions: [] } }, true);
        const mountRequestsBefore = network.requests.length;
        const selected = await renderHook(() => mode === 'detail'
            ? useMachineAgents({ serverId: server.id, machineId: changed.id, agentId: 'review' })
            : useMachineAgentsByMachine({ serverId: server.id, machineIds: [changed.id, other.id], load: true }).get(changed.id) ?? EMPTY_MACHINE_AGENTS);
        let otherRenders = 0;
        let otherCommits = 0;
        const wrapper = ({ children }: PropsWithChildren) => createElement(Profiler,
            { id: 'unrelated-inventory', onRender: () => { otherCommits++; } }, children);
        const unrelated = await renderHook(() => {
            otherRenders++;
            return useMachineAgents({ serverId: server.id, machineId: other.id, agentId: 'review' });
        }, { wrapper });
        await vi.waitFor(() => expect(selected.getCurrent().status).toBe('ready'));
        await vi.waitFor(() => expect(unrelated.getCurrent().status).toBe('ready'));
        await vi.waitFor(() => expect(new Set(network.requests.slice(mountRequestsBefore)
            .filter(request => request.method === RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST).map(request => request.targetId)))
            .toEqual(new Set([changed.id, other.id])));
        // Commit the mounted demands' warm-cache answers before measuring a new arrival.
        await act(async () => {});
        const otherAgent = unrelated.getCurrent().agents[0];
        const otherSnapshot = unrelated.getCurrent();
        const rendersBefore = otherRenders;
        const commitsBefore = otherCommits;
        const otherPublications: string[] = [];
        const otherKey = serverAccountScopedResourceKey(scope, 'machine-agents', other.id);
        const stopOtherPublications = machineAgentInventoryStore.subscribe(otherKey, () => {
            otherPublications.push(machineAgentInventoryStore.read(otherKey).status);
        });
        const inventoryReads = vi.spyOn(machineAgentInventoryStore, 'read');
        rpc.mockClear();
        const requestsBefore = network.requests.length;
        try {
            for (const transition of ['install', 'uninstall', 'restart'] as const) {
                installed = transition !== 'uninstall';
                changed = { ...changed, daemonStateVersion: changed.daemonStateVersion + 1,
                    daemonState: { ...changed.daemonState!, runtimeId: transition === 'restart' ? 'after-restart' : 'before-restart',
                        contributionRegistryProjectionRevision: transition === 'install' ? 1 : transition === 'uninstall' ? 2 : 0 } };
                await act(async () => storage.getState().applyMachines([changed], false,
                    { sourceServerId: server.id, sourceAccountId: scope.accountId }));
                expect(getMachineContributionRegistryProjectionRevision({ serverId: server.id, machineId: changed.id })).toBe(
                    transition === 'install' ? 1 : transition === 'uninstall' ? 2 : 3);
                await vi.waitFor(() => {
                    expect(selected.getCurrent()).toMatchObject({ status: 'ready', agents: [{ installed, stale: false }] });
                    expect(isAgentSelectableForNewSession({ agentId: 'review', machineAgentsById: {
                        review: selected.getCurrent().agents[0],
                    } })).toBe(installed);
                    expect(resolveMachineAgentPickerPlacement(selected.getCurrent().agents[0] ?? null).group).toBe(installed ? 'onMachine' : 'notOnMachine');
                });
                expect(unrelated.getCurrent()).toBe(otherSnapshot);
                expect(unrelated.getCurrent().agents[0]).toBe(otherAgent);
                expect.soft(network.requests.slice(requestsBefore).filter(request => request.targetId === other.id)).toHaveLength(0);
                expect(otherRenders, JSON.stringify({ otherCommits, commitsBefore, transition, otherPublications,
                    otherReads: inventoryReads.mock.calls.filter(([key]) => key === otherKey).length })).toBe(rendersBefore);
                expect(storage.getState().machineListByServerId[server.id]?.find(machine => machine.id === other.id)).toBe(other);
            }
        } finally {
            inventoryReads.mockRestore();
            stopOtherPublications();
            await selected.unmount();
            await unrelated.unmount();
        }
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
        publishMachineContributionRegistryProjectionInvalidation({ serverId: server.id, machineId: machine.id }, 'authority');
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        const hook = await renderHook(() => useMachineAgents({ serverId: server.id, machineId: machine.id, load: false }));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'error', lastCheckedAt: 12,
            agents: [{ title: 'Current review descriptor', installed: true, stale: true }] }));
        expect(isMachineAgentReady(hook.getCurrent().agents[0])).toBe(false);
        await hook.unmount();
    });

    it('uses each Machine’s own authentication modes and keeps unanswered or internally conflicted Machines unknown', async () => {
        const server = await network.addHome('https://passive-auth-inventory.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: 'passive-auth-machine', active: true, activeAt: Date.now(), daemonStateVersion: 1 });
        const otherMachine = { ...machine, id: 'older-auth-machine' };
        const unansweredMachine = { ...machine, id: 'unanswered-auth-machine' };
        const conflictedMachine = { ...machine, id: 'conflicted-auth-machine' };
        const service = { pluginId: 'acme.review', localId: 'account' };
        storage.setState({ machineListByServerId: { [server.id]: [machine, otherMachine, unansweredMachine, conflictedMachine] }, profileScope: scope, profile: {
            ...storage.getState().profile,
            connectedAccountsV4: [{ ref: { service, accountId: 'work' }, revisionSemantics: 'revisioned', credentialRevision: 'revision-1',
                status: 'connected', kind: 'oauth', authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null,
                displayName: 'Work account', scopes: [] }],
        } });
        const descriptor = {
            id: 'account', serviceId: 'account', pluginId: service.pluginId, title: 'Review account', provenance: 'external', sourceKind: 'installed',
            authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'providerCheck' }] },
            capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
        } satisfies NonNullable<PluginProjectionV2['familiesById']['connectedAccounts']>['entriesById'][string];
        const otherDescriptor = { ...descriptor, authentication: { defaultModeId: 'older-oauth',
            modes: [{ ...descriptor.authentication.modes[0], id: 'older-oauth' }] } };
        const { mergeConnectedAccountDescriptorProjections } = await import('@/sync/domains/connectedServices/connectedAccountDescriptorProjection');
        const { getConnectedServiceRegistrySnapshot } = await import('@/sync/domains/connectedServices/connectedServiceRegistry');
        const accountUnion = mergeConnectedAccountDescriptorProjections([
            { kind: 'ready', descriptors: [descriptor] }, { kind: 'ready', descriptors: [otherDescriptor] },
        ]);
        expect(accountUnion.kind).toBe('conflict');
        if (accountUnion.kind === 'error') throw new Error('Expected answering Machines');
        installConnectedAccountDescriptorProjection({ scopeKey: server.id, status: accountUnion.kind, conflicts: accountUnion.conflicts,
            errorReason: null, descriptors: accountUnion.descriptors }, accountLifetime);
        primeServerFeaturesSnapshot({ serverId: server.id, snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({
            features: {}, capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } },
        }) } });
        const projection = PluginProjectionV2Schema.parse({
            ...emptyProjection,
            familiesById: { connectedAccounts: { family: 'connectedAccounts', entriesById: { 'acme.review/account': descriptor } } },
            agentsById: {
                review: {
                    id: 'review', identity: { pluginId: 'acme.review', localId: 'review' }, title: 'Review',
                    connectedAccounts: [{ purpose: 'primary', service, credentialKinds: ['oauth'] }],
                    capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
                },
            },
        });
        for (const [target, descriptors] of [
            // Equal publications collapse; duplicate facts are not an internal conflict.
            [machine, [descriptor, descriptor]], [otherMachine, [otherDescriptor]],
            [conflictedMachine, [descriptor, otherDescriptor]],
        ] as const) {
            rpc.mockResolvedValue({ protocolVersion: 1, projection: { ...projection, familiesById: { connectedAccounts: {
                family: 'connectedAccounts', entriesById: Object.fromEntries(descriptors.map((value, index) => [String(index), value])),
            } } } });
            await loadDaemonMergedProjectionInputs({ sections: 'complete', serverId: server.id, machineId: target.id, accountLifetime });
        }
        for (const target of [machine, otherMachine, unansweredMachine, conflictedMachine]) {
            machineAgentInventoryStore.publish(serverAccountScopedResourceKey(scope, 'machine-agents', target.id), {
                status: 'ready', items: [{ ...item, signIn: { status: 'signedOut', loginSupport: 'login_terminal' } }], lastCheckedAt: 12,
            });
        }
        rpc.mockClear();
        try {
            applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'ready', revision: 1,
                record: { key: 'purposes', value: { v: 1, bindings: [] } } }, true);
            const { projectMachineAgentForCredential } = await import('./machineAgentModel');
            const credentialBindings = { v: 2 as const, bindingsByServiceId: {
                'acme.review/account': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
            } };
            const hook = await renderHook(({ machineId }) => useMachineAgents({ serverId: server.id, machineId, load: false }),
                { initialProps: { machineId: machine.id } });
            const selected = () => projectMachineAgentForCredential(hook.getCurrent().agents[0]!, { credentialBindings });
            await vi.waitFor(() => expect(selected()).toMatchObject({ state: 'ready', signIn: {
                status: 'signedIn', via: { kind: 'connected', profileLabel: 'Work account' },
            } }));
            expect(isMachineAgentReady(selected())).toBe(true);
            await hook.rerender({ machineId: otherMachine.id });
            await vi.waitFor(() => expect(selected()).toMatchObject({ state: 'needsSignIn', signIn: { status: 'signedOut' } }));
            for (const target of [unansweredMachine, conflictedMachine]) {
                await hook.rerender({ machineId: target.id });
                await vi.waitFor(() => expect(selected()).toMatchObject({ state: 'unknown', signIn: { status: 'unknown' } }));
                expect(isMachineAgentReady(selected())).toBe(false);
            }
            const registry = getConnectedServiceRegistrySnapshot();
            expect(registry.status).toBe('conflict');
            expect(registry.entries.find(entry => entry.service?.pluginId === service.pluginId
                && entry.service.localId === service.localId)).toMatchObject({ executable: false, projectionStatus: 'conflict',
                projectedDescriptorCandidates: expect.arrayContaining([descriptor, otherDescriptor]) });
            await hook.rerender({ machineId: machine.id });
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

    it('reports the Agents collection as detecting until the first read of the Machine inventory settles', async () => {
        const { useAgentCollection } = await import('@/components/settings/agents/collection/AgentCollectionList');
        const server = await network.addHome('https://detecting-inventory.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const machine = createMachineFixture({ id: 'detecting-machine', active: true, activeAt: Date.now(), daemonStateVersion: 1 });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const projection = createDeferred<unknown>();
        rpc.mockImplementation(async ({ method }: { method: string }) => method.includes('contributionRegistryProjection.describe')
            ? { protocolVersion: 1, projection: await projection.promise } : { jobs: [] });
        const hook = await renderHook(() => useAgentCollection({ executionTarget: { serverId: server.id, machine }, agentEntries: [] } as never, ''));
        try {
            // No read has said which agents this Machine has, so a surface holds the places of what will arrive.
            expect(hook.getCurrent().detecting).toBe(true);
            await act(async () => { projection.resolve(emptyProjection); });
            await vi.waitFor(() => expect(hook.getCurrent().detecting).toBe(false));
        } finally { projection.resolve(emptyProjection); await hook.unmount(); }
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
