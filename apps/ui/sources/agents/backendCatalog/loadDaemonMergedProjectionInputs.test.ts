import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { defineProtocolNumber, defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { AgentStateRequestCoverageOptions } from '@happier-dev/agents';
import type { DaemonProjectionSectionDemand } from './loadDaemonMergedProjectionInputs';
import { createDeferred, createMachineFixture } from '@/dev/testkit';
import { createPluginDeclarativeModelFixture } from '@/dev/testkit/fixtures/pluginDeclarativeModelFixture';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { createPluginContributionIdentity, buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { DaemonContributionRegistryProjectionSectionsResponseSchema, DaemonContributionRegistryProjectionDescribeResponseSchema,
    buildDeferredDaemonProjectionSections, DaemonProjectionSectionBodyResponseSchema,
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
    release(): void;
    heldRetirements(): number;
}> {
    let current = true;
    let released = false;
    const retireCallbacks = new Set<() => void>();
    const lifetime: ActiveServerAccountScopeLifetime = Object.freeze({
        scope: Object.freeze({ serverId, accountId }),
        isCurrent: () => current,
        isReleased: () => released,
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
        release: () => { released = true; },
        heldRetirements: () => retireCallbacks.size,
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
    it.each([
        ['contributed', 0], ['contributed', 1], ['bundled', 0], ['bundled', 1],
    ] as const)('uses selected contributed request coverage from the owning Machine projection (%s, layout %s)', async (selection, metadataLayoutVersion) => {
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { listPendingSessionRequests } = await import('@/sync/domains/session/pending/listPendingSessionRequests');
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } = await import('@happier-dev/agents/agent-ids');
        const account = createAccountLifetime('account-a');
        onTestFinished(() => account.retire());
        storage.getState().applyMachines([createMachineFixture({ id: projectionScope.machineId })],
            true, { sourceServerId: projectionScope.serverId });
        const identity = selection === 'bundled' ? BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.claude
            : { pluginId: 'acme.coverage', localId: 'agent' };
        const qualifiedId = buildQualifiedPluginContributionKey(identity);
        const agentId = selection === 'bundled' ? 'claude' : qualifiedId;
        const requestCoverage = { equivalentSources: ['acme_bridge'], equivalentCompletedReasons: ['acme_cancel'],
            equivalentCompletedStatuses: ['canceled' as const] } satisfies AgentStateRequestCoverageOptions;
        const projection = { ...daemonProjection(7), agentsById: { [qualifiedId]: {
            id: qualifiedId, identity, title: 'Contributed Agent', requestCoverage,
        } } };
        projectionDescribeMock.mockResolvedValue({ supported: true, projection });
        const loaded = await loadDaemonMergedProjectionCacheEntry({ ...projectionScope,
            accountLifetime: account.lifetime, sections: ['agentsById'] });
        expect(loaded?.kind).toBe('ready');
        const request = { tool: 'Shell', arguments: { command: 'pwd' }, createdAt: 10_500, source: 'acme_bridge' };
        const ownerMetadata = { flavor: agentId, runtimeDescriptorV1: { v: 1, agentId, agent: {} },
            machineId: projectionScope.machineId } as import('@happier-dev/session-core/state').Metadata;
        const session = createSessionFixture({ serverId: projectionScope.serverId, active: true, metadataLayoutVersion,
            metadata: metadataLayoutVersion === 1
                ? { v: 1, agentPresentation: { agentId } } as import('@happier-dev/session-core/state').Metadata
                : ownerMetadata,
            ...(metadataLayoutVersion === 1 ? { ownerMetadataView: ownerMetadata } : {}),
            agentState: { requests: { pending: request }, completedRequests: { pending: {
                ...request, createdAt: 1_000, completedAt: 10_000, status: 'canceled', reason: 'acme_cancel',
            } } },
        });
        expect(listPendingSessionRequests(session, [])).toEqual([]);
        expect(listPendingSessionRequests({ ...session, ...(metadataLayoutVersion === 1
            ? { ownerMetadataView: { ...ownerMetadata, machineId: 'other-machine' } }
            : { metadata: { ...ownerMetadata, machineId: 'other-machine' } }) }, [])
            .map(request => request.id)).toEqual(['pending']);
    });

    it('shares one admission and boundary parse across presented section consumers in a 20-Machine fleet', async () => {
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const { PluginProjectionV2Schema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const account = createAccountLifetime('account-a');
        onTestFinished(() => account.retire());
        const machines = Array.from({ length: 20 }, (_, index) => createMachineFixture({ id: `fleet-${index}` }));
        storage.getState().applyMachines(machines, true, { sourceServerId: 'server-1' });
        const snapshot = (generation: number) => buildDeferredDaemonProjectionSections(
            DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
                projectionDigest: String(generation).repeat(64), projection: { ...daemonProjection(generation),
                    agentsById: { codex: { id: 'codex', title: `Codex ${generation}` } },
                } }));
        let current = snapshot(1);
        const reads: { machineId: string; digest?: string }[] = [];
        network.setRpcAckResponder(async request => {
            const section = (request.payload as Readonly<{ sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>).sectionRead;
            reads.push({ machineId: request.targetId, digest: section?.digest });
            return { ok: true, result: section ? current.read(section.digest, section.offset, section.includeDigests) : current.manifest };
        });
        // Observe the real boundary parser; no projection/loader logic is substituted.
        const parse = vi.spyOn(PluginProjectionV2Schema, 'safeParse');
        onTestFinished(() => parse.mockRestore());
        const params = { machineId: machines[0]!.id, serverId: 'server-1', accountLifetime: account.lifetime };
        const results = await Promise.all(Array.from({ length: 20 }, (_, index) => loadDaemonMergedProjectionCacheEntry({
            ...params, sections: index % 2 === 0 ? ['agentsById'] : [],
        })));
        expect(results.every(result => result?.kind === 'ready')).toBe(true);
        expect(reads.filter(read => read.digest === undefined)).toHaveLength(1);
        // One packed index frame and one agent-body frame serve every reader.
        expect(reads.filter(read => read.digest !== undefined)).toHaveLength(2);
        expect(new Set(reads.map(read => read.machineId))).toEqual(new Set([machines[0]!.id]));
        expect(parse).toHaveBeenCalledTimes(1);
        expect(results[0]).toMatchObject({ inputs: { pluginProjectionV2: { agentsById: { codex: { title: 'Codex 1' } } } } });
        const settled = reads.length;
        await loadDaemonMergedProjectionCacheEntry({ ...params, sections: ['agentsById'], reuseFreshReady: true });
        expect(reads).toHaveLength(settled);
        expect(parse).toHaveBeenCalledTimes(1);
        current = snapshot(2);
        // Fixture creation uses the schema too; only subsequent ingress counts.
        parse.mockClear();
        publishMachineContributionRegistryProjectionInvalidation(params, 'authority');
        const fresh = await loadDaemonMergedProjectionCacheEntry({ ...params, sections: ['agentsById'], reuseFreshReady: true });
        expect(fresh).toMatchObject({ inputs: { pluginProjectionV2: { agentsById: { codex: { title: 'Codex 2' } } } } });
        expect(reads.filter(read => read.digest === undefined)).toHaveLength(2);
        expect(parse).toHaveBeenCalledTimes(1);
    });

    it('publishes retained plugin Network Join choices through the passive section reader without unrelated catalog renders', async () => {
        const { act } = await import('react-test-renderer');
        const { renderHook } = await import('@/dev/testkit');
        const { useMachineNetworkFacts } = await import('@/components/machines/security/network/useMachineNetworkFacts');
        const { relayAccessProviderDescriptorsById } = await import('@happier-dev/cli-common/relayAccess/catalog');
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        onTestFinished(() => account.retire());
        const selection = { provider: { pluginId: 'example.network', localId: 'netbird' }, config: {}, credentialRefs: [] };
        const base = createMachineFixture({ id: projectionScope.machineId });
        storage.getState().applyMachines([{ ...base, metadata: { ...base.metadata!, accessProviderSelections: [selection] } }],
            true, { sourceServerId: projectionScope.serverId });
        const accessProviders = { family: 'accessProviders', entriesById: {
            'example.network/netbird': { id: 'example.network/netbird', pluginId: 'example.network', pluginVersion: '1.0.0',
                definition: { ...relayAccessProviderDescriptorsById.tailscale!.definition, id: 'netbird',
                    actions: { inspect: 'inspect', join: 'join', leave: 'leave' } } },
        } };
        const snapshotFor = (generation: number, includeNetwork: boolean) => buildDeferredDaemonProjectionSections(
            DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
                projectionDigest: String(generation).repeat(64), projection: { ...daemonProjection(generation),
                    agentsById: { codex: { id: 'codex', title: `Codex ${generation}` } },
                    familiesById: includeNetwork ? { accessProviders } : {},
                } }));
        let snapshot = snapshotFor(1, true);
        network.setRpcAckResponder(async call => {
            const read = (call.payload as Readonly<{ sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>).sectionRead;
            return { ok: true, result: read ? snapshot.read(read.digest, read.offset, read.includeDigests) : snapshot.manifest };
        });
        let renders = 0;
        const hook = await renderHook(() => {
            renders++;
            return useMachineNetworkFacts({ ...projectionScope, enabled: true });
        });
        try {
            expect(hook.getCurrent().access?.privateNetworkJoin)
                .toEqual({ kind: 'unavailable', reason: 'provider_catalog_unavailable' });
            expect(network.requests).toHaveLength(0);
            await act(async () => { await loadDaemonMergedProjectionCacheEntry({ ...projectionScope,
                accountLifetime: account.lifetime, sections: ['familiesById.accessProviders'] }); });
            expect(hook.getCurrent().access?.privateNetworkJoin).toEqual({ kind: 'available',
                actionId: 'machines.reachability.configure', selections: [selection] });
            const initial = hook.getCurrent().access;
            renders = 0;
            snapshot = snapshotFor(2, true);
            await act(async () => { await loadDaemonMergedProjectionCacheEntry({ ...projectionScope,
                accountLifetime: account.lifetime, sections: ['agentsById', 'familiesById.accessProviders'] }); });
            expect(renders).toBe(0);
            expect(hook.getCurrent().access).toBe(initial);
            snapshot = snapshotFor(3, false);
            await act(async () => { await loadDaemonMergedProjectionCacheEntry({ ...projectionScope,
                accountLifetime: account.lifetime, sections: ['familiesById.accessProviders'] }); });
            expect(hook.getCurrent().access?.privateNetworkJoin)
                .toEqual({ kind: 'unavailable', reason: 'provider_catalog_unavailable' });
            expect(renders).toBe(1);
        } finally { await hook.unmount(); }
    });

    it('hydrates Machine Store kinds for AppShell UI demand without fetching unrelated catalogs or rereading on reopen', async () => {
        // JQ-R16: the admitted source exists, but AppShell's section demand
        // omitted Store declarations before the union ever received them.
        const { PLUGIN_UI_SECTIONS } = await import('@/sync/domains/plugins/ui/projectionSections');
        const { projectPluginStoreKindDeclarationV1 } = await import('@happier-dev/protocol/plugins/contributions/storeKinds');
        const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        onTestFinished(() => account.retire());
        const pluginId = 'qa.store-live';
        const kind = projectPluginStoreKindDeclarationV1({ pluginId, pluginVersion: '1.0.0', definition: {
            id: 'theme', title: 'Themes', viewId: 'store', operations: {
                list: 'list', read: 'read', installed: 'installed', prepare: 'prepare', acquire: 'acquire', manage: 'manage',
            },
        } });
        const snapshot = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projectionDigest: 'a'.repeat(64), projection: { ...daemonProjection(7),
                familiesById: { storeKinds: { family: 'storeKinds', entriesById: { [kind.id]: kind } } },
                agentsById: { codex: { id: 'codex', title: 'Codex' } },
            },
        }));
        const reads: string[] = [];
        network.setRpcAckResponder(async call => {
            const request = call.payload as Readonly<{ sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>;
            const read = request.sectionRead;
            reads.push(...(read ? [read.digest, ...read.includeDigests ?? []] : ['manifest']));
            return { ok: true, result: read ? snapshot.read(read.digest, read.offset, read.includeDigests) : snapshot.manifest };
        });
        const params = { ...projectionScope, accountLifetime: account.lifetime, sections: PLUGIN_UI_SECTIONS, reuseFreshReady: true };
        const answer = await loadDaemonMergedProjectionCacheEntry(params);
        expect(answer).toMatchObject({ kind: 'ready' });
        if (!answer || answer.kind !== 'ready') throw new Error('UI projection did not settle');
        const projection = normalizePluginUiProjection(answer.inputs.pluginProjectionV2!);
        expect(projection.storeKindsById[kind.id]?.definition).toEqual(kind.definition);
        expect(reads).not.toContain(snapshot.manifest.sections.agentsById);
        const beforeReopen = reads.length;
        expect(await loadDaemonMergedProjectionCacheEntry(params)).toBe(answer);
        expect(reads.length - beforeReopen).toBe(0);
    });

    it('hydrates the enabled bundled S3 destination for backup setup from AppShell demand', async () => {
        // QA-DATA-RESTORE-1109: an admitted/matched eadc source at 0.0.0
        // coexisted with an empty backupDestinationsById in the live UI.
        const { PLUGIN_UI_SECTIONS } = await import('@/sync/domains/plugins/ui/projectionSections');
        const { DEPLOYMENT_BACKUP_TEST_ACTION_ID_V1 } = await import('@happier-dev/protocol/deployments/deploymentActionIdsV1');
        const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        onTestFinished(() => account.retire());
        const pluginId = 'happier.backup.destinations';
        const occurrenceId = `${pluginId}:22`;
        const executionOrigin = { serverIdentityId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN',
            sourceRef: { machineId: 'eadc2422-b42b-478d-97b1-af9b530d5f08', pluginId,
                sourceCustody: { kind: 'development', registeredRootId: '/qa/packages/plugins/backup-destinations' } } } as const;
        storage.getState().applyMachines([createMachineFixture({ id: executionOrigin.sourceRef.machineId })],
            false, { sourceServerId: projectionScope.serverId });
        const destination = { id: `${pluginId}/s3`, pluginId, pluginVersion: '0.0.0', occurrenceId, executionOrigin,
            definition: { id: 's3', title: 'S3 object storage', resticTransport: 's3', locality: 'unknown',
                configSchema: { type: 'object', properties: { endpoint: { type: 'string' }, bucket: { type: 'string' },
                    prefix: { type: 'string' }, addressing: { type: 'string', enum: ['auto', 'dns', 'path'] } },
                    required: ['endpoint', 'bucket', 'prefix'], additionalProperties: false },
                credentialRoles: [{ role: 'repositoryPassword' }, { role: 'accessKeyId' }, { role: 'secretAccessKey' },
                    { role: 'sessionToken', optional: true }],
                actions: { test: { kind: 'hostAction', actionId: DEPLOYMENT_BACKUP_TEST_ACTION_ID_V1 },
                    open: { pluginId, localId: 's3/open' } } } };
        const snapshot = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projectionDigest: 'a'.repeat(64), projection: { ...daemonProjection(7),
                installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Backup destinations', version: '0.0.0',
                    enabled: true, occurrenceId, executionOrigin, source: { kind: 'development', locator: '/qa/backup-destinations' } } },
                familiesById: { backupDestinations: { family: 'backupDestinations', entriesById: { [destination.id]: destination } } },
                agentsById: { codex: { id: 'codex', title: 'Codex' } },
            },
        }));
        const reads: string[] = [];
        network.setRpcAckResponder(async call => {
            const request = call.payload as Readonly<{ sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>;
            const read = request.sectionRead;
            reads.push(...(read ? [read.digest, ...read.includeDigests ?? []] : ['manifest']));
            return { ok: true, result: read ? snapshot.read(read.digest, read.offset, read.includeDigests) : snapshot.manifest };
        });
        const params = { machineId: executionOrigin.sourceRef.machineId, serverId: projectionScope.serverId,
            accountLifetime: account.lifetime, sections: PLUGIN_UI_SECTIONS, reuseFreshReady: true };
        const answer = await loadDaemonMergedProjectionCacheEntry(params);
        expect(answer).toMatchObject({ kind: 'ready' });
        if (!answer || answer.kind !== 'ready') throw new Error('UI projection did not settle');
        const projection = normalizePluginUiProjection(answer.inputs.pluginProjectionV2!);
        expect(projection.installedPackagesById[pluginId]).toMatchObject({ enabled: true, version: '0.0.0' });
        expect(projection.backupDestinationsById[destination.id]).toEqual(destination);
        expect(reads).not.toContain(snapshot.manifest.sections.agentsById);
        const beforeReopen = reads.length;
        expect(await loadDaemonMergedProjectionCacheEntry(params)).toBe(answer);
        expect(reads.length - beforeReopen).toBe(0);
    });

    it('expands exact Search coverage through an unchanged manifest and reuses complete coverage on reopen', async () => {
        const { loadDaemonMergedProjectionCacheEntry, daemonProjectionHasSections } = await import('./loadDaemonMergedProjectionInputs');
        const { PLUGIN_SEARCH_SECTIONS } = await import('@/sync/domains/plugins/ui/projectionSections');
        const account = createAccountLifetime('account-a');
        onTestFinished(() => account.retire());
        const pluginId = 'qa.search';
        const action = (id: string) => ({ id, pluginId, occurrenceId: 'qa.search:7', title: id,
            scopes: ['global'], surfaces: ['ui'], placementBindings: [], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true });
        const snapshot = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projectionDigest: 'a'.repeat(64), projection: { ...daemonProjection(7),
                agentsById: { codex: { id: 'codex', title: 'Codex' } },
                actionsById: { 'qa.search/query': action('query'), 'qa.search/unrelated': action('unrelated') },
                familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                    'searchProvider:qa.search:entries': { id: 'searchProvider:qa.search:entries', pluginId, occurrenceId: 'qa.search:7',
                        contributionKind: 'searchProvider', descriptorId: 'entries', identity: { pluginId, localId: 'entries' },
                        action: { pluginId, localId: 'query' } },
                    translations: { id: 'translations', pluginId, occurrenceId: 'qa.search:7', contributionKind: 'translations' },
                } } },
            },
        }));
        let describes = 0;
        network.setRpcAckResponder(async call => {
            const request = call.payload as Readonly<{ knownProjectionDigest?: string; sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>;
            describes += 1;
            if (request.sectionRead) {
                const { digest, offset, includeDigests } = request.sectionRead;
                return { ok: true, result: snapshot.read(digest, offset, includeDigests) };
            }
            return { ok: true, result: request.knownProjectionDigest === snapshot.manifest.projectionDigest
                ? { protocolVersion: 1, unchanged: true, projectionDigest: snapshot.manifest.projectionDigest } : snapshot.manifest };
        });
        const params = { ...projectionScope, accountLifetime: account.lifetime, reuseFreshReady: true };
        const search = await loadDaemonMergedProjectionCacheEntry({ ...params, sections: PLUGIN_SEARCH_SECTIONS });
        expect(search).toMatchObject({ kind: 'ready' });
        if (!search || search.kind !== 'ready') throw new Error('Search did not settle');
        expect(Object.keys(search.inputs.pluginProjectionV2!.actionsById)).toEqual(['qa.search/query']);
        expect(daemonProjectionHasSections(search, PLUGIN_SEARCH_SECTIONS)).toBe(true);
        expect(daemonProjectionHasSections(search, ['actionsById', 'familiesById.pluginUi'])).toBe(false);
        const agent = await loadDaemonMergedProjectionCacheEntry({ ...params, sections: ['agentsById'] });
        expect(agent).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: {
            agentsById: { codex: { title: 'Codex' } }, actionsById: { 'qa.search/query': { id: 'query' } },
        } } });
        const full = await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params });
        expect(full).toMatchObject({ kind: 'ready' });
        if (!full || full.kind !== 'ready') throw new Error('Complete projection did not settle');
        expect(Object.keys(full.inputs.pluginProjectionV2!.actionsById)).toHaveLength(2);
        expect(Object.keys(full.inputs.pluginProjectionV2!.familiesById.pluginUi!.entriesById)).toHaveLength(2);
        expect(daemonProjectionHasSections(full, PLUGIN_SEARCH_SECTIONS)).toBe(true);
        const beforeReopen = describes;
        expect(await loadDaemonMergedProjectionCacheEntry({ ...params, sections: PLUGIN_SEARCH_SECTIONS })).toBe(full);
        expect(describes - beforeReopen).toBe(0);
    });

    it('shares one cold Browse inventory read for 512 unrelated contributions and reopens without Describe', async () => {
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const { DAEMON_AGENT_CATALOG_SECTIONS } = await import('./agentCatalogSections');
        const account = createAccountLifetime('account-a');
        onTestFinished(() => account.retire());
        const snapshot = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projectionDigest: 'a'.repeat(64), projection: {
                ...daemonProjection(7),
                agentsById: { codex: { id: 'codex', title: 'Codex' } },
                resourcesById: Object.fromEntries(Array.from({ length: 512 }, (_, index) => [
                    `acme.review/unused-${index}`,
                    { id: `unused-${index}`, pluginId: 'acme.review', resourceKind: 'config', scope: 'global', contentType: 'application/json' },
                ])),
            },
        }));
        const manifestReady = createDeferred<void>();
        const reads: Array<Readonly<{ sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>> = [];
        network.setRpcAckResponder(async call => {
            if (call.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) throw new Error('Unexpected RPC');
            const request = call.payload as (typeof reads)[number];
            reads.push(request);
            if (!request.sectionRead) {
                await manifestReady.promise;
                return { ok: true, result: snapshot.manifest };
            }
            const { digest, offset, includeDigests } = request.sectionRead;
            return { ok: true, result: snapshot.read(digest, offset, includeDigests) };
        });
        const params = { ...projectionScope, accountLifetime: account.lifetime, sections: DAEMON_AGENT_CATALOG_SECTIONS, reuseFreshReady: true };
        const first = loadDaemonMergedProjectionCacheEntry(params);
        const concurrent = loadDaemonMergedProjectionCacheEntry(params);
        try {
            await vi.waitFor(() => expect(reads).toHaveLength(1));
            manifestReady.resolve();
            const [answer, shared] = await Promise.all([first, concurrent]);
            expect(answer).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { agentsById: { codex: { title: 'Codex' } } } } });
            expect(shared).toBe(answer);
            // One manifest, one packed section-index frame, one packed body
            // frame. Digest-addressed indexes disclose the bodies to request;
            // both phases retain the existing wire-frame size boundary.
            console.info('BROWSE_INVENTORY_COST', JSON.stringify({ contributions: 512, describes: reads.length,
                manifests: reads.filter(read => !read.sectionRead).length }));
            expect.soft(reads).toHaveLength(3);
            const digests = reads.flatMap(read => read.sectionRead
                ? [read.sectionRead.digest, ...read.sectionRead.includeDigests ?? []] : []);
            expect.soft(digests).not.toContain(snapshot.manifest.sections.resourcesById);
            expect.soft(digests).not.toContain(snapshot.manifest.sections.actionsById);
            const beforeReopen = reads.length;
            expect(await loadDaemonMergedProjectionCacheEntry(params)).toBe(answer);
            expect(reads.length - beforeReopen).toBe(0);
        } finally {
            manifestReady.resolve();
            await Promise.allSettled([first, concurrent]);
        }
    });

    it('carries complete Describe coverage for the reported Channels Resources without inferring it from their presence', async () => {
        const { loadDaemonMergedProjectionInputs } = await import('./loadDaemonMergedProjectionInputs');
        const { readCompletePluginUiResourceDeclarations, normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
        const account = createAccountLifetime('account-a');
        // Sanitized incident identities; the Resource kind/scope below are a
        // constructed declaration, not recovered facts about the loaded daemon.
        const pluginId = 'happier.channels';
        const occurrenceId = 'happier.channels:27';
        const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
            ...daemonProjection(27), installedPackagesById: { [pluginId]: {
                id: pluginId, displayName: 'Channels', enabled: true, occurrenceId,
                source: { kind: 'bundled', locator: '@happier-dev/plugins-channels' },
            } }, resourcesById: Object.fromEntries(['bindings-v1', 'connections-v1'].map(id => [
                buildQualifiedPluginContributionKey({ pluginId, localId: id }),
                { id, pluginId, occurrenceId, resourceKind: 'config', scope: 'global', contentType: 'application/json' },
            ])),
        } }).projection;
        // Only daemon RPC is replaced; real Describe decoding, acquisition,
        // normalization and the downstream coverage reader remain composed.
        const snapshot = buildDeferredDaemonProjectionSections({ protocolVersion: 1, projectionDigest: 'c'.repeat(64), projection });
        network.setRpcAckResponder(async request => {
            if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) throw new Error('Unexpected RPC');
            const read = (request.payload as Readonly<{ sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>).sectionRead;
            return { ok: true, result: read ? snapshot.read(read.digest, read.offset, read.includeDigests) : snapshot.manifest };
        });
        try {
            const inputs = await loadDaemonMergedProjectionInputs({ sections: 'complete', ...projectionScope, accountLifetime: account.lifetime });
            expect(inputs?.pluginUiProjection.resourcesById).toMatchObject(projection.resourcesById);
            expect(readCompletePluginUiResourceDeclarations(inputs?.pluginUiProjection, pluginId, occurrenceId))
                .toBe(inputs?.pluginUiProjection.resourcesById);
            // The same two rows from an unqualified/partial projection still
            // cannot authorize a complete declaration-set consumer.
            const partial = normalizePluginUiProjection(projection);
            expect(partial.resourcesById).toMatchObject(projection.resourcesById);
            expect(readCompletePluginUiResourceDeclarations(partial, pluginId, occurrenceId)).toBeUndefined();
        } finally { account.retire(); }
    });

    it('retains admitted source projections across 26 Machines and repeated query windows until a real revision changes', async () => {
        const { loadDaemonMergedProjectionInputs } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        const machines = Array.from({ length: 26 }, (_, index) => createMachineFixture({
            id: `search-machine-${index}`, daemonStateVersion: 1,
            daemonState: { runtimeId: 'daemon-a', contributionRegistryProjectionRevision: 1 },
        }));
        storage.getState().applyMachines(machines, true, { sourceServerId: 'server-1' });
        let generation = 7;
        projectionDescribeMock.mockImplementation(async () => ({ supported: true, projection: daemonProjection(generation) }));
        const read = (machineId: string) => loadDaemonMergedProjectionInputs({ machineId, serverId: 'server-1',
            accountLifetime: account.lifetime, sections: ['agentsById', 'installedPackagesById'] });
        const machineReads = () => network.httpRequests.filter(request => new URL(request.url).pathname === '/v1/machines/read-batch').length;
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const first = await Promise.all(machines.map(machine => read(machine.id)));
            expect(first.every(inputs => inputs?.pluginProjectionV2?.generation === 7)).toBe(true);
            expect(projectionDescribeMock).toHaveBeenCalledTimes(26);
            const initialReads = machineReads();
            for (let window = 0; window < 3; window++) {
                vi.setSystemTime(Date.now() + 180_000);
                const next = await Promise.all(machines.map(machine => read(machine.id)));
                expect(next).toEqual(first);
            }
            expect({ describes: projectionDescribeMock.mock.calls.length - 26,
                machineReadBatches: machineReads() - initialReads }).toEqual({ describes: 0, machineReadBatches: 0 });

            generation = 8;
            const changed = { ...machines[0]!, daemonStateVersion: 2,
                daemonState: { runtimeId: 'daemon-a', contributionRegistryProjectionRevision: 2 } };
            storage.getState().applyMachines([changed], false, { sourceServerId: 'server-1' });
            const refreshed = await Promise.all(machines.map(machine => read(machine.id)));
            expect(refreshed[0]?.pluginProjectionV2?.generation).toBe(8);
            for (let index = 1; index < machines.length; index++) expect(refreshed[index]).toBe(first[index]);
            expect(projectionDescribeMock).toHaveBeenCalledTimes(27);
            expect(machineReads() - initialReads).toBe(1);
        } finally {
            vi.useRealTimers();
            account.retire();
        }
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
        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'shared-machine', serverId: homeA.id, accountLifetime: lifetimeA.lifetime });
        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'shared-machine', serverId: homeB.id, accountLifetime: lifetimeB.lifetime });
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
        const pending = loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'shared-machine', serverId: homeB.id, accountLifetime: lifetimeB.lifetime });
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

        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete',
            machineId: 'machine-1',
            serverId: 'server-1',
        });
        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete',
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

        await expect(loadDaemonMergedProjectionCacheEntry({ sections: 'complete',
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
        const first = loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...scope, signal: firstOwner.signal });
        const second = loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...scope, signal: secondOwner.signal });
        await vi.waitFor(() => expect(projectionDescribeMock).toHaveBeenCalledTimes(1));
        firstOwner.abort();
        await expect(first).resolves.toBeNull();
        let secondSettled = false;
        void second.then(() => { secondSettled = true; });
        expect(secondSettled).toBe(false);
        secondOwner.abort();
        await expect(second).resolves.toBeNull();
        await expect(loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...scope })).resolves.toMatchObject({ kind: 'ready' });
        expect(projectionDescribeMock).toHaveBeenCalledTimes(2);
    });

    it('shares exact mounted Action questions by currentness, retaining failures until Retry and isolating full readers', async () => {
        const { loadDaemonMergedProjectionCacheEntry, readCachedDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        onTestFinished(() => account.retire());
        const caller = { pluginId: 'acme.one', occurrenceId: 'one', sourceCustody: { kind: 'development' as const, registeredRootId: 'one-root' } };
        const action = { pluginId: 'acme.one', localId: 'read' };
        const params = { ...projectionScope, accountLifetime: account.lifetime,
            mountedActions: { callers: [caller], actions: [action] } };
        projectionDescribeMock.mockResolvedValue({ supported: true, projection: daemonProjection(7) });
        const answers = await Promise.all(Array.from({ length: 32 }, () => loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params })));
        expect(projectionDescribeMock).toHaveBeenCalledTimes(1);
        expect(projectionDescribeMock.mock.lastCall?.[1].payload).toMatchObject({ selection: 'mountedActions', locale: 'en', callers: [caller], actions: [action] });
        expect(answers.every(answer => answer === answers[0])).toBe(true);
        expect(readCachedDaemonMergedProjectionCacheEntry(projectionScope)).toBeNull();
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(Date.now() + 180_000);
            expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params })).toBe(answers[0]);
        } finally { vi.useRealTimers(); }
        expect(projectionDescribeMock).toHaveBeenCalledTimes(1);
        publishMachineContributionRegistryProjectionInvalidation(projectionScope, 'authority');
        projectionDescribeMock.mockResolvedValue({ supported: false, reason: 'not-supported' });
        expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params })).toMatchObject({ kind: 'unsupported' });
        await Promise.all(Array.from({ length: 32 }, () => loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params })));
        expect(projectionDescribeMock).toHaveBeenCalledTimes(2);
        projectionDescribeMock.mockResolvedValue({ supported: true, projection: daemonProjection(8) });
        expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params, reuseFreshReady: false })).toMatchObject({ kind: 'ready' });
        expect(projectionDescribeMock).toHaveBeenCalledTimes(3);
        expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params })).toMatchObject({ kind: 'ready' });
        expect(projectionDescribeMock).toHaveBeenCalledTimes(3);
        // A changed executable caller is a different question even at one Machine revision.
        expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params,
            mountedActions: { ...params.mountedActions, callers: [{ ...caller, occurrenceId: 'two' }] } })).toMatchObject({ kind: 'ready' });
        expect(projectionDescribeMock).toHaveBeenCalledTimes(4);
        expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...projectionScope, accountLifetime: account.lifetime })).toMatchObject({ kind: 'ready' });
        expect(projectionDescribeMock).toHaveBeenCalledTimes(5);
        expect(projectionDescribeMock.mock.lastCall?.[1].payload).not.toHaveProperty('selection');
    });

    it('narrows mounted inline translations through the real registered handler for each Account and captured locale', async () => {
        const { RpcHandlerManager } = await import(new URL('../../../../cli/src/api/rpc/RpcHandlerManager.ts', import.meta.url).href);
        const { registerDaemonContributionRegistryProjectionHandler } = await import(new URL('../../../../cli/src/rpc/handlers/daemonContributionRegistryProjection.ts', import.meta.url).href);
        const { createAuthoredAdmittedPluginRuntimeFixture } = await import(new URL('../../../../cli/src/plugins/testkit/admittedRuntime.ts', import.meta.url).href);
        const { createPluginManifestV2Fixture } = await import(new URL('../../../../cli/src/plugins/testkit/manifestV2Fixture.ts', import.meta.url).href);
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const pluginId = 'acme.mounted-locales';
        const locales = ['en', 'fr', 'de', 'es', 'it', 'ja', 'ko', 'pt', 'ru', 'zh'];
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{
            manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: {
                ui: { translations: locales.map(locale => ({ locale, messages: { greeting: `${locale}:${'x'.repeat(2048)}` } })) },
            } }),
            files: { 'daemon.mjs': 'export function activate() { throw new Error("Projection must stay cold"); }' },
        }] });
        onTestFinished(() => fixture.dispose());
        const account = createAccountLifetime('account-a');
        onTestFinished(() => account.retire());
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionMode: 'plain', logger: () => {} });
        registerDaemonContributionRegistryProjectionHandler(rpc, {
            resolveRuntimeRegistry: async () => fixture.registry, resolveGeneration: async () => 1,
            resolveInstalledPackages: async () => [], resolveServerFeaturesSnapshot: () => undefined,
            resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: 'srv_mounted_locales', machineId: 'machine-1' }),
        });
        const params = { ...projectionScope, accountLifetime: account.lifetime, mountedActions: { actions: [], callers: [{
            pluginId, occurrenceId: fixture.registry.readPluginOccurrenceId!(pluginId),
            sourceCustody: fixture.registry.readPluginSourceCustody!(pluginId),
        }] } };
        const bundleLocales = (reply: unknown) => {
            const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(reply);
            const family = response.projection.familiesById.pluginUi;
            const translations = family?.family === 'pluginUi' ? family.entriesById[`translations:${pluginId}`] : undefined;
            return Object.keys(translations && 'bundles' in translations ? translations.bundles ?? {} : {}).sort();
        };
        // The same producer proves that omitting locale would transfer all ten.
        const broad = await rpc.invokeLocal(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            { machineId: 'machine-1', selection: 'mountedActions', ...params.mountedActions });
        expect(bundleLocales(broad)).toHaveLength(locales.length);
        const replies: unknown[] = [];
        network.setRpcAckResponder(async request => {
            const reply = await rpc.invokeLocal(request.method, request.payload);
            replies.push(reply);
            return { ok: true, result: reply };
        });
        textBoundary.locale = 'fr';
        const french = await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params });
        expect(french).toMatchObject({ kind: 'ready', locale: 'fr' });
        expect.soft(bundleLocales(replies.at(-1))).toEqual(['en', 'fr']);
        expect.soft(JSON.stringify(replies.at(-1)).length).toBeLessThan(JSON.stringify(broad).length);
        expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params })).toBe(french);
        expect(replies).toHaveLength(1);
        textBoundary.locale = 'de';
        const german = await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params });
        expect(german).toMatchObject({ kind: 'ready', locale: 'de' });
        expect.soft(bundleLocales(replies.at(-1))).toEqual(['de', 'en']);
        expect(replies).toHaveLength(2);
        const successor = createAccountLifetime('account-b');
        onTestFinished(() => successor.retire());
        await network.setAccount('https://server-1', 'account-b');
        expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params, accountLifetime: successor.lifetime })).toMatchObject({ kind: 'ready' });
        expect.soft(bundleLocales(replies.at(-1))).toEqual(['de', 'en']);
        expect(replies).toHaveLength(3);
        expect(fixture.registry.activatedPluginIds.size).toBe(0);
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
        let manifests = 0;
        network.setRpcAckResponder(async request => {
            const payload = request.payload as Readonly<{ sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>;
            if (!payload.sectionRead) {
                manifests += 1;
                return { ok: true, result: current.manifest };
            }
            const { digest, offset, includeDigests } = payload.sectionRead;
            reads.push(digest, ...includeDigests ?? []);
            return { ok: true, result: current.read(digest, offset, includeDigests) };
        });
        const params = { ...projectionScope, accountLifetime: account.lifetime };
        expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params })).toMatchObject({ kind: 'ready',
            inputs: { automationEligibleEvents: [{ event: { title: 'Repository updated 7' } }] } });
        current = snapshot(8);
        publishMachineContributionRegistryProjectionInvalidation(projectionScope, 'authority');
        reads.length = 0;
        const narrow = await loadDaemonMergedProjectionCacheEntry({ ...params, sections: ['agentsById'] });
        expect(narrow).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 8 } } });
        expect(reads).not.toContain(current.manifest.sections.automationEligibleEvents);
        // A full reader still acquires its own coverage; neither completion
        // order may erase the other's same-manifest facts.
        current = snapshot(9);
        publishMachineContributionRegistryProjectionInvalidation(projectionScope, 'authority');
        const [concurrentNarrow, full] = await Promise.all([
            loadDaemonMergedProjectionCacheEntry({ ...params, sections: ['agentsById'] }),
            loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params }),
        ]);
        expect(full).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 9 },
            automationEligibleEvents: [{ event: { title: 'Repository updated 9' } }] } });
        expect(concurrentNarrow).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 9 } } });
        // Coverage demand is not another Machine generation: one manifest for
        // each of generations 7, 8 and 9, even when narrow demand arrives first.
        expect(manifests).toBe(3);
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
        const shellRead = loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'machine-1', serverId: 'server-1', accountLifetime: account.lifetime });
        const directRead = loadDaemonMergedProjectionInputs({ sections: 'complete', machineId: 'machine-1', serverId: 'server-1', accountLifetime: account.lifetime });
        await vi.waitFor(() => expect(projectionDescribeMock).toHaveBeenCalledTimes(1));
        resolveDescribe({ supported: true, projection: daemonProjection(7) });
        await expect(shellRead).resolves.toMatchObject({ kind: 'ready' });
        await expect(directRead).resolves.toMatchObject({
            pluginProjectionV2: { generation: 7 },
            pluginUiProjection: { generation: 7 },
        });
        const published = await directRead;
        const sibling = await loadDaemonMergedProjectionInputs({ sections: 'complete', machineId: 'machine-1', serverId: 'server-1', accountLifetime: account.lifetime });
        expect(sibling?.pluginUiProjection).toBe(published?.pluginUiProjection);

        // A later direct caller reuses the current revision's answer…
        await expect(loadDaemonMergedProjectionInputs({ sections: 'complete', machineId: 'machine-1', serverId: 'server-1', accountLifetime: account.lifetime }))
            .resolves.toMatchObject({ pluginProjectionV2: { generation: 7 } });
        expect(projectionDescribeMock).toHaveBeenCalledTimes(1);

        // …until the machine's projection revision advances.
        publishMachineContributionRegistryProjectionInvalidation(projectionScope, 'authority');
        projectionDescribeMock.mockResolvedValueOnce({ supported: true, projection: daemonProjection(8) });
        await expect(loadDaemonMergedProjectionInputs({ sections: 'complete', machineId: 'machine-1', serverId: 'server-1', accountLifetime: account.lifetime }))
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
        const initial = await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params });
        expect(initial?.kind).toBe('ready');
        expect(fullPayloads).toBe(1);
        publishMachineContributionRegistryProjectionInvalidation(projectionScope, 'authority');
        bytes.length = 0;
        const refreshed = await Promise.all(Array.from({ length: 32 }, () => loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params })));
        expect(projectionDescribeMock).toHaveBeenCalledTimes(2);
        expect(fullPayloads).toBe(1);
        expect(bytes).toHaveLength(1);
        expect(bytes[0]).toBeLessThanOrEqual(256);
        expect(refreshed.every(entry => entry?.kind === 'ready' && initial?.kind === 'ready' && entry.inputs === initial.inputs)).toBe(true);
        currentDigest = changedDigest;
        publishMachineContributionRegistryProjectionInvalidation(projectionScope, 'authority');
        const changed = await Promise.all(Array.from({ length: 32 }, () => loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params })));
        expect(projectionDescribeMock).toHaveBeenCalledTimes(3);
        expect(fullPayloads).toBe(2);
        expect(changed[0]).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 8 } } });
        textBoundary.locale = 'fr';
        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params });
        expect(projectionDescribeMock.mock.calls.at(-1)?.[1].payload).not.toHaveProperty('knownProjectionDigest');
        expect(fullPayloads).toBe(3);
    });

    it('rejects an unchanged reply without the exact held digest and degrades to full replies from older daemons', async () => {
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        const params = { ...projectionScope, accountLifetime: account.lifetime };
        projectionDescribeMock.mockResolvedValueOnce({ supported: true, unchanged: true, projectionDigest: 'a'.repeat(64) });
        expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params })).toMatchObject({ kind: 'error', reason: 'invalid-response' });
        projectionDescribeMock.mockResolvedValueOnce({ supported: true, projection: daemonProjection(7), projectionDigest: 'a'.repeat(64) });
        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params });
        projectionDescribeMock.mockResolvedValueOnce({ supported: true, unchanged: true, projectionDigest: 'b'.repeat(64) });
        expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params })).toMatchObject({ kind: 'error', reason: 'invalid-response' });
        projectionDescribeMock.mockResolvedValue({ supported: true, projection: daemonProjection(8) });
        expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params })).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 8 } } });
        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params });
        expect(projectionDescribeMock.mock.calls.at(-1)?.[1].payload).not.toHaveProperty('knownProjectionDigest');
    });

    it.each(['raw', 'unsupported-version', 'bad-page'] as const)('reads %s index frames through the real loader and daemon handler', async encoding => {
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
        let corrupt = encoding !== 'raw';
        network.setRpcAckResponder(async request => {
            const payload = { ...request.payload as Record<string, unknown> };
            requests.push({ ...payload });
            let reply = await rpc.invokeLocal(request.method, payload);
            if (corrupt && encoding === 'unsupported-version' && reply && typeof reply === 'object' && 'deferredSections' in reply) {
                reply = { ...reply, sectionFrameVersion: 3 };
            }
            if (corrupt && encoding === 'bad-page' && reply && typeof reply === 'object' && 'sectionBody' in reply) {
                reply = { ...reply, digest: '0'.repeat(64) };
            }
            frames.push(reply);
            return { ok: true, result: reply };
        });
        const account = createAccountLifetime('account-a');
        const params = { ...projectionScope, accountLifetime: account.lifetime };
        const result = await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params });
        if (encoding !== 'raw') {
            // Fail closed: no full-describe compatibility read and no retry.
            expect(result).toMatchObject({ kind: 'error', reason: 'invalid-response', retryAtMs: null,
                deferredHydrationRejection: encoding === 'bad-page' ? 'section-page-position' : 'manifest-admission' });
            expect(requests.every(request => request.deferredSections === true)).toBe(true);
            expect(requests.filter(request => request.sectionRead)).toHaveLength(encoding === 'bad-page' ? 1 : 0);
            const settledCount = requests.length;
            const { readDaemonMergedProjectionRetryDelayMs } = await import('./loadDaemonMergedProjectionInputs');
            expect(readDaemonMergedProjectionRetryDelayMs(result)).toBeNull();
            expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params, shareRetryCadence: true })).toBe(result);
            expect(requests).toHaveLength(settledCount);
            // A failed parallel hydration releases all carrier custody; fresh
            // demand reads current frames without old ones poisoning admission.
            corrupt = false;
            expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params, reuseFreshReady: false }))
                .toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 7 } } });
            account.retire();
            return;
        }
        expect(result, result?.kind === 'error' ? JSON.stringify({ reason: result.reason,
            hydration: result.deferredHydrationRejection }) : undefined)
            .toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 7 } } });
        const manifest = DaemonProjectionDeferredSectionsResponseSchema.parse(frames[0]);
        expect(manifest).toMatchObject({ sectionFrameVersion: 2 });
        const index = frames.map(frame => DaemonProjectionSectionBodyResponseSchema.safeParse(frame))
            .find(page => page.success && page.data.digest === manifest.sections.base);
        if (!index?.success) throw new Error('Missing base index');
        // Index frames travel as raw index text, never wrapped in a JSON array.
        expect(DaemonContributionRegistryProjectionSectionsResponseSchema.safeParse(JSON.parse(index.data.chunk)).success).toBe(true);
        expect(Math.max(...frames.map(frame => new TextEncoder().encode(JSON.stringify(frame)).length))).toBeLessThanOrEqual(49_152);
        frames.length = 0;
        publishMachineContributionRegistryProjectionInvalidation(projectionScope, 'authority');
        expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params })).toMatchObject({ kind: 'ready' });
        expect(frames).toHaveLength(1);
        expect(new TextEncoder().encode(JSON.stringify(frames[0])).length).toBe(124);
        account.retire();
    });

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

    it.each([false, true])('bounds first-paint and lazy frames and shares cold sections across real bundled Machines (provisioner: %s)', async provisioner => {
        // Logical daemons share one host-test process, whose daemon build cache
        // has one active runtime/context. Rebuilds must observe the same clock:
        // diagnostic observation timestamps otherwise turn this unchanged-input
        // cost fixture into changed content. The CLI cost owner does the same.
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
        onTestFinished(() => clock.mockRestore());
        // Independent host roots use the incumbent cross-package source resolver.
        const { RpcHandlerManager } = await import(new URL('../../../../cli/src/api/rpc/RpcHandlerManager.ts', import.meta.url).href);
        const { registerDaemonContributionRegistryProjectionHandler } = await import(new URL('../../../../cli/src/rpc/handlers/daemonContributionRegistryProjection.ts', import.meta.url).href);
        const { getResolvedContributionRegistry } = await import(new URL('../../../../cli/src/plugins/projection/registry/builtIn/snapshot.ts', import.meta.url).href);
        const { resolveExecutablePluginRuntimeRegistry } = await import(new URL('../../../../cli/src/plugins/runtime/resolveExecutablePluginRuntimeRegistry.ts', import.meta.url).href);
        const { mkdtemp } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'projection-sections-loader-'));
        const runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, contributes: getResolvedContributionRegistry(), generation: 1,
            resolveServerFeaturesSnapshot: () => undefined,
            resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }: Readonly<{ pluginId: string; rootPath: string }>) => ({
                kind: 'development', registeredRootId: `section-loader:${pluginId}`, canonicalRoot: rootPath, observedRevision: 1,
            }),
        });
        const ids = Array.from({ length: 3 }, (_, index) => `section-machine-${index}`);
        const daemons = new Map(ids.map(machineId => {
            const rpc = new RpcHandlerManager({ scopePrefix: machineId, encryptionMode: 'plain', logger: () => {} });
            registerDaemonContributionRegistryProjectionHandler(rpc, {
                resolveRuntimeRegistry: async () => runtime, resolveGeneration: async () => 1,
                resolveInstalledPackages: async () => [], resolveServerFeaturesSnapshot: () => undefined,
                resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: 'srv_sections', machineId }),
            });
            return [machineId, rpc] as const;
        }));
        const replies: { target: string; bytes: number; knownDigest: boolean; payload: unknown; transferred: readonly string[] }[] = [];
        const sectionSnapshots = new Map<string, ReturnType<typeof buildDeferredDaemonProjectionSections>>();
        const completeSnapshots = new Map<string, ReturnType<typeof DaemonContributionRegistryProjectionDescribeResponseSchema.parse>>();
        network.setRpcAckResponder(async request => {
            const rpc = daemons.get(request.targetId);
            if (!rpc) throw new Error('Unexpected section target');
            // Independent daemon processes retain independent immutable builds.
            // This in-process fixture shares the handler's single current build
            // cache, so interleaved section pages would rebuild the whole graph
            // whenever another logical Machine replaced that context. Capture
            // each body's real producer once at the network boundary; manifests
            // and conditional authority replies still enter the real handler.
            const payload = request.payload as Readonly<Record<string, unknown>> & Readonly<{
                sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] };
            }>;
            let reply: unknown;
            if (payload.sectionRead) {
                const snapshot = sectionSnapshots.get(request.targetId);
                if (!snapshot) throw new Error('Section request preceded its Machine manifest');
                reply = snapshot.read(payload.sectionRead.digest, payload.sectionRead.offset,
                    payload.sectionRead.includeDigests);
            } else {
                reply = await rpc.invokeLocal(request.method, request.payload);
                const manifest = DaemonProjectionDeferredSectionsResponseSchema.safeParse(reply);
                if (manifest.success && !sectionSnapshots.has(request.targetId)) {
                    const { deferredSections: _deferred, knownProjectionDigest: _known, ...fullRequest } = payload;
                    const raw = await rpc.invokeLocal(request.method, fullRequest);
                    const full = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(raw);
                    completeSnapshots.set(request.targetId, full);
                    if (!full.projectionDigest || full.projectionDigest !== manifest.data.projectionDigest) {
                        throw new Error('Immutable Machine fixture changed while capturing its section bodies');
                    }
                    // Ingress validates shape; retain the real producer's key
                    // order because digest-addressed bytes are not a reserialization.
                    const snapshot = buildDeferredDaemonProjectionSections({
                        ...(raw as typeof full), projectionDigest: full.projectionDigest,
                    });
                    if (Object.entries(snapshot.manifest.sections).some(([id, digest]) => manifest.data.sections[id] !== digest)) {
                        throw new Error('Captured section bytes differ from the real Machine manifest');
                    }
                    sectionSnapshots.set(request.targetId, snapshot);
                }
            }
            const page = DaemonProjectionSectionBodyResponseSchema.safeParse(reply);
            replies.push({ target: request.targetId, payload: request.payload, bytes: new TextEncoder().encode(JSON.stringify(reply)).length,
                transferred: page.success ? [...(page.data.offset === 0 ? [page.data.digest] : []), ...(page.data.bodies ?? []).map(body => body.digest)] : [],
                knownDigest: Boolean(request.payload && typeof request.payload === 'object' && 'knownProjectionDigest' in request.payload) });
            return { ok: true, result: reply };
        });
        const read = (machineId: string) => loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId, serverId: 'server-1', accountLifetime: account.lifetime });
        const legacy = await daemons.get(ids[0]!)!.invokeLocal(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            { machineId: ids[0]!, locale: 'en' });
        const legacyBytes = new TextEncoder().encode(JSON.stringify(legacy)).length;
        const firstPaintRequest = { machineId: ids[0]!, serverId: 'server-1', accountLifetime: account.lifetime,
            sections: provisioner
                ? ['familiesById.pluginUi', 'familiesById.machineProvisioners', 'familiesById.connectedAccounts', 'actionsById', 'resourcesById'] as const
                : ['agentsById', 'familiesById.pluginUi', 'familiesById.pluginBrowser',
                    'familiesById.connectedAccounts', 'familiesById.inputTypes', 'resourcesById'] as const };
        const firstPaint = await loadDaemonMergedProjectionCacheEntry(firstPaintRequest);
        expect(firstPaint?.kind).toBe('ready');
        console.info('COLD_FIRST_PAINT', JSON.stringify({ provisioner, firstFrameBytes: replies[0]?.bytes,
            largestFrameBytes: Math.max(...replies.map(reply => reply.bytes)), requests: replies.length }));
        // ORC measured 3.15 MB / 34.4 s. A 48 KiB decoded frame is ~64 KiB
        // encrypted: below one second at that observed rate, within the 1–2 s ping budget.
        expect(Math.max(...replies.map(reply => reply.bytes))).toBeLessThanOrEqual(48 * 1024);
        if (firstPaint?.kind !== 'ready') throw new Error('Missing first paint');
        if (provisioner) {
            expect(Object.keys(firstPaint.inputs.pluginProjectionV2?.actionsById ?? {}).length).toBeGreaterThan(0);
            expect(Object.keys(firstPaint.inputs.pluginProjectionV2?.agentsById ?? {})).toHaveLength(0);
            // One manifest admits this Machine; body/page reads share its
            // existing frame transport rather than re-admitting each section.
            expect(replies.filter(reply => !(reply.payload && typeof reply.payload === 'object' && 'sectionRead' in reply.payload))).toHaveLength(1);
            // The real bundled census has hundreds of Resource rows across
            // fewer packages. Packed reads must not fan out per Resource row.
            // This is a fixture cost contract, not a product request limit.
            expect(replies.length - 1).toBeLessThan(Object.keys(firstPaint.inputs.pluginProjectionV2?.installedPackagesById ?? {}).length);
        } else {
            expect(Object.keys(firstPaint.inputs.pluginProjectionV2?.actionsById ?? {})).toHaveLength(0);
            expect(Object.keys(firstPaint.inputs.pluginProjectionV2?.agentsById ?? {}).length).toBeGreaterThan(0);
        }
        const { readCachedDaemonMergedProjectionCacheEntry, captureDaemonMergedProjectionReader } = await import('./loadDaemonMergedProjectionInputs');
        expect(readCachedDaemonMergedProjectionCacheEntry(firstPaintRequest)).toBe(firstPaint);
        expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: ids[0]!, serverId: 'server-1' })).toBeNull();
        if (!provisioner) expect(captureDaemonMergedProjectionReader({ machineId: ids[0]!, serverId: 'server-1', sections: ['agentsById'] }).readCached()).toBe(firstPaint);
        expect(Object.keys(firstPaint.inputs.pluginUiProjection.reactNativeBundlesById).length).toBeGreaterThan(0);
        const actionDigest = firstPaint.deferredProjection?.manifest.sections.actionsById;
        expect(actionDigest).toBeTruthy();
        const sectionReads = () => replies.flatMap(reply => reply.payload && typeof reply.payload === 'object' && 'sectionRead' in reply.payload
            ? [reply.payload.sectionRead as Readonly<{ digest: string; offset: number }>] : []);
        expect(sectionReads().some(read => read.digest === actionDigest)).toBe(provisioner);
        const beforeUse = replies.length;
        const repeatedPaint = await loadDaemonMergedProjectionCacheEntry({ ...firstPaintRequest, reuseFreshReady: true });
        expect(repeatedPaint?.kind).toBe('ready');
        expect(replies).toHaveLength(beforeUse);
        const actionRequest = { ...firstPaintRequest, sections: ['actionsById'], reuseFreshReady: true };
        const actions = await loadDaemonMergedProjectionCacheEntry(actionRequest);
        expect(actions?.kind === 'ready' && Object.keys(actions.inputs.pluginProjectionV2?.actionsById ?? {}).length).toBeGreaterThan(0);
        expect(sectionReads().filter(read => read.digest === actionDigest && read.offset === 0)).toHaveLength(1);
        const afterUse = replies.length;
        await loadDaemonMergedProjectionCacheEntry(actionRequest);
        expect(replies).toHaveLength(afterUse);
        const results = await Promise.all(ids.map(read));
        expect(results.every(result => result?.kind === 'ready')).toBe(true);
        const completeFirstMachine = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(legacy);
        const completeRead = results[0];
        if (completeRead?.kind !== 'ready') throw new Error('Missing complete Machine result');
        expect(completeRead.inputs.composerSurfaceCatalog).toEqual(completeFirstMachine.composerSurfaceCatalog);
        expect(completeRead.inputs.pluginProjectionV2?.resourcesById).toEqual(completeFirstMachine.projection.resourcesById);
        const bytes = replies.reduce((total, reply) => total + reply.bytes, 0);
        const targetBytes = ids.map(id => replies.filter(reply => reply.target === id).reduce((total, reply) => total + reply.bytes, 0));
        // Preserve Round 7's 50-target byte budget using the measured cold seed
        // plus the larger of two distinct peer replies; body-once is checked below.
        const projected50Bytes = targetBytes[0]! + 49 * Math.max(...targetBytes.slice(1));
        console.info('SECTION_LOADER_WIRE', JSON.stringify({ legacyBytes: ids.length * legacyBytes, bytes,
            firstBytes: replies[0]?.bytes, targetBytes, projected50Bytes }));
        expect(projected50Bytes).toBeLessThan(50 * legacyBytes * 0.6);
        expect(Math.max(...replies.map(reply => reply.bytes))).toBeLessThanOrEqual(48 * 1024);
        const firstPages = replies.flatMap(reply => reply.transferred);
        expect(new Set(firstPages).size).toBe(firstPages.length);
        for (let index = 0; index < ids.length; index += 1) {
            const result = results[index];
            if (result?.kind !== 'ready') throw new Error('Missing Machine result');
            const complete = completeSnapshots.get(ids[index]!)!;
            expect(result.inputs.composerSurfaceCatalog).toEqual(complete.composerSurfaceCatalog);
            expect(result.inputs.automationEligibleEvents).toEqual(complete.automationEligibleEvents);
            expect(result.inputs.pluginProjectionV2?.familiesById.inputTypes).toEqual(complete.projection.familiesById.inputTypes);
            const entries = Object.values(result.inputs.pluginProjectionV2?.actionsById ?? {});
            expect(entries.some(entry => entry.executionOrigin && JSON.stringify(entry.executionOrigin).includes(ids[index]!))).toBe(true);
        }
        replies.length = 0;
        for (const machineId of ids) publishMachineContributionRegistryProjectionInvalidation({ machineId, serverId: 'server-1' }, 'authority');
        await Promise.all(ids.map(read));
        expect(replies).toHaveLength(ids.length);
        expect(replies.map(reply => ({ bytes: reply.bytes, knownDigest: reply.knownDigest })))
            .toEqual(ids.map(() => ({ bytes: 124, knownDigest: true })));
        account.retire();
    }, 120_000);

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
        const read = (machineId: string) => loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId, serverId: 'server-1', accountLifetime: account.lifetime });
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
        expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'one', serverId: peerHome.id, accountLifetime: peer.lifetime }))
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
        const account = createAccountLifetime('account-a');
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
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
        expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...projectionScope, accountLifetime: account.lifetime, shareRetryCadence: true }))
            .toMatchObject({ kind: 'error', reason: 'invalid-response', retryAtMs: null });
        const failedReads = reads;
        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...projectionScope, accountLifetime: account.lifetime, shareRetryCadence: true });
        expect(reads).toBe(failedReads);
        invalid = false;
        expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...projectionScope, accountLifetime: account.lifetime })).toMatchObject({ kind: 'ready' });
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
        const first = loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'issuer', serverId: 'server-1',
            accountLifetime: account.lifetime, signal: abort.signal });
        await vi.waitFor(() => expect(bodyReads).toEqual(['issuer']));
        const peer = loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'reader', serverId: 'server-1',
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
        const snapshots = new Map<string, ReturnType<typeof buildDeferredDaemonProjectionSections>>();
        const snapshot = (locale: string) => snapshots.get(locale) ?? snapshots.set(locale, buildDeferredDaemonProjectionSections(
            DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
                protocolVersion: 1, projectionDigest: (locale === 'en' ? 'e' : 'f').repeat(64),
                projection: { ...daemonProjection(7), installedPackagesById: { 'acme.one': {
                    id: 'acme.one', displayName: locale, enabled: true, source: { kind: 'bundled', locator: 'acme.one' },
                } } },
            }))).get(locale)!;
        network.setRpcAckResponder(async request => {
            const payload = request.payload as Readonly<{ locale: string; sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>;
            if (!payload.sectionRead) locales.push(payload.locale);
            if (request.targetId === 'seed') await seed;
            const read = payload.sectionRead;
            return { ok: true, result: read ? snapshot(payload.locale).read(read.digest, read.offset, read.includeDigests)
                : snapshot(payload.locale).manifest };
        });
        const read = (machineId: string) => loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId, serverId: 'server-1', accountLifetime: account.lifetime });
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

    it('revalidates through the real daemon handler and scoped transport with one full payload only for a changed target', async () => {
        // These independent hosts have different TypeScript @ roots. Vitest's
        // host-source resolver composes their real modules at the RPC boundary.
        const { RpcHandlerManager } = await import(new URL('../../../../cli/src/api/rpc/RpcHandlerManager.ts', import.meta.url).href);
        const { registerDaemonContributionRegistryProjectionHandler } = await import(new URL('../../../../cli/src/rpc/handlers/daemonContributionRegistryProjection.ts', import.meta.url).href);
        const { createResolvedContributionRegistry } = await import(new URL('../../../../cli/src/plugins/projection/registry/createResolvedContributionRegistry.ts', import.meta.url).href);
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const account = createAccountLifetime('account-a');
        const generations = new Map([['machine-1', 7], ['machine-2', 7]]);
        const daemons = new Map([...generations.keys()].map(machineId => {
            const rpc = new RpcHandlerManager({ scopePrefix: machineId, encryptionMode: 'plain', logger: () => {} });
            registerDaemonContributionRegistryProjectionHandler(rpc, {
                resolveRegistry: async () => createResolvedContributionRegistry({}),
                resolveGeneration: async () => generations.get(machineId),
                resolveInstalledPackages: async () => [],
                resolveServerFeaturesSnapshot: () => undefined,
            });
            return [machineId, rpc] as const;
        }));
        const replies: { target: string; full: boolean; bytes: number; sectionBody: boolean }[] = [];
        network.setRpcAckResponder(async request => {
            const rpc = daemons.get(request.targetId);
            if (!rpc) throw new Error('Unexpected projection target');
            const reply = await rpc.invokeLocal(request.method, request.payload);
            // The real transport below admits the handler's response. Observe
            // wire cost here without parsing the same body a second time.
            const full = typeof reply === 'object' && reply !== null && !('unchanged' in reply);
            replies.push({ target: request.targetId, full, sectionBody: Boolean(reply && typeof reply === 'object' && 'sectionBody' in reply),
                bytes: new TextEncoder().encode(JSON.stringify(reply)).length });
            return { ok: true, result: reply };
        });
        const read = (machineId: string, sections: DaemonProjectionSectionDemand = 'complete') => loadDaemonMergedProjectionCacheEntry({ machineId,
            sections, serverId: 'server-1', accountLifetime: account.lifetime });
        expect(await read('machine-1', ['agentsById'])).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 7 } } });
        // Explicit fresh callers must ask current authority even when this is
        // their first demand for a previously unacquired section.
        generations.set('machine-1', 8);
        expect(await read('machine-1')).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 8 } } });
        for (const target of generations.keys()) expect(await read(target)).toMatchObject({ kind: 'ready' });
        replies.length = 0;
        for (const target of generations.keys()) publishMachineContributionRegistryProjectionInvalidation({ machineId: target, serverId: 'server-1' }, 'authority');
        await Promise.all([...generations.keys()].flatMap(target => Array.from({ length: 32 }, () => read(target))));
        expect(replies).toHaveLength(2);
        expect(replies.every(reply => !reply.full && reply.bytes <= 256)).toBe(true);
        replies.length = 0;
        generations.set('machine-1', 9);
        publishMachineContributionRegistryProjectionInvalidation(projectionScope, 'authority');
        expect(await read('machine-1')).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 9 } } });
        expect(replies.filter(reply => !reply.sectionBody).map(reply => [reply.target, reply.full])).toEqual([['machine-1', true]]);
        expect(replies.every(reply => reply.bytes <= 48 * 1024)).toBe(true);
    });

    it('publishes normalized model slices once and retains unchanged rows across same-generation endpoint and locale refreshes', async () => {
        const { loadDaemonMergedProjectionInputs, loadDaemonMergedProjectionCacheEntry, subscribeDaemonMergedProjectionSummary } = await import('./loadDaemonMergedProjectionInputs');
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
        const notifications = vi.fn();
        const unsubscribe = subscribeDaemonMergedProjectionSummary(projectionScope, notifications);
        try {
            const params = { ...projectionScope, accountLifetime: account.lifetime };
            const first = await loadDaemonMergedProjectionInputs({ sections: 'complete', ...params });
            expect(first?.pluginUiProjection.translationsByPluginId['acme.one']).toBeDefined();
            expect(first?.pluginUiProjection.installedPackagesById['acme.one']?.resourceDeclarationsComplete).toBe(true);
            expect(normalize.mock.results.filter(result => result.type === 'return' && result.value === first?.pluginUiProjection)).toHaveLength(1);
            const initialNormalizations = normalize.mock.calls.length;
            for (let i = 0; i < 100; i++) {
                expect((await loadDaemonMergedProjectionInputs({ sections: 'complete', ...params }))?.pluginUiProjection).toBe(first?.pluginUiProjection);
            }
            expect(normalize).toHaveBeenCalledTimes(initialNormalizations);
            notifications.mockClear();
            projectionDescribeMock.mockResolvedValueOnce({ supported: true, projection: structuredClone(projection) });
            const repeatedAnswer = await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params, reuseFreshReady: false });
            expect(repeatedAnswer?.kind === 'ready' && repeatedAnswer.inputs).toBe(first);
            expect(normalize).toHaveBeenCalledTimes(initialNormalizations);
            expect(notifications).toHaveBeenCalledTimes(0);

            // Locale still obtains a fresh endpoint answer, but identical
            // source facts must not replace schema/catalog owners underneath
            // the live surface's locale-only context update.
            const describesBeforeLocale = projectionDescribeMock.mock.calls.length;
            textBoundary.locale = 'es';
            projectionDescribeMock.mockResolvedValueOnce({ supported: true, projection: structuredClone(projection) });
            const localeAnswer = await loadDaemonMergedProjectionInputs({ sections: 'complete', ...params });
            expect(projectionDescribeMock).toHaveBeenCalledTimes(describesBeforeLocale + 1);
            expect(localeAnswer).toBe(first);
            expect(localeAnswer?.pluginUiProjection.composerAttachmentsById).toBe(first?.pluginUiProjection.composerAttachmentsById);
            expect(normalize).toHaveBeenCalledTimes(initialNormalizations);
            publishMachineContributionRegistryProjectionInvalidation(projectionScope, 'authority');
            projectionDescribeMock.mockResolvedValueOnce({ supported: true, projection: {
                ...projection, familiesById: { pluginUi: { ...projection.familiesById.pluginUi, entriesById: {
                    ...projection.familiesById.pluginUi.entriesById,
                    'translations:acme.one': { ...projection.familiesById.pluginUi.entriesById['translations:acme.one'], bundles: { en: { title: 'Changed' } } },
                } } },
            } });
            notifications.mockClear();
            const next = await loadDaemonMergedProjectionInputs({ sections: 'complete', ...params });
            expect(notifications).toHaveBeenCalledTimes(1);
            expect(next?.pluginUiProjection).not.toBe(first?.pluginUiProjection);
            expect(next?.pluginUiProjection.translationsByPluginId['acme.one']).not.toBe(first?.pluginUiProjection.translationsByPluginId['acme.one']);
            expect(next?.pluginUiProjection.translationsByPluginId['acme.two']).toBe(first?.pluginUiProjection.translationsByPluginId['acme.two']);
            expect(next?.pluginUiProjection.composerAttachmentsById).toBe(first?.pluginUiProjection.composerAttachmentsById);
            expect(normalize.mock.results.filter(result => result.type === 'return' && result.value === next?.pluginUiProjection)).toHaveLength(1);
        } finally {
            unsubscribe();
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
            await expect(loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params })).resolves.toMatchObject({ kind: 'unsupported' });
            expect(machineReads()).toBe(1);

            await expect(loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params })).resolves.toMatchObject({ kind: 'unsupported' });
            expect(machineReads()).toBe(1);
            expect(projectionDescribeMock).toHaveBeenCalledTimes(1);

            publishMachineContributionRegistryProjectionInvalidation(projectionScope, 'authority');
            await expect(loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params })).resolves.toMatchObject({ kind: 'unsupported' });
            expect(machineReads()).toBe(2);

            await expect(loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params, reuseFreshReady: false }))
                .resolves.toMatchObject({ kind: 'unsupported' });
            expect(machineReads()).toBe(3);

            // Age is not a registry or endpoint change.
            vi.setSystemTime(Date.now() + 60_001);
            await expect(loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params })).resolves.toMatchObject({ kind: 'unsupported' });
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

        const read = (accountLifetime: ActiveServerAccountScopeLifetime) => loadDaemonMergedProjectionCacheEntry({ sections: 'complete',
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

            publishMachineContributionRegistryProjectionInvalidation(projectionScope, 'authority');
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
            await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...projectionScope, accountLifetime: account.lifetime });
            const published = readDaemonMergedProjectionSummary(projectionScope);
            expect(published.current).toBe(true);
            expect(summaries.every(summary => summary === published)).toBe(true);
            publishMachineContributionRegistryProjectionInvalidation(projectionScope, 'authority');
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
        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...projectionScope, accountLifetime: account.lifetime });
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
        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...projectionScope, accountLifetime: account.lifetime });
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
            publishMachineContributionRegistryProjectionInvalidation(projectionScope, 'authority');
            expect(notify).toHaveBeenCalled();
            expect(reader.readSummary()).toMatchObject({ inputs: first.inputs, current: false });
            account.retire();
            expect(reader.readCached()).toBeNull();
            expect(reader.readSummary()).toMatchObject({ inputs: null, current: false });
        } finally { stop(); }
    });

    it.each(['settled', 'publishing', 'refreshed'] as const)('keeps a reused settled projection while another same-Account reader remains mounted (%s)', async (joinAt) => {
        const { loadDaemonMergedProjectionCacheEntry, readDaemonMergedProjectionSummary, subscribeDaemonMergedProjectionSummary } = await import('./loadDaemonMergedProjectionInputs');
        const issuer = createAccountLifetime('account-a');
        const reader = createAccountLifetime('account-a');
        projectionDescribeMock.mockResolvedValue({ supported: true, projection: daemonProjection(7) });
        const read = (accountLifetime: ActiveServerAccountScopeLifetime) => loadDaemonMergedProjectionCacheEntry({ sections: 'complete',
            ...projectionScope, accountLifetime, reuseFreshReady: true,
        });
        let observed = readDaemonMergedProjectionSummary(projectionScope);
        let reused: ReturnType<typeof read> | null = null;
        const notifications = vi.fn();
        const unsubscribe = subscribeDaemonMergedProjectionSummary(projectionScope, () => {
            notifications();
            observed = readDaemonMergedProjectionSummary(projectionScope);
            // Publication notifies before the issuing promise leaves the
            // in-flight owner; a synchronous sibling can join at that boundary.
            if (joinAt === 'publishing' && observed.current && !reused) reused = read(reader.lifetime);
        });
        try {
            await read(issuer.lifetime);
            const published = readDaemonMergedProjectionSummary(projectionScope);
            expect(published.current).toBe(true);
            if (joinAt !== 'publishing') reused = read(reader.lifetime);
            expect(reused).not.toBeNull();
            await reused;
            if (joinAt === 'refreshed') await loadDaemonMergedProjectionCacheEntry({ sections: 'complete',
                ...projectionScope, accountLifetime: issuer.lifetime, reuseFreshReady: false,
            });
            const describeCount = projectionDescribeMock.mock.calls.length;
            notifications.mockClear();
            issuer.retire();
            expect(observed).toBe(published);
            expect(notifications).toHaveBeenCalledTimes(0);
            await read(reader.lifetime);
            expect(projectionDescribeMock).toHaveBeenCalledTimes(describeCount);
            reader.retire();
            expect(observed).toEqual({ inputs: null, current: false });
            expect(notifications).toHaveBeenCalledTimes(1);
        } finally {
            unsubscribe();
        }
    });

    it.each(['signed-out', 'switched'] as const)('serves no answer from a finished reader once its Account has %s, settled or held', async change => {
        const { loadDaemonMergedProjectionCacheEntry, readCachedDaemonMergedProjectionCacheEntry, readDaemonMergedProjectionSummary } = await import('./loadDaemonMergedProjectionInputs');
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const leave = async () => {
            if (change === 'signed-out') await TokenStorage.removeCredentialsForServerUrl('https://server-1', { serverId: 'server-1' });
            else expect(await TokenStorage.setCredentialsForServerUrl('https://server-1', { serverId: 'server-1' },
                { token: createAccountTokenForTests('account-b') })).toBe(true);
        };
        projectionDescribeMock.mockResolvedValue({ supported: true, projection: daemonProjection(7) });
        const settledReader = await captureLazyActionAccountContext('server-1');
        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...projectionScope, accountLifetime: settledReader.accountLifetime, reuseFreshReady: true });
        settledReader.dispose();
        expect(readCachedDaemonMergedProjectionCacheEntry(projectionScope)?.accountScope?.accountId).toBe('account-a');

        // A reader finishes while its describe is still held; the answer lands after the Account left.
        const held = createDeferred<{ supported: true; projection: ReturnType<typeof daemonProjection> }>();
        projectionDescribeMock.mockImplementation(() => held.promise);
        const inFlightReader = await captureLazyActionAccountContext('server-1');
        const inFlight = loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...projectionScope, accountLifetime: inFlightReader.accountLifetime, reuseFreshReady: false });
        await vi.waitFor(() => expect(projectionDescribeMock).toHaveBeenCalledTimes(2));
        inFlightReader.dispose();
        await leave();
        held.resolve({ supported: true, projection: daemonProjection(8) });
        await inFlight;

        expect(readCachedDaemonMergedProjectionCacheEntry(projectionScope)).toBeNull();
        expect(readDaemonMergedProjectionSummary(projectionScope)).toMatchObject({ inputs: null, current: false });
    });

    it('serves no answer read without an Account lifetime once that Home has signed out', async () => {
        const { loadDaemonMergedProjectionCacheEntry, readCachedDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        projectionDescribeMock.mockResolvedValue({ supported: true, projection: daemonProjection(7) });
        // No focused Account: nothing watches this Home's credential on behalf of the answer.
        const answer = await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...projectionScope, reuseFreshReady: true });
        expect(answer?.kind).toBe('ready');
        await TokenStorage.removeCredentialsForServerUrl('https://server-1', { serverId: 'server-1' });
        expect(readCachedDaemonMergedProjectionCacheEntry(projectionScope)).toBeNull();
    });

    it('retains no answer read without an Account lifetime when its describe was held across an Account change', async () => {
        const { loadDaemonMergedProjectionCacheEntry, readCachedDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const held = createDeferred<{ supported: true; projection: ReturnType<typeof daemonProjection> }>();
        projectionDescribeMock.mockImplementationOnce(() => held.promise);
        const issued = loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...projectionScope, reuseFreshReady: true });
        await vi.waitFor(() => expect(projectionDescribeMock).toHaveBeenCalledTimes(1));
        expect(await TokenStorage.setCredentialsForServerUrl('https://server-1', { serverId: 'server-1' },
            { token: createAccountTokenForTests('account-b') })).toBe(true);

        // Account B never joins the read issued for Account A; it asks for itself.
        projectionDescribeMock.mockResolvedValueOnce({ supported: true, projection: daemonProjection(9) });
        const successor = await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...projectionScope, reuseFreshReady: true });
        expect(projectionDescribeMock).toHaveBeenCalledTimes(2);
        expect(successor?.kind).toBe('ready');
        const owned = readCachedDaemonMergedProjectionCacheEntry(projectionScope);
        expect(owned).toBe(successor);

        held.resolve({ supported: true, projection: daemonProjection(8) });
        await issued;
        expect(readCachedDaemonMergedProjectionCacheEntry(projectionScope)).toBe(owned);
    });

    it('wakes a mounted summary when the only readers of its answer finished before their Account left', async () => {
        const { loadDaemonMergedProjectionCacheEntry, subscribeDaemonMergedProjectionSummary } = await import('./loadDaemonMergedProjectionInputs');
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        projectionDescribeMock.mockResolvedValue({ supported: true, projection: daemonProjection(7) });
        const reader = await captureLazyActionAccountContext('server-1');
        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...projectionScope, accountLifetime: reader.accountLifetime, reuseFreshReady: true });
        const notified = vi.fn();
        const unsubscribe = subscribeDaemonMergedProjectionSummary(projectionScope, notified);
        try {
            reader.dispose();
            notified.mockClear();
            await TokenStorage.removeCredentialsForServerUrl('https://server-1', { serverId: 'server-1' });
            expect(notified).toHaveBeenCalled();
        } finally { unsubscribe(); }
    });

    it('hands a settled answer from each finished reader to the next without retaining them or describing again', async () => {
        const { loadDaemonMergedProjectionCacheEntry, readDaemonMergedProjectionSummary, subscribeDaemonMergedProjectionSummary } = await import('./loadDaemonMergedProjectionInputs');
        projectionDescribeMock.mockResolvedValue({ supported: true, projection: daemonProjection(7) });
        // A mounted summary observer is what binds every reader's retirement.
        const unsubscribe = subscribeDaemonMergedProjectionSummary(projectionScope, () => {});
        try {
            const finished = Array.from({ length: 10 }, () => createAccountLifetime('account-a'));
            for (const reader of finished) {
                await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...projectionScope, accountLifetime: reader.lifetime, reuseFreshReady: true });
                reader.release();
            }
            const describes = projectionDescribeMock.mock.calls.length;
            const next = createAccountLifetime('account-a');
            expect((await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...projectionScope, accountLifetime: next.lifetime, reuseFreshReady: true }))?.kind).toBe('ready');
            expect(projectionDescribeMock).toHaveBeenCalledTimes(describes);
            expect(finished.reduce((held, reader) => held + reader.heldRetirements(), 0)).toBe(0);
            // Retiring the only reader that still holds the answer evicts this Account's copy.
            next.retire();
            expect(readDaemonMergedProjectionSummary(projectionScope)).toMatchObject({ inputs: null, current: false });
        } finally { unsubscribe(); }
    });

    it.each(['absent', 'direct', 'display-first'] as const)('reuses a current describe across first %s Machine inventory and revalidates a later daemon replacement', async hydration => {
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const { storage } = await import('@/sync/domains/state/storage');
        const previousMachines = storage.getState().machines;
        const account = createAccountLifetime('account-a');
        const read = () => loadDaemonMergedProjectionCacheEntry({ sections: 'complete',
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

        const reads = [shell, palette, surface].map((reader) => loadDaemonMergedProjectionCacheEntry({ sections: 'complete',
            machineId: 'machine-1',
            serverId: 'server-1',
            accountLifetime: reader.lifetime,
        }));
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        await network.setAccount('https://server-1', 'account-b');
        const successorRead = loadDaemonMergedProjectionCacheEntry({ sections: 'complete',
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

        const first = loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'machine-1', serverId: 'server-1' });
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        publishMachineContributionRegistryProjectionInvalidation(projectionScope, 'authority');
        const second = loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'machine-1', serverId: 'server-1' });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(pending).toHaveLength(1);
        publishMachineContributionRegistryProjectionInvalidation(projectionScope, 'authority');

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
        const failed = await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params, shareRetryCadence: true });
        expect(failed).toMatchObject({ kind: 'error', reason: 'timeout' });
        expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params, shareRetryCadence: true })).toBe(failed);
        expect(projectionDescribeMock).toHaveBeenCalledTimes(1);
        await expect(loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...params })).resolves.toMatchObject({
            kind: 'ready', inputs: { pluginProjectionV2: { generation: 7 } },
        });
        expect(projectionDescribeMock).toHaveBeenCalledTimes(2);
    });

    it('keeps the classified reason of a failed read with the last good inputs', async () => {
        projectionDescribeMock
            .mockResolvedValueOnce({ supported: true, projection: daemonProjection(3) })
            .mockResolvedValueOnce({ supported: false, reason: 'timeout' });
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');

        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'machine-1', serverId: 'server-1' });
        await expect(loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'machine-1', serverId: 'server-1' }))
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

            await expect(loadDaemonMergedProjectionCacheEntry({ sections: 'complete',
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

            await loadDaemonMergedProjectionCacheEntry({ sections: 'complete',
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
            const stale = loadDaemonMergedProjectionCacheEntry({ sections: 'complete',
                machineId: 'machine-1',
                serverId: 'server-1',
                accountLifetime: retainedTestAccountLifetime,
            });
            await vi.waitFor(() => expect(settleStaleResponse).toBeTypeOf('function'));

            publishMachineContributionRegistryProjectionInvalidation(projectionScope, 'authority');
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

        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete',
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
