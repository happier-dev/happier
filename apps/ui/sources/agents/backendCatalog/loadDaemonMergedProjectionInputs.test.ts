import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineProtocolNumber, defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createMachineFixture } from '@/dev/testkit';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { createSocketIoAckTimeoutError } from '@happier-dev/sync-client';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

let network: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>>;
let storage: typeof import('@/sync/domains/state/storage').storage;
let getMachineContributionRegistryProjectionRevision: typeof import('@/sync/ops/machineContributionRegistryProjectionRevision').getMachineContributionRegistryProjectionRevision;
let publishMachineContributionRegistryProjectionInvalidation: typeof import('@/sync/ops/machineContributionRegistryProjectionRevision').publishMachineContributionRegistryProjectionInvalidation;
let clearDaemonMergedProjectionCacheForTests: typeof import('./loadDaemonMergedProjectionInputs').clearDaemonMergedProjectionCacheForTests;
let activeAccountRestored = false;
let initialRevision = 0;
const projectionScope = { machineId: 'machine-1', serverId: 'server-1' };

// Localization is a platform boundary; projection and descriptor logic stay real.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const projectionDescribeMock = vi.hoisted(() => vi.fn());
const homeIds = new Map<string, string>();

function daemonProjection(generation: number) {
    return {
        v: 2 as const,
        generation,
        installedPackagesById: {},
        agentsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {},
        diagnostics: [],
    };
}

function createAccountLifetime(accountId: string, serverId = 'server-1'): Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    retire(): void;
}> {
    let current = true;
    const retireCallbacks = new Set<() => void>();
    const lifetime: ActiveServerAccountScopeLifetime = Object.freeze({
        scope: Object.freeze({ serverId, accountId }),
        isCurrent: () => current,
        onRetire: (cancel) => {
            if (!current) {
                cancel();
                return Object.freeze({ dispose: () => {} });
            }
            retireCallbacks.add(cancel);
            return Object.freeze({
                dispose: () => retireCallbacks.delete(cancel),
            });
        },
    });
    return Object.freeze({
        lifetime,
        retire: () => {
            if (!current) return;
            current = false;
            const callbacks = [...retireCallbacks];
            retireCallbacks.clear();
            for (const callback of callbacks) callback();
        },
    });
}

const retainedTestAccountLifetime = createAccountLifetime('account-default').lifetime;

const EMPTY_TARGET_INPUT_SCHEMA = defineProtocolObject({}, { policy: 'closed' }).jsonSchema;
const REVIEW_ID_TARGET_INPUT_SCHEMA = defineProtocolObject(
    { reviewId: defineProtocolString() },
    { policy: 'closed' },
).jsonSchema;
const NUMERIC_REVIEW_ID_TARGET_INPUT_SCHEMA = defineProtocolObject(
    { reviewId: defineProtocolNumber() },
    { policy: 'closed' },
).jsonSchema;

const automationEligibleEvents = [{
    event: {
        id: 'acme.events/repository/updated',
        identity: { pluginId: 'acme.events', localId: 'repository/updated' },
        occurrenceId: 'event-generation-a',
        title: 'Repository updated',
        description: null,
        payloadSchema: { type: 'object', additionalProperties: false },
        automation: {
            v: 1 as const,
            eligible: true as const,
            source: {
                sourceContractVersion: 1,
                supportedObservationTransports: ['checkpointedPull' as const],
                sourceConfigSchema: { type: 'object', additionalProperties: false },
                setupActionRef: { pluginId: 'acme.events', localId: 'configure-source' },
            },
        },
    },
    setupAction: {
        id: 'acme.events/configure-source',
        identity: { pluginId: 'acme.events', localId: 'configure-source' },
        occurrenceId: 'event-generation-a',
        title: 'Configure source',
        description: null,
        inputSchema: { type: 'object', additionalProperties: false },
        inputHints: null,
    },
}] as const;

