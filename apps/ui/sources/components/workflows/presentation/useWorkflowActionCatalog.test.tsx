import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { buildDeferredDaemonProjectionSections, demandedDaemonProjectionSections,
    DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

// The daemon RPC behind the real network boundary is the only substitute; Sync, the
// projection loader, its section reader and the catalog hook stay real.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { PLUGIN_UI_SECTIONS } = await import('@/sync/domains/plugins/ui/projectionSections');
const { storage } = await import('@/sync/domains/state/storage');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { useWorkflowActionCatalog } = await import('./useWorkflowActionCatalog');
afterAll(async () => { await network.dispose(); });

const projection = {
    v: 2 as const, generation: 3,
    installedPackagesById: { 'acme.deploy': { id: 'acme.deploy', displayName: 'Deploy', version: '1.0.0', enabled: true,
        source: { kind: 'path' as const, locator: '/plugins/acme.deploy' } } },
    actionsById: { 'acme.deploy/ship': { id: 'acme.deploy/ship', pluginId: 'acme.deploy', occurrenceId: 'occurrence-a', title: 'Ship it',
        scopes: ['global'], surfaces: ['agent'], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true } },
    agentsById: { 'acme.deploy/agent': { id: 'acme.deploy/agent', identity: { pluginId: 'acme.deploy', localId: 'agent' }, title: 'Agent' } },
    familiesById: {},
};

describe('useWorkflowActionCatalog', () => {
    let serverId: string;
    const sectionsRead = new Set<string>();
    let deferred: ReturnType<typeof buildDeferredDaemonProjectionSections>;

    beforeEach(async () => {
        network.resetRequests();
        storage.setState(storage.getInitialState(), true);
        sectionsRead.clear();
        deferred = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projection, projectionDigest: 'b'.repeat(64) }));
        const sectionByIndexDigest = new Map(Object.entries(deferred.manifest.sections).map(([section, digest]) => [digest, section]));
        network.setHttpResponder(async (input) => new URL(String(input)).pathname === '/v1/account/encryption'
            ? Response.json({ mode: 'plain', updatedAt: 1 }) : null);
        const home = await network.addHome('https://workflow-action-catalog.example.test', 'account-a');
        serverId = home.id;
        network.setRpcAckResponder(async (request) => {
            if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            }
            const read = (request.payload as Readonly<{ sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>).sectionRead;
            if (!read) return { ok: true, result: deferred.manifest };
            for (const digest of [read.digest, ...read.includeDigests ?? []]) {
                const section = sectionByIndexDigest.get(digest);
                if (section) sectionsRead.add(section);
            }
            return { ok: true, result: deferred.read(read.digest, read.offset, read.includeDigests) };
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

    it('offers the Machine\'s plugin Actions while hydrating only the plugin UI sections, not the whole catalogue', async () => {
        const hook = await renderHook(() => useWorkflowActionCatalog({ kind: 'machine', machineId: 'machine-1', serverId }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().specs.some(spec => spec.plugin?.id === 'acme.deploy')).toBe(true));
            expect([...sectionsRead].sort()).toEqual([...demandedDaemonProjectionSections(deferred.manifest, PLUGIN_UI_SECTIONS)].sort());
            expect(sectionsRead.has('agentsById')).toBe(false);
        } finally { await hook.unmount(); }
    });
});
