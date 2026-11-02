import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { defineProtocolNumber, defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDeferred, createMachineFixture } from '@/dev/testkit';
import { createPluginDeclarativeModelFixture } from '@/dev/testkit/fixtures/pluginDeclarativeModelFixture';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { createPluginContributionIdentity, buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { DaemonContributionRegistryProjectionSectionsResponseSchema, DaemonContributionRegistryProjectionDescribeResponseSchema,
    buildDaemonProjectionSections, buildDeferredDaemonProjectionSections, DaemonProjectionSectionBodyResponseSchema,
    DaemonProjectionDeferredSectionsResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

let network: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>>;
let storage: typeof import('@/sync/domains/state/storage').storage;
let getMachineContributionRegistryProjectionRevision: typeof import('@/sync/ops/machineContributionRegistryProjectionRevision').getMachineContributionRegistryProjectionRevision;
let publishMachineContributionRegistryProjectionInvalidation: typeof import('@/sync/ops/machineContributionRegistryProjectionRevision').publishMachineContributionRegistryProjectionInvalidation;
let clearDaemonMergedProjectionCacheForTests: typeof import('./loadDaemonMergedProjectionInputs').clearDaemonMergedProjectionCacheForTests;
let activeAccountRestored = false;
let initialRevision = 0;
const projectionScope = { machineId: 'machine-1', serverId: 'server-1' };
const textBoundary = vi.hoisted(() => ({ locale: 'en' }));

// Localization is a platform boundary; projection and descriptor logic stay real.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ getPreferredLanguage: () => textBoundary.locale });
});

