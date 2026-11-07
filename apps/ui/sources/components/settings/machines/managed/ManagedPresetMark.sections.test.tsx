import * as React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { buildDeferredDaemonProjectionSections, DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

// The daemon RPC behind the real network boundary is the only substitute; the projection
// loader, its section reader and the provisioner presentation stay real.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { storage } = await import('@/sync/domains/state/storage');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { ManagedPresetMark } = await import('./useManagedProvisionerPresentation');
afterAll(async () => { await network.dispose(); });

// A catalogue with sections a mark never reads: Actions and Agents.
const projection = {
    v: 2 as const, generation: 3,
    installedPackagesById: { 'acme.compute': { id: 'acme.compute', displayName: 'Compute', version: '1.0.0', enabled: true,
        source: { kind: 'path' as const, locator: '/plugins/acme.compute' } } },
    actionsById: { 'acme.compute/repair': { id: 'acme.compute/repair', pluginId: 'acme.compute', occurrenceId: 'occurrence-a', title: 'Repair',
        scopes: ['global'], surfaces: ['agent'], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true } },
    agentsById: { 'acme.compute/agent': { id: 'acme.compute/agent', identity: { pluginId: 'acme.compute', localId: 'agent' }, title: 'Agent' } },
    familiesById: {},
};

// A bundled package with no artwork of its own (most bundled provisioners today).
const bundledWithoutArt = { ...projection, installedPackagesById: { 'acme.compute': {
    ...projection.installedPackagesById['acme.compute'], source: { kind: 'bundled' as const, locator: 'bundled:acme.compute' } } } };
let activeProjection: unknown = projection;

describe('ManagedPresetMark projection demand', () => {
    let serverId: string;
    const sectionsRead = new Set<string>();
    let manifestReads = 0;

    beforeEach(async () => {
        network.resetRequests();
        storage.setState(storage.getInitialState(), true);
        sectionsRead.clear();
        manifestReads = 0;
        activeProjection = projection;
        network.setHttpResponder(async (input) => new URL(String(input)).pathname === '/v1/account/encryption'
            ? Response.json({ mode: 'plain', updatedAt: 1 }) : null);
        const home = await network.addHome('https://preset-mark-sections.example.test', 'account-a');
        serverId = home.id;
        network.setRpcAckResponder(async (request) => {
            if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            }
            const deferred = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
                protocolVersion: 1, projection: activeProjection, projectionDigest: 'd'.repeat(64) }));
            const sectionByIndexDigest = new Map(Object.entries(deferred.manifest.sections).map(([section, digest]) => [digest, section]));
            const read = (request.payload as Readonly<{ sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>).sectionRead;
            if (!read) { manifestReads += 1; return { ok: true, result: deferred.manifest }; }
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

    it("hydrates only the provisioner family a preset's mark reads, never the presentation's Actions or translations", async () => {
        const preset = {
            launch: { provider: { pluginId: 'acme.compute', localId: 'native' }, schemaVersion: 1, name: 'box', choices: {} },
            // The Home's own listed Machine (the network boundary's `machine-1`) controls the preset.
            controller: { machineId: 'machine-1', installationId: 'test-installation' },
        } as never;
        const screen = await renderScreen(<ManagedPresetMark serverId={serverId} preset={preset} size={17} />);
        try {
            await vi.waitFor(() => expect(manifestReads).toBe(1), { timeout: 10_000 });
            // Section reads follow the manifest in-process; give the loader time to issue every read it would.
            // The mark reads the provisioner descriptor and the installed package (delivered with the manifest).
            await new Promise(resolve => setTimeout(resolve, 300));
            expect(sectionsRead.has('actionsById')).toBe(false);
            expect(sectionsRead.has('agentsById')).toBe(false);
        } finally { await screen.unmount(); }
    });

    it('draws the descriptor glyph, never a letter from the package name, when a bundled package has no artwork', async () => {
        const preset = {
            launch: { provider: { pluginId: 'acme.compute', localId: 'native' }, schemaVersion: 1, name: 'box', choices: {} },
            controller: { machineId: 'machine-1', installationId: 'test-installation' },
        } as never;
        activeProjection = bundledWithoutArt;
        const screen = await renderScreen(<ManagedPresetMark serverId={serverId} preset={preset} size={17} />);
        try {
            await vi.waitFor(() => expect(manifestReads).toBe(1), { timeout: 10_000 });
            await vi.waitFor(() => expect(screen.tree.findAll(node => node.props.name === 'puzzle-piece').length).toBeGreaterThan(0), { timeout: 10_000 });
            expect(screen.getTextContent()).not.toContain('C');
        } finally { await screen.unmount(); }
    });
});