const composerSurfaceCatalog = [{
    contribution: { pluginId: 'acme.composer', localId: 'review-region' },
    occurrenceId: 'composer-generation-a',
    projectionGeneration: 7,
    role: 'region' as const,
    rendererChain: [{ pluginId: 'acme.composer', localId: 'review-region-renderer' }],
    selectedRenderer: {
        identity: { pluginId: 'acme.composer', localId: 'review-region-renderer' },
        renderer: {
            kind: 'declarative' as const,
            contributionId: 'review-region-renderer',
            model: { visible: true },
        },
        availability: { state: 'available' as const, reason: 'available', diagnostics: [] },
    },
    executionOrigin: {
        serverIdentityId: 'srv_composer',
        materializationRef: {
            machineId: 'machine-1',
            materializationId: 'composer-materialization',
            pluginId: 'acme.composer',
        },
    },
    resourceCapability: { readable: true, dynamic: true },
    contributorTargetedContributions: {
        target: { pluginId: 'acme.composer', occurrenceId: 'composer-generation-a' },
        points: [],
    },
}] as const;

describe('loadDaemonMergedProjectionCacheEntry', () => {
    beforeEach(async () => {
        vi.resetModules();
        activeAccountRestored = false;
        projectionDescribeMock.mockReset();
        network = await installSessionOpsNetworkBoundary();
        const home = await network.addHome('https://server-1', 'account-a');
        expect(home.id).toBe('server-1');
        homeIds.clear();
        homeIds.set(home.serverUrl, home.id);
        network.setRpcAckResponder(async (request) => {
            if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            }
            const response = await projectionDescribeMock(request.targetId, { serverId: homeIds.get(request.serverUrl) });
            if (response.supported !== true) {
                if (response.reason === 'not-supported') return { ok: false, error: 'Unsupported projection', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
                if (response.reason === 'timeout') throw createSocketIoAckTimeoutError();
                throw new Error('Projection transport unavailable');
            }
            const { supported: _supported, ...envelope } = response;
            return { ok: true, result: { protocolVersion: 1, ...envelope } };
        });
        ({ storage } = await import('@/sync/domains/state/storage'));
        ({ getMachineContributionRegistryProjectionRevision, publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision'));
        ({ clearDaemonMergedProjectionCacheForTests } = await import('./loadDaemonMergedProjectionInputs'));
        initialRevision = getMachineContributionRegistryProjectionRevision(projectionScope);
        clearDaemonMergedProjectionCacheForTests();
        const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
        registerStorageStateReader(() => storage.getState());
    });
    afterEach(async () => {
        if (activeAccountRestored) {
            const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
            await disconnectActiveServerConnection();
        }
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        network.dispose();
    });

    it('publishes a background Home descriptor under its Account and retires only that Home when its request lifetime retires', async () => {
        const { resolveAgentUiBehavior } = await import('@/agents/registry/registryUiBehavior');
        const { loadDaemonMergedProjectionCacheEntry, readCachedDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const homeA = await network.addHome('https://projection-a.example.test', 'account-a');
        const homeB = await network.addHome('https://projection-b.example.test', 'account-b');
        homeIds.set(homeA.serverUrl, homeA.id);
        homeIds.set(homeB.serverUrl, homeB.id);
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await loadSyncSingletonForTests();
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await upsertAndActivateServer({ serverUrl: homeA.serverUrl });
        await restoreConnectionToActiveServer({ token: homeA.token });
        activeAccountRestored = true;
        const scopeA = { serverId: homeA.id, accountId: 'account-a' };
        const scopeB = { serverId: homeB.id, accountId: 'account-b' };
        const lifetimeA = createAccountLifetime(scopeA.accountId, homeA.id);
        const lifetimeB = createAccountLifetime(scopeB.accountId, homeB.id);
        const projectionForHome = (serverId: string) => ({
            supported: true,
            projection: {
                ...daemonProjection(1),
                agentsById: {
                    'acme.agent': {
                        id: 'acme.agent', identity: { pluginId: 'acme', localId: 'agent' },
                        title: 'Acme', channel: 'plugin', providerOwnedEnvironmentKeys: [],
                        ui: { behavior: { permissions: { footer: {
                            usePermissionUpdates: serverId === homeB.id,
                            stopHandling: 'denyOnly',
                        } } } },
                    },
                },
            },
        });
        projectionDescribeMock.mockImplementation(async (_machineId, options) => projectionForHome(options.serverId));
        await loadDaemonMergedProjectionCacheEntry({ machineId: 'shared-machine', serverId: homeA.id, accountLifetime: lifetimeA.lifetime });
        await loadDaemonMergedProjectionCacheEntry({ machineId: 'shared-machine', serverId: homeB.id, accountLifetime: lifetimeB.lifetime });
        const { parseToken } = await import('@/utils/auth/parseToken');
        expect(network.requests.filter((request) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
            .map(({ serverUrl, token }) => [serverUrl, token ? parseToken(token) : null])).toEqual([
            [homeA.serverUrl, 'account-a'], [homeB.serverUrl, 'account-b'],
        ]);
        expect(resolveAgentUiBehavior('acme.agent', 'shared-machine', scopeB).permissions?.footer?.usePermissionUpdates).toBe(true);
        expect(resolveAgentUiBehavior('acme.agent', 'shared-machine').permissions?.footer?.usePermissionUpdates).toBe(false);
        expect(resolveAgentUiBehavior('acme.agent', 'shared-machine', scopeA).permissions?.footer?.stopHandling).toBe('denyOnly');

        let complete!: (value: ReturnType<typeof projectionForHome>) => void;
        projectionDescribeMock.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
        const pending = loadDaemonMergedProjectionCacheEntry({ machineId: 'shared-machine', serverId: homeB.id, accountLifetime: lifetimeB.lifetime });
        await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
        lifetimeB.retire();
        complete(projectionForHome(homeB.id));
        await expect(pending).resolves.toBeNull();
        expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'shared-machine', serverId: homeB.id })).toBeNull();
        expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'shared-machine', serverId: homeA.id })?.kind).toBe('ready');
        expect(resolveAgentUiBehavior('acme.agent', 'shared-machine', scopeB).permissions?.footer?.usePermissionUpdates).toBe(false);
        expect(resolveAgentUiBehavior('acme.agent', 'shared-machine', scopeA).permissions?.footer?.stopHandling).toBe('denyOnly');
    });

    it('retains the last ready projection as inert cached metadata after a transport error', async () => {
        projectionDescribeMock
            .mockResolvedValueOnce({
                supported: true,
                projection: daemonProjection(7),
            })
            .mockResolvedValueOnce({
                supported: false,
                reason: 'error',
            });
        const {
            loadDaemonMergedProjectionCacheEntry,
            readCachedDaemonMergedProjectionCacheEntry,
        } = await import('./loadDaemonMergedProjectionInputs');

        await loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
        });
        await loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
        });

        expect(readCachedDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
        })).toMatchObject({
            kind: 'error',
            reason: 'error',
            inputs: {
                pluginProjectionV2: {
                    generation: 7,
                },
            },
        });
    });

    it('carries the daemon-selected Composer surface catalog through the canonical merged inputs', async () => {
        projectionDescribeMock.mockResolvedValueOnce({
            supported: true,
            projection: daemonProjection(7),
            composerSurfaceCatalog,
        });
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');

        await expect(loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
        })).resolves.toMatchObject({
            kind: 'ready',
            inputs: { composerSurfaceCatalog },
        });
    });

    it('is the one per-machine owner: readers share one describe per projection revision', async () => {
        let resolveDescribe!: (value: unknown) => void;
        projectionDescribeMock.mockImplementationOnce(async () => await new Promise((resolve) => {
            resolveDescribe = resolve;
        }));
        const {
            loadDaemonMergedProjectionCacheEntry,
            loadDaemonMergedProjectionInputs,
        } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');

        // The AppShell reader and a direct caller ask the same question at once.
        const shellRead = loadDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId: 'server-1', accountLifetime: account.lifetime });
        const directRead = loadDaemonMergedProjectionInputs({ machineId: 'machine-1', serverId: 'server-1', accountLifetime: account.lifetime });
        await vi.waitFor(() => expect(projectionDescribeMock).toHaveBeenCalledTimes(1));
        resolveDescribe({ supported: true, projection: daemonProjection(7) });
        await expect(shellRead).resolves.toMatchObject({ kind: 'ready' });
        await expect(directRead).resolves.toMatchObject({ pluginProjectionV2: { generation: 7 } });

        // A later direct caller reuses the current revision's answer…
        await expect(loadDaemonMergedProjectionInputs({ machineId: 'machine-1', serverId: 'server-1', accountLifetime: account.lifetime }))
            .resolves.toMatchObject({ pluginProjectionV2: { generation: 7 } });
        expect(projectionDescribeMock).toHaveBeenCalledTimes(1);

        // …until the machine's projection revision advances.
        publishMachineContributionRegistryProjectionInvalidation(projectionScope);
        projectionDescribeMock.mockResolvedValueOnce({ supported: true, projection: daemonProjection(8) });
        await expect(loadDaemonMergedProjectionInputs({ machineId: 'machine-1', serverId: 'server-1', accountLifetime: account.lifetime }))
            .resolves.toMatchObject({ pluginProjectionV2: { generation: 8 } });
        expect(projectionDescribeMock).toHaveBeenCalledTimes(2);
        // The owner never asks the transport for a caller-chosen deadline.
        for (const call of projectionDescribeMock.mock.calls) {
            expect(call[1]).not.toHaveProperty('timeoutMs');
            expect(call[1]).not.toHaveProperty('requestEpoch');
        }
    });

    it('reuses a settled describe for another reader of the same Account until the projection changes', async () => {
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const { storage } = await import('@/sync/domains/state/storage');
        const previousMachines = storage.getState().machines;
        storage.setState({ machines: { ...previousMachines, 'machine-1': createMachineFixture({ id: 'machine-1', daemonStateVersion: 1 }) } });
        const firstAccount = createAccountLifetime('account-a');
        const sameAccount = createAccountLifetime('account-a');
        const nextAccount = createAccountLifetime('account-b');
        projectionDescribeMock
            .mockResolvedValueOnce({ supported: true, projection: daemonProjection(7) })
            .mockResolvedValueOnce({ supported: true, projection: daemonProjection(8) })
            .mockResolvedValueOnce({ supported: true, projection: daemonProjection(9) })
            .mockResolvedValueOnce({ supported: true, projection: daemonProjection(10) });

        const read = (accountLifetime: ActiveServerAccountScopeLifetime) => loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1', serverId: 'server-1', accountLifetime, reuseFreshReady: true,
        });
        try {
            await expect(read(firstAccount.lifetime)).resolves.toMatchObject({ kind: 'ready' });
            await expect(read(sameAccount.lifetime)).resolves.toMatchObject({ kind: 'ready' });
            expect(projectionDescribeMock).toHaveBeenCalledTimes(1);

            network.setAccount('https://server-1', 'account-b');
            await expect(read(nextAccount.lifetime)).resolves.toMatchObject({
                kind: 'ready', inputs: { pluginProjectionV2: { generation: 8 } },
            });
            expect(projectionDescribeMock).toHaveBeenCalledTimes(2);

            storage.setState({ machines: { ...storage.getState().machines, 'machine-1': createMachineFixture({ id: 'machine-1', daemonStateVersion: 2 }) } });
            await expect(read(nextAccount.lifetime)).resolves.toMatchObject({
                kind: 'ready', inputs: { pluginProjectionV2: { generation: 9 } },
            });
            expect(projectionDescribeMock).toHaveBeenCalledTimes(3);

            publishMachineContributionRegistryProjectionInvalidation(projectionScope);
            await expect(read(nextAccount.lifetime)).resolves.toMatchObject({
                kind: 'ready', inputs: { pluginProjectionV2: { generation: 10 } },
            });
            expect(projectionDescribeMock).toHaveBeenCalledTimes(4);
        } finally {
            storage.setState({ machines: previousMachines });
        }
    });

    it('does not reuse a pre-inventory describe after the first daemon state is observed', async () => {
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const { storage } = await import('@/sync/domains/state/storage');
        const previousMachines = storage.getState().machines;
        const account = createAccountLifetime('account-a');
        const read = () => loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1', serverId: 'server-1', accountLifetime: account.lifetime, reuseFreshReady: true,
        });
        storage.setState({ machines: Object.fromEntries(Object.entries(previousMachines).filter(([id]) => id !== 'machine-1')) });
        try {
            projectionDescribeMock.mockResolvedValue({ supported: true, projection: daemonProjection(7) });
            await expect(read()).resolves.toMatchObject({ kind: 'ready' });
            storage.setState({ machines: { ...storage.getState().machines, 'machine-1': createMachineFixture({ id: 'machine-1', daemonStateVersion: 1 }) } });
            await expect(read()).resolves.toMatchObject({ kind: 'ready' });
            expect(projectionDescribeMock).toHaveBeenCalledTimes(2);
        } finally {
            storage.setState({ machines: previousMachines });
        }
    });

    it('shares one describe between every reader of one Account, never with a successor Account', async () => {
        // Each mounted reader holds its own lifetime handle for the same routed
        // Account (one per credential-scope hook). They ask the same question.
        const pending: Array<(value: unknown) => void> = [];
        projectionDescribeMock.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
        const {
            loadDaemonMergedProjectionCacheEntry,
            readCachedDaemonMergedProjectionCacheEntry,
        } = await import('./loadDaemonMergedProjectionInputs');
        const shell = createAccountLifetime('account-a');
        const palette = createAccountLifetime('account-a');
        const surface = createAccountLifetime('account-a');
        const successor = createAccountLifetime('account-b');

        const reads = [shell, palette, surface].map((reader) => loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
            accountLifetime: reader.lifetime,
        }));
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        network.setAccount('https://server-1', 'account-b');
        const successorRead = loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
            accountLifetime: successor.lifetime,
        });
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        expect(projectionDescribeMock).toHaveBeenCalledTimes(2);

        // The reader that issued the shared describe leaves before it answers:
        // the others still get the answer, published under a current lifetime.
        shell.retire();
        pending[0]!({ supported: true, projection: daemonProjection(7) });
        await expect(reads[0]).resolves.toBeNull();
        await expect(reads[1]).resolves.toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 7 } } });
        await expect(reads[2]).resolves.toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 7 } } });
        // The published answer outlives the departed reader's lifetime.
        expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId: 'server-1' }))
            .toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 7 } } });
        pending[1]!({ supported: true, projection: daemonProjection(8) });
        await expect(successorRead).resolves.toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 8 } } });
    });

    it('settles every read with the answer it got while newer revisions keep arriving', async () => {
        // A daemon whose state keeps advancing while each describe is slow:
        // every read must still settle with its own answer (tagged with its
        // revision) instead of waiting on the next, newer read.
        const pending: Array<(value: unknown) => void> = [];
        projectionDescribeMock.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');

        const first = loadDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId: 'server-1' });
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        publishMachineContributionRegistryProjectionInvalidation(projectionScope);
        const second = loadDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId: 'server-1' });
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        publishMachineContributionRegistryProjectionInvalidation(projectionScope);

        pending[0]!({ supported: true, projection: daemonProjection(1) });
        await expect(first).resolves.toMatchObject({
            kind: 'ready',
            projectionRevision: initialRevision,
            inputs: { pluginProjectionV2: { generation: 1 } },
        });

        pending[1]!({ supported: true, projection: daemonProjection(2) });
        await expect(second).resolves.toMatchObject({
            kind: 'ready',
            projectionRevision: initialRevision + 1,
            inputs: { pluginProjectionV2: { generation: 2 } },
        });
        // A late answer never replaces a newer one already published.
        const { readCachedDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId: 'server-1' }))
            .toMatchObject({ projectionRevision: initialRevision + 1 });
    });

    it('keeps the classified reason of a failed read with the last good inputs', async () => {
        projectionDescribeMock
            .mockResolvedValueOnce({ supported: true, projection: daemonProjection(3) })
            .mockResolvedValueOnce({ supported: false, reason: 'timeout' });
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');

        await loadDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId: 'server-1' });
        await expect(loadDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId: 'server-1' }))
            .resolves.toMatchObject({
                kind: 'error',
                reason: 'timeout',
                inputs: { pluginProjectionV2: { generation: 3 } },
            });
    });

    describe('retained admission custody around a machine answer', () => {
        beforeEach(() => { network.setAccount('https://server-1', 'account-default'); });
        const CUSTODY_TARGET = {
            pluginId: 'acme.preview',
            occurrenceId: 'target-generation-a',
        } as const;
        const CUSTODY_IMMUTABLE_GENERATION_ID = 'preview-artifact-generation-7';

        function custodyProjection(generation: number) {
            return {
                ...daemonProjection(generation),
                installedPackagesById: {
                    [CUSTODY_TARGET.pluginId]: {
                        id: CUSTODY_TARGET.pluginId,
                        displayName: 'Acme preview',
                        version: '1.0.0',
                        enabled: true,
                        source: { kind: 'bundled', locator: CUSTODY_TARGET.pluginId },
                        immutableGenerationId: CUSTODY_IMMUTABLE_GENERATION_ID,
                        brand: { state: 'missing' },
                    },
                },
                familiesById: {
                    pluginUi: {
                        family: 'pluginUi',
                        entriesById: {
                            [`translations:${CUSTODY_TARGET.pluginId}`]: {
                                id: `translations:${CUSTODY_TARGET.pluginId}`,
                                pluginId: CUSTODY_TARGET.pluginId,
                                occurrenceId: CUSTODY_TARGET.occurrenceId,
                                contributionKind: 'translations',
                                locales: ['en'],
                                bundles: { en: { title: 'Acme preview' } },
                            },
                        },
                    },
                },
            };
        }

        async function warmCache() {
            const warm = await import('@/sync/domains/plugins/ui/projectionWarmCache');
            const { prepareWarmCacheEncryptionKey } = await import('@/sync/domains/state/warmCacheEncryptionKey');
            await prepareWarmCacheEncryptionKey();
            const persistence = await import('@/sync/domains/state/warmCachePersistence');
            const targetKey = warm.pluginUiProjectionAdmissionTargetKey({
                serverId: 'server-1',
                machineId: 'machine-1',
            });
            return Object.freeze({
                targetKey,
                scope: retainedTestAccountLifetime.scope,
                readEntry: () => persistence.loadPluginUiProjectionWarmCacheEntries(
                    retainedTestAccountLifetime.scope.serverId,
                    retainedTestAccountLifetime.scope.accountId,
                )[targetKey],
                reset: () => warm.forgetPluginUiProjectionAdmissionSnapshots(retainedTestAccountLifetime.scope),
                savePresentation: (generation: number) => warm.savePluginUiProjectionAdmissionSnapshot({
                    scope: retainedTestAccountLifetime.scope,
                    targetKey,
                    machineId: 'machine-1',
                    projection: custodyProjection(generation) as never,
                }),
            });
        }

        async function primeCustody() {
            const custody = await warmCache();
            custody.reset();
            custody.savePresentation(7);
            expect(custody.readEntry()).toBeDefined();
            return custody;
        }

        it('retires the whole retained entry when the machine answers method-not-found', async () => {
            const custody = await primeCustody();
            const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
            projectionDescribeMock.mockResolvedValueOnce({ supported: false, reason: 'not-supported' });

            await expect(loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                accountLifetime: retainedTestAccountLifetime,
            })).resolves.toMatchObject({ kind: 'unsupported' });

            expect(custody.readEntry()).toBeUndefined();
        });

        it('keeps retained custody through a transient transport failure', async () => {
            const custody = await primeCustody();
            const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
            projectionDescribeMock.mockResolvedValueOnce({ supported: false, reason: 'error' });

            await loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                accountLifetime: retainedTestAccountLifetime,
            });

            expect(custody.readEntry()).toBeDefined();
        });

        it('does not let an old-endpoint method-not-found delete custody a newer answer established', async () => {
            const custody = await primeCustody();
            const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');

            let settleStaleResponse!: (value: unknown) => void;
            projectionDescribeMock.mockImplementationOnce(async () => await new Promise((resolve) => {
                settleStaleResponse = resolve;
            }));
            const stale = loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                accountLifetime: retainedTestAccountLifetime,
            });
            await vi.waitFor(() => expect(settleStaleResponse).toBeTypeOf('function'));

            publishMachineContributionRegistryProjectionInvalidation(projectionScope);
            custody.savePresentation(8);

            settleStaleResponse({ supported: false, reason: 'not-supported' });
            // The late answer still settles, tagged with the revision it
            // answered, but it may not retire custody for the current endpoint.
            await expect(stale).resolves.toMatchObject({ kind: 'unsupported', projectionRevision: initialRevision });
            expect(custody.readEntry()).toBeDefined();
        });
    });

    it('keeps the current Event Automation snapshot in the incumbent projection cache', async () => {
        projectionDescribeMock.mockResolvedValueOnce({
            supported: true,
            projection: daemonProjection(7),
            automationEligibleEvents,
        });
        const {
            loadDaemonMergedProjectionCacheEntry,
            readCachedDaemonMergedProjectionCacheEntry,
        } = await import('./loadDaemonMergedProjectionInputs');

        await loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
        });

        expect(readCachedDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
        })).toMatchObject({
            kind: 'ready',
            inputs: { automationEligibleEvents },
        });
    });
});