// Install the network boundary before preparing the real Sync graph once,
// outside each test's hook deadline. Per-case state and transport still reset.
network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
({ storage } = await import('@/sync/domains/state/storage'));
({ getMachineContributionRegistryProjectionRevision, publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision'));
({ clearDaemonMergedProjectionCacheForTests } = await import('./loadDaemonMergedProjectionInputs'));
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
afterAll(() => network.dispose());

const projectionDescribeMock = vi.hoisted(() => vi.fn());
const homeIds = new Map<string, string>();

function daemonProjection(generation: number) {
    return {
        v: 2 as const,
        generation,
        installedPackagesById: {},
        agentsById: {},
        actionsById: {},
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
        sourceCustody: { kind: 'development', registeredRootId: 'events-root' },
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
            model: createPluginDeclarativeModelFixture({
                pluginId: 'acme.composer', localId: 'review-region-renderer',
                occurrenceId: 'composer-generation-a',
                document: { version: 1, root: { kind: 'text', text: 'Review' } },
            }),
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
        target: {
            pluginId: 'acme.composer', occurrenceId: 'composer-generation-a',
            sourceCustody: { kind: 'development', registeredRootId: 'composer-root' },
        },
        points: [],
    },
}] as const;

describe('loadDaemonMergedProjectionCacheEntry', () => {
    it.each(['in-progress', 'once', 'held-upgrade', 'again', 'cancelled', 'retired'] as const)('finishes projection sections or re-establishes a superseded manifest (%s)', async scenario => {
        const { RpcHandlerManager } = await import(new URL('../../../../cli/src/api/rpc/RpcHandlerManager.ts', import.meta.url).href);
        const { registerDaemonContributionRegistryProjectionHandler } = await import(new URL('../../../../cli/src/rpc/handlers/daemonContributionRegistryProjection.ts', import.meta.url).href);
        const { getResolvedContributionRegistry } = await import(new URL('../../../../cli/src/plugins/projection/registry/builtIn/snapshot.ts', import.meta.url).href);
        const { resolveExecutablePluginRuntimeRegistry } = await import(new URL('../../../../cli/src/plugins/runtime/resolveExecutablePluginRuntimeRegistry.ts', import.meta.url).href);
        const { socketRpcCodec } = await import('@happier-dev/sync-client');
        const { mkdtemp } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { loadDaemonMergedProjectionCacheEntry, readDaemonMergedProjectionRetryDelayMs } = await import('./loadDaemonMergedProjectionInputs');
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
        onTestFinished(() => clock.mockRestore());
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'projection-authority-transition-'));
        const runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, contributes: getResolvedContributionRegistry(), generation: 41,
            resolveServerFeaturesSnapshot: () => undefined,
            resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }: Readonly<{ pluginId: string; rootPath: string }>) => ({
                kind: 'development', registeredRootId: `authority-transition:${pluginId}`, canonicalRoot: rootPath, observedRevision: 1,
            }),
        });
        let serverIdentityId = 'srv_before';
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionMode: 'plain', logger: () => {} });
        registerDaemonContributionRegistryProjectionHandler(rpc, {
            resolveRuntimeRegistry: async () => runtime, resolveGeneration: async () => 41,
            resolveInstalledPackages: async () => [], resolveServerFeaturesSnapshot: () => undefined,
            resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId, machineId: 'machine-1' }),
        });
        const account = createAccountLifetime('account-a');
        const abort = new AbortController();
        const manifests: ReturnType<typeof DaemonProjectionDeferredSectionsResponseSchema.parse>[] = [];
        const codes: unknown[] = [];
        const frames: number[] = [];
        const requests: Record<string, unknown>[] = [];
        network.setRpcAckResponder(async request => {
            const payload = request.payload as Record<string, unknown>;
            requests.push(payload);
            // Exercise the daemon's real transport error serialization as well
            // as the UI socket codec, admission, hydration and loader.
            const content = { mode: 'plain' as const };
            const method = `${request.targetId}:${request.method}`;
            const callId = '0123456789abcdef0123456789abcdef';
            const encoded = await socketRpcCodec.encodeParams(content, payload, { method, callId });
            const result: unknown = await rpc.handleRequest({ method, params: encoded });
            const reply = await socketRpcCodec.decodeResult(content, { ok: true, result }, callId);
            frames.push(new TextEncoder().encode(JSON.stringify(reply)).length);
            const manifest = DaemonProjectionDeferredSectionsResponseSchema.safeParse(reply);
            if (manifest.success) {
                manifests.push(manifest.data);
                if ((manifests.length === 1 && scenario !== 'held-upgrade') || scenario === 'again') {
                    serverIdentityId = `srv_after_${manifests.length}`;
                    // A separate manifest request can supersede an advertised
                    // build; page reads alone finish the last complete build.
                    if (scenario !== 'in-progress') await rpc.invokeLocal(
                        RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, payload);
                }
            }
            if (payload.sectionRead && !DaemonProjectionSectionBodyResponseSchema.safeParse(reply).success) {
                codes.push(reply && typeof reply === 'object' && 'errorCode' in reply ? reply.errorCode : undefined);
                if (scenario === 'cancelled') abort.abort();
                if (scenario === 'retired') account.retire();
            }
            return { ok: true, result: reply };
        });
        const params = { ...projectionScope, accountLifetime: account.lifetime, signal: abort.signal, sections: ['actionsById'] };
        try {
            if (scenario === 'held-upgrade') {
                expect(await loadDaemonMergedProjectionCacheEntry({ ...params, sections: ['agentsById'] })).toMatchObject({ kind: 'ready' });
                expect(manifests).toHaveLength(1);
                serverIdentityId = 'srv_after_1';
                await rpc.invokeLocal(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, requests[0]!);
            }
            const result = await loadDaemonMergedProjectionCacheEntry({ ...params, reuseFreshReady: scenario === 'held-upgrade' });
            if (scenario === 'in-progress') {
                expect(codes).toEqual([]);
                expect(manifests).toHaveLength(1);
                expect(result).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 41 } } });
                if (result?.kind !== 'ready') throw new Error('Expected the advertised complete projection');
                const origins = Object.values(result.inputs.pluginProjectionV2!.actionsById).flatMap(action => action.executionOrigin ?? []);
                expect(origins.length).toBeGreaterThan(0);
                expect(origins.every(origin => origin.serverIdentityId === 'srv_before')).toBe(true);
                return;
            }
            // Independent frames can report the same retired build. Recovery
            // is bounded by manifest attempts, not by one physical stale frame.
            expect([...new Set(codes)]).toEqual(['plugin_projection_section_stale']);
            expect(manifests).toHaveLength(scenario === 'cancelled' || scenario === 'retired' ? 1 : 2);
            expect(requests.every(request => request.deferredSections === true)).toBe(true);
            expect(Math.max(...frames)).toBeLessThanOrEqual(49_152);
            if (scenario === 'cancelled' || scenario === 'retired') {
                expect(result).toBeNull();
                return;
            }
            expect(manifests[1]!.projectionDigest).not.toBe(manifests[0]!.projectionDigest);
            const refresh = requests.filter(request => !request.sectionRead)[1]!;
            expect(refresh).not.toHaveProperty('knownProjectionDigest');
            if (scenario === 'again') {
                expect(result).toMatchObject({ kind: 'error', reason: 'projection-stale', retryAtMs: null });
                expect(readDaemonMergedProjectionRetryDelayMs(result)).toBeNull();
                const settled = requests.length;
                expect(await loadDaemonMergedProjectionCacheEntry({ ...params, shareRetryCadence: true })).toBe(result);
                expect(requests).toHaveLength(settled);
            } else {
                expect(result).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 41 } } });
                if (result?.kind !== 'ready') throw new Error('Expected the current projection');
                const origins = Object.values(result.inputs.pluginProjectionV2!.actionsById).flatMap(action => action.executionOrigin ?? []);
                expect(origins.length).toBeGreaterThan(0);
                expect(origins.every(origin => origin.serverIdentityId === 'srv_after_1')).toBe(true);
            }
        } finally { abort.abort(); account.retire(); }
    });

    it('shares one slow cold describe and starts freshness when the daemon returns', async () => {
        const { loadDaemonMergedProjectionCacheEntry, readReusableDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        const response = createDeferred<{ supported: true; projection: ReturnType<typeof daemonProjection> }>();
        let clock = Date.now();
        const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
        projectionDescribeMock.mockImplementation(() => response.promise);
        const params = { ...projectionScope, accountLifetime: account.lifetime, sections: ['agentsById'] };
        const first = loadDaemonMergedProjectionCacheEntry(params);
        const joined = loadDaemonMergedProjectionCacheEntry(params);
        try {
            await vi.waitFor(() => expect(projectionDescribeMock).toHaveBeenCalledTimes(1));
            clock += 186_406;
            response.resolve({ supported: true, projection: daemonProjection(7) });
            const [ready, sibling] = await Promise.all([first, joined]);
            expect(ready?.kind).toBe('ready');
            expect(sibling).toBe(ready);
            expect(readReusableDaemonMergedProjectionCacheEntry(params)).toBe(ready);
            expect(projectionDescribeMock).toHaveBeenCalledTimes(1);
        } finally {
            response.resolve({ supported: true, projection: daemonProjection(7) });
            await Promise.allSettled([first, joined]);
            now.mockRestore();
            account.retire();
        }
    });

    beforeEach(async () => {
        textBoundary.locale = 'en';
        network.resetRequests();
        retireActiveServerAccountScopeLifetime();
        storage.setState(storage.getInitialState(), true);
        activeAccountRestored = false;
        projectionDescribeMock.mockReset();
        // The network fixture publishes plain Machines, so their Account must
        // explicitly report plain mode rather than the old-server E2EE fallback.
        network.setHttpResponder(async (input) => new URL(String(input)).pathname === '/v1/account/encryption'
            ? Response.json({ mode: 'plain', updatedAt: 0 })
            : null);
        const home = await network.addHome('https://server-1', 'account-a');
        expect(home.id).toBe('server-1');
        homeIds.clear();
        homeIds.set(home.serverUrl, home.id);
        network.setRpcAckResponder(async (request) => {
            if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            }
            const response = await projectionDescribeMock(request.targetId, { serverId: homeIds.get(request.serverUrl), payload: request.payload });
            if (response.supported !== true) {
                if (response.reason === 'not-supported') return { ok: false, error: 'Unsupported projection', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
                if (response.reason === 'timeout') {
                    // This is the shared connection/setup owner's timeout fact,
                    // not an unsolicited peer acknowledgement timeout.
                    throw Object.assign(new Error('RPC connection setup timed out'), { code: 'MACHINE_RPC_TIMEOUT' });
                }
                throw new Error('Projection transport unavailable');
            }
            const { supported: _supported, ...envelope } = response;
            return { ok: true, result: { protocolVersion: 1, ...envelope } };
        });
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
        await serverScopedRpcSocketPool.stopAll();
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
    });

    it('publishes a background Home descriptor under its Account and retires only that Home when its request lifetime retires', async () => {
        const agentIdentity = createPluginContributionIdentity({ pluginId: 'acme.agent', localId: 'agent' });
        const agentId = buildQualifiedPluginContributionKey(agentIdentity);
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
                    [agentId]: {
                        id: agentId, identity: agentIdentity,
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
        expect(resolveAgentUiBehavior(agentId, 'shared-machine', scopeB).permissions?.footer?.usePermissionUpdates).toBe(true);
        expect(resolveAgentUiBehavior(agentId, 'shared-machine').permissions?.footer?.usePermissionUpdates).toBe(false);
        expect(resolveAgentUiBehavior(agentId, 'shared-machine', scopeA).permissions?.footer?.stopHandling).toBe('denyOnly');

        let complete!: (value: ReturnType<typeof projectionForHome>) => void;
        projectionDescribeMock.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
        const pending = loadDaemonMergedProjectionCacheEntry({ machineId: 'shared-machine', serverId: homeB.id, accountLifetime: lifetimeB.lifetime });
        await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
        lifetimeB.retire();
        complete(projectionForHome(homeB.id));
        await expect(pending).resolves.toBeNull();
        expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'shared-machine', serverId: homeB.id })).toBeNull();
        expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'shared-machine', serverId: homeA.id })?.kind).toBe('ready');
        expect(resolveAgentUiBehavior(agentId, 'shared-machine', scopeB).permissions?.footer?.usePermissionUpdates).toBe(false);
        expect(resolveAgentUiBehavior(agentId, 'shared-machine', scopeA).permissions?.footer?.stopHandling).toBe('denyOnly');
    });

    it('retains the last ready projection as inert cached metadata after a transport error', async () => {
        projectionDescribeMock
            .mockResolvedValueOnce({
                supported: true,
                projection: daemonProjection(7),
            })
            .mockRejectedValueOnce(new RpcError('Private transport details', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE));
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
            reason: 'transport-unavailable',
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

    it('releases an unanswered projection when its final reader leaves and recovers on the next attempt', async () => {
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        projectionDescribeMock.mockImplementationOnce(() => new Promise(() => {}));
        projectionDescribeMock.mockResolvedValueOnce({ supported: true, projection: daemonProjection(8) });
        const firstOwner = new AbortController();
        const secondOwner = new AbortController();
        const scope = { ...projectionScope, accountLifetime: account.lifetime };
        const first = loadDaemonMergedProjectionCacheEntry({ ...scope, signal: firstOwner.signal });
        const second = loadDaemonMergedProjectionCacheEntry({ ...scope, signal: secondOwner.signal });
        await vi.waitFor(() => expect(projectionDescribeMock).toHaveBeenCalledTimes(1));
        firstOwner.abort();
        await expect(first).resolves.toBeNull();
        let secondSettled = false;
        void second.then(() => { secondSettled = true; });
        expect(secondSettled).toBe(false);
        secondOwner.abort();
        await expect(second).resolves.toBeNull();
        await expect(loadDaemonMergedProjectionCacheEntry(scope)).resolves.toMatchObject({ kind: 'ready' });
        expect(projectionDescribeMock).toHaveBeenCalledTimes(2);
    });

    it('hydrates only current demand after a new manifest while merging concurrent same-manifest coverage', async () => {
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        onTestFinished(() => account.retire());
        const snapshot = (generation: number) => buildDeferredDaemonProjectionSections(
            DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
                projectionDigest: String(generation).repeat(64), projection: daemonProjection(generation),
                automationEligibleEvents: automationEligibleEvents.map(entry => ({ ...entry,
                    event: { ...entry.event, title: `Repository updated ${generation}` } })),
            }));
        let current = snapshot(7);
        const reads: string[] = [];
        network.setRpcAckResponder(async request => {
            const payload = request.payload as Readonly<{ sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>;
            if (!payload.sectionRead) return { ok: true, result: current.manifest };
            const { digest, offset, includeDigests } = payload.sectionRead;
            reads.push(digest, ...includeDigests ?? []);
            return { ok: true, result: current.read(digest, offset, includeDigests) };
        });
        const params = { ...projectionScope, accountLifetime: account.lifetime };
        expect(await loadDaemonMergedProjectionCacheEntry(params)).toMatchObject({ kind: 'ready',
            inputs: { automationEligibleEvents: [{ event: { title: 'Repository updated 7' } }] } });
        current = snapshot(8);
        publishMachineContributionRegistryProjectionInvalidation(projectionScope);
        reads.length = 0;
        const narrow = await loadDaemonMergedProjectionCacheEntry({ ...params, sections: ['agentsById'] });
        expect(narrow).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 8 } } });
        expect(reads).not.toContain(current.manifest.sections.automationEligibleEvents);
        // A full reader still acquires its own coverage; neither completion
        // order may erase the other's same-manifest facts.
        current = snapshot(9);
        publishMachineContributionRegistryProjectionInvalidation(projectionScope);
        const [full, concurrentNarrow] = await Promise.all([
            loadDaemonMergedProjectionCacheEntry(params),
            loadDaemonMergedProjectionCacheEntry({ ...params, sections: ['agentsById'] }),
        ]);
        expect(full).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 9 },
            automationEligibleEvents: [{ event: { title: 'Repository updated 9' } }] } });
        expect(concurrentNarrow).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 9 } } });
        reads.length = 0;
        const retained = await loadDaemonMergedProjectionCacheEntry({ ...params, sections: ['agentsById'], reuseFreshReady: true });
        expect(reads).toHaveLength(0);
        expect(retained).toMatchObject({ kind: 'ready', inputs: { automationEligibleEvents: [{ event: { title: 'Repository updated 9' } }] } });
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
        await expect(directRead).resolves.toMatchObject({
            pluginProjectionV2: { generation: 7 },
            pluginUiProjection: { generation: 7 },
        });
        const published = await directRead;
        const sibling = await loadDaemonMergedProjectionInputs({ machineId: 'machine-1', serverId: 'server-1', accountLifetime: account.lifetime });
        expect(sibling?.pluginUiProjection).toBe(published?.pluginUiProjection);

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
            expect(call[1]).not.toHaveProperty('selection');
        }
    });

    it('conditionally revalidates unchanged targets once for concurrent readers without republishing full inputs', async () => {
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        const digest = 'a'.repeat(64);
        const changedDigest = 'b'.repeat(64);
        let currentDigest = digest;
        let fullPayloads = 0;
        const bytes: number[] = [];
        projectionDescribeMock.mockImplementation(async (_machineId, options) => {
            const unchanged = options.payload.knownProjectionDigest === currentDigest;
            const reply = unchanged
                ? { supported: true, unchanged: true, projectionDigest: currentDigest }
                : { supported: true, projection: daemonProjection(currentDigest === digest ? 7 : 8), projectionDigest: currentDigest };
            if (!unchanged) fullPayloads++;
            bytes.push(new TextEncoder().encode(JSON.stringify(reply)).length);
            return reply;
        });
        const params = { ...projectionScope, accountLifetime: account.lifetime };
        const initial = await loadDaemonMergedProjectionCacheEntry(params);
        expect(initial?.kind).toBe('ready');
        expect(fullPayloads).toBe(1);
        publishMachineContributionRegistryProjectionInvalidation(projectionScope);
        bytes.length = 0;
        const refreshed = await Promise.all(Array.from({ length: 32 }, () => loadDaemonMergedProjectionCacheEntry(params)));
        expect(projectionDescribeMock).toHaveBeenCalledTimes(2);
        expect(fullPayloads).toBe(1);
        expect(bytes).toHaveLength(1);
        expect(bytes[0]).toBeLessThanOrEqual(256);
        expect(refreshed.every(entry => entry?.kind === 'ready' && initial?.kind === 'ready' && entry.inputs === initial.inputs)).toBe(true);
        currentDigest = changedDigest;
        publishMachineContributionRegistryProjectionInvalidation(projectionScope);
        const changed = await Promise.all(Array.from({ length: 32 }, () => loadDaemonMergedProjectionCacheEntry(params)));
        expect(projectionDescribeMock).toHaveBeenCalledTimes(3);
        expect(fullPayloads).toBe(2);
        expect(changed[0]).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 8 } } });
        textBoundary.locale = 'fr';
        await loadDaemonMergedProjectionCacheEntry(params);
        expect(projectionDescribeMock.mock.calls.at(-1)?.[1].payload).not.toHaveProperty('knownProjectionDigest');
        expect(fullPayloads).toBe(3);
    });

    it('rejects an unchanged reply without the exact held digest and degrades to full replies from older daemons', async () => {
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        const params = { ...projectionScope, accountLifetime: account.lifetime };
        projectionDescribeMock.mockResolvedValueOnce({ supported: true, unchanged: true, projectionDigest: 'a'.repeat(64) });
        expect(await loadDaemonMergedProjectionCacheEntry(params)).toMatchObject({ kind: 'error', reason: 'invalid-response' });
        projectionDescribeMock.mockResolvedValueOnce({ supported: true, projection: daemonProjection(7), projectionDigest: 'a'.repeat(64) });
        await loadDaemonMergedProjectionCacheEntry(params);
        projectionDescribeMock.mockResolvedValueOnce({ supported: true, unchanged: true, projectionDigest: 'b'.repeat(64) });
        expect(await loadDaemonMergedProjectionCacheEntry(params)).toMatchObject({ kind: 'error', reason: 'invalid-response' });
        projectionDescribeMock.mockResolvedValue({ supported: true, projection: daemonProjection(8) });
        expect(await loadDaemonMergedProjectionCacheEntry(params)).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 8 } } });
        await loadDaemonMergedProjectionCacheEntry(params);
        expect(projectionDescribeMock.mock.calls.at(-1)?.[1].payload).not.toHaveProperty('knownProjectionDigest');
    });

    it.each(['array', 'raw', 'unversioned-raw', 'held-upgrade', 'fallback-refused', 'fallback-denied',
        'unsupported-version', 'null-version', 'bad-page', 'full'] as const)('negotiates %s index frames through the real loader and daemon handler', async encoding => {
        const { RpcHandlerManager } = await import(new URL('../../../../cli/src/api/rpc/RpcHandlerManager.ts', import.meta.url).href);
        const { registerDaemonContributionRegistryProjectionHandler } = await import(new URL('../../../../cli/src/rpc/handlers/daemonContributionRegistryProjection.ts', import.meta.url).href);
        const { createResolvedContributionRegistry } = await import(new URL('../../../../cli/src/plugins/projection/registry/createResolvedContributionRegistry.ts', import.meta.url).href);
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionMode: 'plain', logger: () => {} });
        registerDaemonContributionRegistryProjectionHandler(rpc, {
            resolveRegistry: async () => createResolvedContributionRegistry({}), resolveGeneration: async () => 7,
            resolveInstalledPackages: async () => [], resolveServerFeaturesSnapshot: () => undefined,
        });
        const frames: unknown[] = [];
        const requests: Record<string, unknown>[] = [];
        let fullRead = encoding === 'full';
        let unversionedRaw = encoding === 'unversioned-raw' || encoding === 'fallback-refused' || encoding === 'fallback-denied';
        network.setRpcAckResponder(async request => {
            // QF41's loaded daemon predates frame negotiation. Its full-read
            // request is additive-open: the new offer is safely ignored.
            const payload = { ...request.payload as Record<string, unknown> };
            requests.push({ ...payload });
            if (encoding === 'fallback-denied' && !payload.deferredSections) {
                return { ok: false, error: 'Fixture full-read refusal', errorCode: RPC_ERROR_CODES.FORBIDDEN };
            }
            if (fullRead || (encoding !== 'raw' && encoding !== 'bad-page')) {
                delete payload.supportedSectionFrameVersions;
                delete payload.sectionFrameVersion;
            }
            if (fullRead) {
                delete payload.deferredSections;
                delete payload.knownSectionDigests;
            }
            // Round 8 sent raw index text without advertising a frame version.
            // Use the real codec/handler's raw producer, omitting only its later
            // Round 9 advertisement. Ordinary body pages use the same encoding.
            if (unversionedRaw && payload.sectionRead) payload.sectionFrameVersion = 2;
            if (encoding === 'fallback-refused') payload.deferredSections = true;
            const produced = await rpc.invokeLocal(request.method, payload);
            let reply = unversionedRaw && produced && typeof produced === 'object'
                && 'deferredSections' in produced
                ? (({ sectionFrameVersion: _version, ...manifest }) => manifest)(produced as Record<string, unknown>)
                : produced;
            if ((encoding === 'unsupported-version' || encoding === 'null-version') && reply && typeof reply === 'object'
                && 'deferredSections' in reply) reply = { ...reply, sectionFrameVersion: encoding === 'null-version' ? null : 3 };
            if (encoding === 'bad-page' && reply && typeof reply === 'object' && 'sectionBody' in reply) {
                reply = { ...reply, digest: '0'.repeat(64) };
            }
            frames.push(reply);
            return { ok: true, result: reply };
        });
        const account = createAccountLifetime('account-a');
        const params = { ...projectionScope, accountLifetime: account.lifetime,
            sections: encoding === 'held-upgrade' ? ['agentsById'] : undefined };
        let result = await loadDaemonMergedProjectionCacheEntry(params);
        if (encoding === 'held-upgrade') {
            expect(result).toMatchObject({ kind: 'ready' });
            requests.length = 0;
            frames.length = 0;
            unversionedRaw = true;
            result = await loadDaemonMergedProjectionCacheEntry({ ...params, sections: ['actionsById'], reuseFreshReady: true });
            expect(requests.find(request => request.sectionRead)).toHaveProperty('knownProjectionDigest');
        }
        if (encoding === 'fallback-denied') {
            expect(result).toMatchObject({ kind: 'error', reason: 'access-denied', deferredHydrationRejection: 'section-spans' });
            expect(requests.filter(request => !request.deferredSections)).toHaveLength(1);
            account.retire();
            return;
        }
        if (encoding === 'fallback-refused' || encoding === 'bad-page') {
            expect(result).toMatchObject({ kind: 'error', reason: 'invalid-response', retryAtMs: null,
                deferredHydrationRejection: encoding === 'bad-page' ? 'section-page-position' : 'section-spans' });
            expect(requests.filter(request => !request.deferredSections)).toHaveLength(encoding === 'bad-page' ? 0 : 1);
            const settledCount = requests.length;
            const { readDaemonMergedProjectionRetryDelayMs } = await import('./loadDaemonMergedProjectionInputs');
            expect(readDaemonMergedProjectionRetryDelayMs(result)).toBeNull();
            expect(await loadDaemonMergedProjectionCacheEntry({ ...params, shareRetryCadence: true })).toBe(result);
            expect(requests).toHaveLength(settledCount);
            if (encoding === 'bad-page') {
                // A failed parallel hydration releases all carrier custody.
                // Fresh demand can use a full-reply peer without old frames
                // leaking into that new read or poisoning its admission.
                fullRead = true;
                expect(await loadDaemonMergedProjectionCacheEntry({ ...params, reuseFreshReady: false }))
                    .toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 7 } } });
                expect(requests).toHaveLength(settledCount + 1);
                expect(requests.at(-1)).not.toHaveProperty('sectionRead');
            }
            account.retire();
            return;
        }
        expect(result, result?.kind === 'error' ? JSON.stringify({ reason: result.reason,
            hydration: result.deferredHydrationRejection }) : undefined)
            .toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 7 } } });
        if (unversionedRaw || encoding === 'unsupported-version' || encoding === 'null-version') {
            expect(result).toHaveProperty('deferredHydrationRejection', unversionedRaw ? 'section-spans' : 'manifest-admission');
            const fallback = requests.filter(request => !request.deferredSections);
            expect(fallback).toHaveLength(1);
            expect(fallback[0]).not.toHaveProperty('knownProjectionDigest');
            expect(fallback[0]).not.toHaveProperty('sectionRead');
            expect(requests.filter(request => request.sectionRead)).toHaveLength(unversionedRaw ? 1 : 0);
            const settledCount = requests.length;
            expect(await loadDaemonMergedProjectionCacheEntry({ ...params, reuseFreshReady: true })).toBe(result);
            expect(requests).toHaveLength(settledCount);
        }
        if (encoding === 'full') {
            expect(DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(frames[0]).success).toBe(true);
        } else if (encoding !== 'unsupported-version' && encoding !== 'null-version' && encoding !== 'held-upgrade') {
            const manifest = DaemonProjectionDeferredSectionsResponseSchema.parse(frames[0]);
            expect(manifest).toMatchObject(encoding === 'raw' ? { sectionFrameVersion: 2 } : { deferredSections: true });
            if (encoding !== 'raw') expect(manifest).not.toHaveProperty('sectionFrameVersion');
            const indexDigest = manifest.sections.base;
            const index = frames.map(frame => DaemonProjectionSectionBodyResponseSchema.safeParse(frame))
                .find(page => page.success && page.data.digest === indexDigest);
            if (!index?.success) throw new Error('Missing base index');
            // The old producer's exact encoding observed by QF41 is JSON([frame]).
            expect(Array.isArray(JSON.parse(index.data.chunk))).toBe(encoding === 'array');
            for (const request of requests.filter(request => request.sectionRead)) {
                expect(request.sectionFrameVersion).toBe(encoding === 'raw' ? 2 : undefined);
            }
            expect(Math.max(...frames.map(frame => new TextEncoder().encode(JSON.stringify(frame)).length))).toBeLessThanOrEqual(49_152);
        }
        frames.length = 0;
        publishMachineContributionRegistryProjectionInvalidation(projectionScope);
        expect(await loadDaemonMergedProjectionCacheEntry(params)).toMatchObject({ kind: 'ready' });
        expect(frames).toHaveLength(1);
        expect(new TextEncoder().encode(JSON.stringify(frames[0])).length).toBe(124);

        if (encoding === 'raw') {
            // An old UI never offers the new version; a new daemon must keep the
            // strict old manifest and JSON-array index readable without dual parsing.
            const oldRequest = { machineId: 'machine-1', locale: 'en', deferredSections: true };
            const oldManifest = DaemonProjectionDeferredSectionsResponseSchema.parse(await rpc.invokeLocal(
                RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, oldRequest));
            expect(oldManifest).not.toHaveProperty('sectionFrameVersion');
            const oldPage = DaemonProjectionSectionBodyResponseSchema.parse(await rpc.invokeLocal(
                RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
                { ...oldRequest, sectionRead: { digest: oldManifest.sections.base, offset: 0 } }));
            const oldSpans = JSON.parse(oldPage.chunk);
            expect(oldSpans).toHaveLength(1);
            expect(DaemonContributionRegistryProjectionSectionsResponseSchema.safeParse(JSON.parse(oldSpans[0])).success).toBe(true);
        }
        account.retire();
    });

    it('resends only the changed plugin section for a Machine with one different plugin version', async () => {
        const { RpcHandlerManager } = await import(new URL('../../../../cli/src/api/rpc/RpcHandlerManager.ts', import.meta.url).href);
        const { registerDaemonContributionRegistryProjectionHandler } = await import(new URL('../../../../cli/src/rpc/handlers/daemonContributionRegistryProjection.ts', import.meta.url).href);
        const { createResolvedContributionRegistry } = await import(new URL('../../../../cli/src/plugins/projection/registry/createResolvedContributionRegistry.ts', import.meta.url).href);
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        let account = createAccountLifetime('account-a');
        const daemons = new Map(['one', 'two', 'different'].map(machineId => {
            const settings = ['acme.one', 'acme.two'].map(pluginId => ({
                provenance: 'external', source: { kind: 'path' }, pluginId,
                sourceSpec: { kind: 'path', locator: `/plugins/${pluginId}`, resolvedVersion: machineId === 'different' && pluginId === 'acme.one' ? '2.0.0' : '1.0.0' },
                definition: { id: 'preferences', version: 1, title: `Preferences for ${pluginId}`, target: { kind: 'plugin' }, scope: 'daemon',
                    fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' }, default: false }],
                    presentation: { sections: [], subagentSections: [] } },
            }));
            const registry = createResolvedContributionRegistry({ settings });
            const rpc = new RpcHandlerManager({ scopePrefix: machineId, encryptionMode: 'plain', logger: () => {} });
            registerDaemonContributionRegistryProjectionHandler(rpc, { resolveRegistry: async () => registry,
                resolveGeneration: async () => 1, resolveInstalledPackages: async () => [], resolveServerFeaturesSnapshot: () => undefined });
            return [machineId, rpc] as const;
        }));
        const bodies: string[][] = [];
        const indexes = new Set<string>();
        network.setRpcAckResponder(async request => {
            const reply = await daemons.get(request.targetId)!.invokeLocal(request.method, request.payload);
            const manifest = DaemonProjectionDeferredSectionsResponseSchema.safeParse(reply);
            if (manifest.success) {
                bodies.push([]);
                for (const digest of Object.values(manifest.data.sections)) indexes.add(digest);
            }
            const page = DaemonProjectionSectionBodyResponseSchema.safeParse(reply);
            if (page.success) {
                expect(page.data.offset).toBe(0);
                expect(page.data.nextOffset).toBeNull();
                if (!indexes.has(page.data.digest)) {
                    const spans: string[] = JSON.parse(page.data.chunk);
                    bodies.at(-1)!.push(spans.join(''));
                }
                for (const extra of page.data.bodies ?? []) {
                    if (!indexes.has(extra.digest)) bodies.at(-1)!.push(extra.body.join(''));
                }
            }
            return { ok: true, result: reply };
        });
        const read = (machineId: string) => loadDaemonMergedProjectionCacheEntry({ machineId, serverId: 'server-1', accountLifetime: account.lifetime });
        expect(await read('one')).toMatchObject({ kind: 'ready' });
        expect(await read('two')).toMatchObject({ kind: 'ready' });
        expect(await read('different')).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: {
            installedPackagesById: { 'acme.one': { version: '2.0.0' }, 'acme.two': { version: '1.0.0' } },
        } } });
        expect(bodies[0]!.length).toBeGreaterThan(1);
        expect(bodies[1]).toEqual([]);
        expect(bodies[2]).toHaveLength(1);
        expect(bodies[2]![0]).toContain('acme.one');
        expect(bodies[2]![0]).not.toContain('acme.two');
        textBoundary.locale = 'fr';
        expect(await read('one')).toMatchObject({ kind: 'ready' });
        expect(bodies[3]!.length).toBeGreaterThan(1);
        const peerHome = await network.addHome('https://sections-peer.test', 'account-peer');
        const peer = createAccountLifetime('account-peer', peerHome.id);
        expect(await loadDaemonMergedProjectionCacheEntry({ machineId: 'one', serverId: peerHome.id, accountLifetime: peer.lifetime }))
            .toMatchObject({ kind: 'ready' });
        expect(bodies[4]!.length).toBeGreaterThan(1);
        peer.retire();
        account.retire();
        account = createAccountLifetime('account-a');
        expect(await read('one')).toMatchObject({ kind: 'ready' });
        expect(bodies[5]!.length).toBeGreaterThan(1);
        account.retire();
    });

    it('does not retain shared bodies from framing whose reconstructed projection fails admission', async () => {
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
            projection: { ...daemonProjection(7), installedPackagesById: { 'acme.one': {
                id: 'acme.one', displayName: 'One', enabled: true, source: { kind: 'bundled', locator: 'acme.one' },
            } } },
        });
        const framed = buildDaemonProjectionSections(response);
        const malformed = { ...framed, parts: framed.parts.map(part => typeof part === 'string' ? part.replace('"v":2', '"v":3') : part) };
        const account = createAccountLifetime('account-a');
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        projectionDescribeMock.mockResolvedValueOnce({ supported: true, ...malformed });
        expect(await loadDaemonMergedProjectionCacheEntry({ ...projectionScope, accountLifetime: account.lifetime }))
            .toMatchObject({ kind: 'error', reason: 'invalid-response', retryAtMs: null });
        projectionDescribeMock.mockResolvedValueOnce({ supported: true, ...framed });
        expect(await loadDaemonMergedProjectionCacheEntry({ ...projectionScope, accountLifetime: account.lifetime }))
            .toMatchObject({ kind: 'ready' });
        expect(projectionDescribeMock.mock.calls.at(-1)?.[1].payload.deferredSections).toBe(true);
        const deferred = buildDeferredDaemonProjectionSections({ ...response, projectionDigest: 'a'.repeat(64) });
        let invalid = true;
        let reads = 0;
        network.setRpcAckResponder(async request => {
            reads++;
            const payload = request.payload as Readonly<{ sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>;
            return { ok: true, result: payload.sectionRead
                ? deferred.read(payload.sectionRead.digest, payload.sectionRead.offset, payload.sectionRead.includeDigests)
                : invalid ? { ...deferred.manifest, sections: { ...deferred.manifest.sections,
                    installedPackagesById: deferred.manifest.sections.base } } : deferred.manifest };
        });
        expect(await loadDaemonMergedProjectionCacheEntry({ ...projectionScope, accountLifetime: account.lifetime, shareRetryCadence: true }))
            .toMatchObject({ kind: 'error', reason: 'invalid-response', retryAtMs: null });
        const failedReads = reads;
        await loadDaemonMergedProjectionCacheEntry({ ...projectionScope, accountLifetime: account.lifetime, shareRetryCadence: true });
        expect(reads).toBe(failedReads);
        invalid = false;
        expect(await loadDaemonMergedProjectionCacheEntry({ ...projectionScope, accountLifetime: account.lifetime })).toMatchObject({ kind: 'ready' });
        account.retire();
    });

    it('reads a shared digest through its own Machine after the byte issuer is cancelled', async () => {
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        const abort = new AbortController();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projection: daemonProjection(7),
        });
        const deferred = buildDeferredDaemonProjectionSections({ ...response, projectionDigest: 'a'.repeat(64) });
        const manifests: string[] = [];
        const bodyReads: string[] = [];
        network.setRpcAckResponder(async request => {
            const payload = request.payload as Readonly<{
                sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] };
            }>;
            if (!payload.sectionRead) {
                manifests.push(request.targetId);
                return { ok: true, result: deferred.manifest };
            }
            bodyReads.push(request.targetId);
            if (request.targetId === 'issuer') await held;
            return { ok: true, result: deferred.read(payload.sectionRead.digest,
                payload.sectionRead.offset, payload.sectionRead.includeDigests) };
        });
        const first = loadDaemonMergedProjectionCacheEntry({ machineId: 'issuer', serverId: 'server-1',
            accountLifetime: account.lifetime, signal: abort.signal });
        await vi.waitFor(() => expect(bodyReads).toEqual(['issuer']));
        const peer = loadDaemonMergedProjectionCacheEntry({ machineId: 'reader', serverId: 'server-1',
            accountLifetime: account.lifetime });
        try {
            await vi.waitFor(() => expect(manifests).toEqual(['issuer', 'reader']));
            expect(bodyReads).toEqual(['issuer']);
            abort.abort();
            await expect(first).resolves.toBeNull();
            await expect(peer).resolves.toMatchObject({ kind: 'ready',
                inputs: { pluginProjectionV2: { generation: 7 } } });
            expect(bodyReads).toContain('reader');
        } finally {
            release();
            abort.abort();
            await Promise.allSettled([first, peer]);
            account.retire();
        }
    });

    it('settles an independent cold Machine while a peer is stalled and keeps each captured locale', async () => {
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        let release = () => {};
        const seed = new Promise<void>(resolve => { release = resolve; });
        const locales: string[] = [];
        network.setRpcAckResponder(async request => {
            const payload = request.payload as Readonly<{ locale: string }>;
            locales.push(payload.locale);
            if (request.targetId === 'seed') await seed;
            return { ok: true, result: buildDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
                protocolVersion: 1, projection: { ...daemonProjection(7), installedPackagesById: { 'acme.one': {
                    id: 'acme.one', displayName: payload.locale, enabled: true, source: { kind: 'bundled', locator: 'acme.one' },
                } } },
            })) };
        });
        const read = (machineId: string) => loadDaemonMergedProjectionCacheEntry({ machineId, serverId: 'server-1', accountLifetime: account.lifetime });
        const first = read('seed');
        await vi.waitFor(() => expect(locales).toEqual(['en']));
        const peer = read('peer');
        let peerReady = false;
        void peer.then(result => { peerReady = result?.kind === 'ready'; });
        try {
            // One unresponsive Machine must not hold another's first RPC or
            // readiness. This crosses the real cache, transport and ingress.
            await vi.waitFor(() => expect(peerReady).toBe(true));
            expect(locales).toEqual(['en', 'en']);
            textBoundary.locale = 'fr';
            release();
            for (const result of await Promise.all([first, peer])) expect(result).toMatchObject({ kind: 'ready',
                inputs: { pluginProjectionV2: { installedPackagesById: { 'acme.one': { displayName: 'en' } } } } });
            expect(await read('peer')).toMatchObject({ kind: 'ready',
                inputs: { pluginProjectionV2: { installedPackagesById: { 'acme.one': { displayName: 'fr' } } } } });
        } finally {
            release();
            await Promise.allSettled([first, peer]);
            account.retire();
        }
    });

    it('publishes normalized model slices once and retains unchanged rows across same-generation endpoint and locale refreshes', async () => {
        const { loadDaemonMergedProjectionInputs, loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        await (await import('@/sync/domains/state/warmCacheEncryptionKey')).prepareWarmCacheEncryptionKey();
        const normalizer = await import('@/sync/domains/plugins/ui/projection');
        const normalize = vi.spyOn(normalizer, 'normalizePluginUiProjection');
        const account = createAccountLifetime('account-a');
        const projection = {
            ...daemonProjection(7),
            installedPackagesById: { 'acme.one': { id: 'acme.one', displayName: 'One', enabled: true,
                source: { kind: 'local', locator: '/plugins/one' } } },
            familiesById: { pluginUi: { family: 'pluginUi' as const, entriesById: {
                'translations:acme.one': { id: 'translations:acme.one', pluginId: 'acme.one', occurrenceId: 'one', contributionKind: 'translations' as const, locales: ['en'], bundles: { en: { title: 'One' } } },
                'translations:acme.two': { id: 'translations:acme.two', pluginId: 'acme.two', occurrenceId: 'two', contributionKind: 'translations' as const, locales: ['en'], bundles: { en: { title: 'Two' } } },
            } } },
        };
        projectionDescribeMock.mockResolvedValueOnce({ supported: true, projection });
        try {
            const params = { ...projectionScope, accountLifetime: account.lifetime };
            const first = await loadDaemonMergedProjectionInputs(params);
            expect(first?.pluginUiProjection.translationsByPluginId['acme.one']).toBeDefined();
            expect(first?.pluginUiProjection.installedPackagesById['acme.one']?.resourceDeclarationsComplete).toBe(true);
            expect(normalize.mock.results.filter(result => result.type === 'return' && result.value === first?.pluginUiProjection)).toHaveLength(1);
            const initialNormalizations = normalize.mock.calls.length;
            for (let i = 0; i < 100; i++) {
                expect((await loadDaemonMergedProjectionInputs(params))?.pluginUiProjection).toBe(first?.pluginUiProjection);
            }
            expect(normalize).toHaveBeenCalledTimes(initialNormalizations);
            projectionDescribeMock.mockResolvedValueOnce({ supported: true, projection: structuredClone(projection) });
            const repeatedAnswer = await loadDaemonMergedProjectionCacheEntry({ ...params, reuseFreshReady: false });
            expect(repeatedAnswer?.kind === 'ready' && repeatedAnswer.inputs).toBe(first);
            expect(normalize).toHaveBeenCalledTimes(initialNormalizations);

            // Locale still obtains a fresh endpoint answer, but identical
            // source facts must not replace schema/catalog owners underneath
            // the live surface's locale-only context update.
            const describesBeforeLocale = projectionDescribeMock.mock.calls.length;
            textBoundary.locale = 'es';
            projectionDescribeMock.mockResolvedValueOnce({ supported: true, projection: structuredClone(projection) });
            const localeAnswer = await loadDaemonMergedProjectionInputs(params);
            expect(projectionDescribeMock).toHaveBeenCalledTimes(describesBeforeLocale + 1);
            expect(localeAnswer).toBe(first);
            expect(localeAnswer?.pluginUiProjection.composerAttachmentsById).toBe(first?.pluginUiProjection.composerAttachmentsById);
            expect(normalize).toHaveBeenCalledTimes(initialNormalizations);
            publishMachineContributionRegistryProjectionInvalidation(projectionScope);
            projectionDescribeMock.mockResolvedValueOnce({ supported: true, projection: {
                ...projection, familiesById: { pluginUi: { ...projection.familiesById.pluginUi, entriesById: {
                    ...projection.familiesById.pluginUi.entriesById,
                    'translations:acme.one': { ...projection.familiesById.pluginUi.entriesById['translations:acme.one'], bundles: { en: { title: 'Changed' } } },
                } } },
            } });
            const next = await loadDaemonMergedProjectionInputs(params);
            expect(next?.pluginUiProjection).not.toBe(first?.pluginUiProjection);
            expect(next?.pluginUiProjection.translationsByPluginId['acme.one']).not.toBe(first?.pluginUiProjection.translationsByPluginId['acme.one']);
            expect(next?.pluginUiProjection.translationsByPluginId['acme.two']).toBe(first?.pluginUiProjection.translationsByPluginId['acme.two']);
            expect(next?.pluginUiProjection.composerAttachmentsById).toBe(first?.pluginUiProjection.composerAttachmentsById);
            expect(normalize.mock.results.filter(result => result.type === 'return' && result.value === next?.pluginUiProjection)).toHaveLength(1);
        } finally {
            textBoundary.locale = 'en';
            normalize.mockRestore();
        }
    });

    it('retains unsupported answers across elapsed time, but revalidates changed and explicit fresh demand', async () => {
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        const params = { ...projectionScope, accountLifetime: account.lifetime, reuseFreshReady: true };
        const machineReads = () => network.httpRequests.filter(request => (
            new URL(request.url).pathname === '/v1/machines/read-batch'
        )).length;
        projectionDescribeMock.mockResolvedValue({ supported: false, reason: 'not-supported' });
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            await expect(loadDaemonMergedProjectionCacheEntry(params)).resolves.toMatchObject({ kind: 'unsupported' });
            expect(machineReads()).toBe(1);

            await expect(loadDaemonMergedProjectionCacheEntry(params)).resolves.toMatchObject({ kind: 'unsupported' });
            expect(machineReads()).toBe(1);
            expect(projectionDescribeMock).toHaveBeenCalledTimes(1);

            publishMachineContributionRegistryProjectionInvalidation(projectionScope);
            await expect(loadDaemonMergedProjectionCacheEntry(params)).resolves.toMatchObject({ kind: 'unsupported' });
            expect(machineReads()).toBe(2);

            await expect(loadDaemonMergedProjectionCacheEntry({ ...params, reuseFreshReady: false }))
                .resolves.toMatchObject({ kind: 'unsupported' });
            expect(machineReads()).toBe(3);

            // Age is not a registry or endpoint change.
            vi.setSystemTime(Date.now() + 60_001);
            await expect(loadDaemonMergedProjectionCacheEntry(params)).resolves.toMatchObject({ kind: 'unsupported' });
            expect(machineReads()).toBe(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each(['active', 'background'] as const)('reuses a settled describe for another reader of the same Account until the projection changes on an %s Home', async (placement) => {
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const { storage } = await import('@/sync/domains/state/storage');
        if (placement === 'active') {
            const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
            await upsertAndActivateServer({ serverUrl: 'https://server-1' });
        }
        const previousMachines = storage.getState().machines;
        const daemonState = { status: 'running', pid: 17, contributionRegistryProjectionRevision: 0 };
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', daemonStateVersion: 1, daemonState })], false, { sourceServerId: 'server-1' });
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

            await network.setAccount('https://server-1', 'account-b');
            await expect(read(nextAccount.lifetime)).resolves.toMatchObject({
                kind: 'ready', inputs: { pluginProjectionV2: { generation: 8 } },
            });
            expect(projectionDescribeMock).toHaveBeenCalledTimes(2);

            storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', daemonStateVersion: 2, daemonState: {
                ...daemonState, localServices: { v: 1, state: 'ready', runningCount: 1 },
            } })], false, { sourceServerId: 'server-1' });
            await expect(read(nextAccount.lifetime)).resolves.toMatchObject({
                kind: 'ready', inputs: { pluginProjectionV2: { generation: 8 } },
            });
            expect(projectionDescribeMock).toHaveBeenCalledTimes(2);

            storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', daemonStateVersion: 3, daemonState: {
                ...daemonState, contributionRegistryProjectionRevision: 1, localServices: { v: 1, state: 'ready', runningCount: 2 },
            } })], false, { sourceServerId: 'server-1' });
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

    it('lets inert catalog summaries observe publication and invalidation without starting daemon reads', async () => {
        const { loadDaemonMergedProjectionCacheEntry, readDaemonMergedProjectionSummary, subscribeDaemonMergedProjectionSummary } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        const summaries = Array.from({ length: 100 }, () => readDaemonMergedProjectionSummary(projectionScope));
        const unsubscribes = summaries.map((_, index) => subscribeDaemonMergedProjectionSummary(projectionScope, () => {
            summaries[index] = readDaemonMergedProjectionSummary(projectionScope);
        }));
        try {
            expect(summaries.every(summary => summary.inputs === null && !summary.current)).toBe(true);
            expect(projectionDescribeMock).not.toHaveBeenCalled();
            projectionDescribeMock.mockResolvedValue({ supported: true, projection: daemonProjection(7) });
            await loadDaemonMergedProjectionCacheEntry({ ...projectionScope, accountLifetime: account.lifetime });
            const published = readDaemonMergedProjectionSummary(projectionScope);
            expect(published.current).toBe(true);
            expect(summaries.every(summary => summary === published)).toBe(true);
            publishMachineContributionRegistryProjectionInvalidation(projectionScope);
            expect(summaries.every(summary => summary.inputs === published.inputs && !summary.current)).toBe(true);
            expect(projectionDescribeMock).toHaveBeenCalledTimes(1);
        } finally {
            for (const unsubscribe of unsubscribes) unsubscribe();
        }
    });

    it('prepares inert summaries before the first reader subscribes', async () => {
        const { loadDaemonMergedProjectionCacheEntry, readDaemonMergedProjectionSummary } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        projectionDescribeMock.mockResolvedValue({ supported: true, projection: daemonProjection(7) });
        await loadDaemonMergedProjectionCacheEntry({ ...projectionScope, accountLifetime: account.lifetime });
        // Instrument construction without replacing any internal logic. A
        // first getSnapshot must only return an already-published slice.
        const freeze = vi.spyOn(Object, 'freeze');
        try {
            const first = readDaemonMergedProjectionSummary(projectionScope);
            expect(first.current).toBe(true);
            for (let i = 0; i < 100; i++) expect(readDaemonMergedProjectionSummary(projectionScope)).toBe(first);
            expect(freeze).not.toHaveBeenCalled();
        } finally {
            freeze.mockRestore();
        }
    });

    it('keeps prepared descriptive keys live for invalidation, locale and Account retirement without crossing Homes', async () => {
        const { loadDaemonMergedProjectionCacheEntry, captureDaemonMergedProjectionReader } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        projectionDescribeMock.mockResolvedValue({ supported: true, projection: daemonProjection(7) });
        await loadDaemonMergedProjectionCacheEntry({ ...projectionScope, accountLifetime: account.lifetime });
        const reader = captureDaemonMergedProjectionReader(projectionScope);
        const foreign = captureDaemonMergedProjectionReader({ ...projectionScope, serverId: 'server-2' });
        const first = reader.readSummary();
        expect(first.current).toBe(true);
        expect(foreign.readSummary()).toMatchObject({ inputs: null, current: false });
        const notify = vi.fn();
        const stop = reader.subscribeSummary(notify);
        try {
            for (let index = 0; index < 100; index++) expect(reader.readSummary()).toBe(first);
            textBoundary.locale = 'fr';
            expect(reader.readSummary()).toMatchObject({ inputs: first.inputs, current: false });
            textBoundary.locale = 'en';
            expect(reader.readSummary()).toBe(first);
            publishMachineContributionRegistryProjectionInvalidation(projectionScope);
            expect(notify).toHaveBeenCalled();
            expect(reader.readSummary()).toMatchObject({ inputs: first.inputs, current: false });
            account.retire();
            expect(reader.readCached()).toBeNull();
            expect(reader.readSummary()).toMatchObject({ inputs: null, current: false });
        } finally { stop(); }
    });

    it.each(['settled', 'publishing'] as const)('keeps a reused settled projection while another same-Account reader remains mounted (%s)', async (joinAt) => {
        const { loadDaemonMergedProjectionCacheEntry, readDaemonMergedProjectionSummary, subscribeDaemonMergedProjectionSummary } = await import('./loadDaemonMergedProjectionInputs');
        const issuer = createAccountLifetime('account-a');
        const reader = createAccountLifetime('account-a');
        projectionDescribeMock.mockResolvedValue({ supported: true, projection: daemonProjection(7) });
        const read = (accountLifetime: ActiveServerAccountScopeLifetime) => loadDaemonMergedProjectionCacheEntry({
            ...projectionScope, accountLifetime, reuseFreshReady: true,
        });
        let observed = readDaemonMergedProjectionSummary(projectionScope);
        let reused: ReturnType<typeof read> | null = null;
        const unsubscribe = subscribeDaemonMergedProjectionSummary(projectionScope, () => {
            observed = readDaemonMergedProjectionSummary(projectionScope);
            // Publication notifies before the issuing promise leaves the
            // in-flight owner; a synchronous sibling can join at that boundary.
            if (joinAt === 'publishing' && observed.current && !reused) reused = read(reader.lifetime);
        });
        try {
            await read(issuer.lifetime);
            const published = readDaemonMergedProjectionSummary(projectionScope);
            expect(published.current).toBe(true);
            if (joinAt === 'settled') reused = read(reader.lifetime);
            expect(reused).not.toBeNull();
            await reused;
            issuer.retire();
            expect(observed).toBe(published);
            await read(reader.lifetime);
            expect(projectionDescribeMock).toHaveBeenCalledTimes(1);
            reader.retire();
            expect(observed).toEqual({ inputs: null, current: false });
        } finally {
            unsubscribe();
        }
    });

    it.each(['absent', 'direct', 'display-first'] as const)('reuses a current describe across first %s Machine inventory and revalidates a later daemon replacement', async hydration => {
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const { storage } = await import('@/sync/domains/state/storage');
        const previousMachines = storage.getState().machines;
        const account = createAccountLifetime('account-a');
        const read = () => loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1', serverId: 'server-1', accountLifetime: account.lifetime, reuseFreshReady: true,
        });
        storage.setState({ machines: Object.fromEntries(Object.entries(previousMachines).filter(([id]) => id !== 'machine-1')) });
        try {
            if (hydration !== 'absent') {
                storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', metadata: null,
                    daemonStateVersion: 0, daemonState: null,
                })], false, { sourceServerId: 'server-1' });
            }
            projectionDescribeMock.mockResolvedValue({ supported: true, projection: daemonProjection(7) });
            await expect(read()).resolves.toMatchObject({ kind: 'ready' });
            if (hydration === 'display-first') {
                storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', metadata: null,
                    daemonStateVersion: 1, daemonState: null,
                })], false, { sourceServerId: 'server-1' });
                await expect(read()).resolves.toMatchObject({ kind: 'ready' });
                expect(projectionDescribeMock).toHaveBeenCalledTimes(1);
            }
            storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', daemonStateVersion: 1,
                daemonState: { runtimeId: 'daemon-a', contributionRegistryProjectionRevision: 1 },
            })], false, { sourceServerId: 'server-1' });
            await expect(read()).resolves.toMatchObject({ kind: 'ready' });
            expect(projectionDescribeMock).toHaveBeenCalledTimes(1);

            storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', daemonStateVersion: 2,
                daemonState: { runtimeId: 'daemon-b', contributionRegistryProjectionRevision: 1 },
            })], false, { sourceServerId: 'server-1' });
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
        await network.setAccount('https://server-1', 'account-b');
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

    it('keeps one target request in flight while newer revisions coalesce behind it', async () => {
        // A daemon whose state keeps advancing while each describe is slow:
        // The issued read settles with its answer. Newer readers then make one
        // fresh request for the latest revision, without overlapping bodies.
        const pending: Array<(value: unknown) => void> = [];
        projectionDescribeMock.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');

        const first = loadDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId: 'server-1' });
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        publishMachineContributionRegistryProjectionInvalidation(projectionScope);
        const second = loadDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId: 'server-1' });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(pending).toHaveLength(1);
        publishMachineContributionRegistryProjectionInvalidation(projectionScope);

        pending[0]!({ supported: true, projection: daemonProjection(1) });
        await expect(first).resolves.toMatchObject({
            kind: 'ready',
            projectionRevision: initialRevision,
            inputs: { pluginProjectionV2: { generation: 1 } },
        });
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        pending[1]!({ supported: true, projection: daemonProjection(2) });
        await expect(second).resolves.toMatchObject({
            kind: 'ready',
            projectionRevision: initialRevision + 2,
            inputs: { pluginProjectionV2: { generation: 2 } },
        });
        // A late answer never replaces a newer one already published.
        const { readCachedDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId: 'server-1' }))
            .toMatchObject({ projectionRevision: initialRevision + 2 });
    });

    it('shares automatic failure recovery without delaying an explicit fresh read', async () => {
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        const params = { ...projectionScope, accountLifetime: account.lifetime };
        projectionDescribeMock
            .mockResolvedValueOnce({ supported: false, reason: 'timeout' })
            .mockResolvedValueOnce({ supported: true, projection: daemonProjection(7) });
        const failed = await loadDaemonMergedProjectionCacheEntry({ ...params, shareRetryCadence: true });
        expect(failed).toMatchObject({ kind: 'error', reason: 'timeout' });
        expect(await loadDaemonMergedProjectionCacheEntry({ ...params, shareRetryCadence: true })).toBe(failed);
        expect(projectionDescribeMock).toHaveBeenCalledTimes(1);
        await expect(loadDaemonMergedProjectionCacheEntry(params)).resolves.toMatchObject({
            kind: 'ready', inputs: { pluginProjectionV2: { generation: 7 } },
        });
        expect(projectionDescribeMock).toHaveBeenCalledTimes(2);
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
        beforeEach(async () => { await network.setAccount('https://server-1', 'account-default'); });
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
