// @vitest-environment jsdom
import '@happier-dev/protocol';
import * as React from 'react';
import { Platform } from 'react-native';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderScreen } from '@/dev/testkit';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { installPortableAccountPluginForTest } from '@/dev/testkit/harness/portableAccountPlugin';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { mergeInstalledPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { getInstalledPluginUiClientExecutableComposition } from '@/components/plugins/reactNative/clientExecutableContributions';
import { acquirePluginContextualResourceStore } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { resolvePluginContextualResourceBinding } from '@/components/plugins/surfaces/pluginResourceBinding';
import { usePluginSessionSurfaceTarget } from '@/components/plugins/surfaces/pluginSurfaceContext';
import { readPluginUiResourceProjection } from '@/sync/domains/plugins/ui/projection';
import { readRuntimeFetchHost } from '@/utils/system/runtimeFetch';
import { storage } from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { sync } from '@/sync/sync';
import { useSessionPluginRuntime } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { publishActivePluginCollectionChanges } from '@/sync/api/plugins/data/pluginCollectionChangeWatch';
import { normalizePluginAccountCollectionContractsV1, PluginCollectionContractReadRequestV1Schema,
    PluginCollectionQueryRequestV1Schema, PluginCollectionGetRequestV1Schema } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { encodePluginCollectionLogicalValueV1 } from '@happier-dev/protocol/plugins/data/collectionLogicalCodecV1';
import { normalizeStrictJsonValue, isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { SessionWorkStateV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import { PluginAccountSettingsReadResponseV1Schema } from '@happier-dev/protocol/plugins/settings/accountSettingsV1';
import { PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityCollectionWritersClaimActionOutputV1Schema, PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginAvailabilityIntentReadActionInputV1Schema, PluginAvailabilityIntentsListActionInputV1Schema, PluginAvailabilityIntentsListActionOutputV1Schema,
    PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_LOCAL_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { CHANNELS_PLUGIN } from '../../../../../../packages/plugins/channels/src/manifest';
import { activate as activateChannels } from '../../../../../../packages/plugins/channels/src/accountRuntime';
import { PLUGIN_MANIFEST as TRIAGE_MANIFEST } from '@happier-dev/plugins-triage/manifest';
import { activate as activateTriage } from '../../../../../../packages/plugins/triage/src/accountRuntime';
import { GITHUB_PLUGIN } from '../../../../../../packages/plugins/scm-github/src/manifest';
import { CHANNEL_STATE_COLLECTION } from '../../../../../../packages/plugins/channels/src/collections';
import { withChannelStateSessionIdentity } from '../../../../../../packages/plugins/channels/src/collectionMigrations';
import { sessionPullRequestBindingFixture } from '../../../../../../packages/plugins/channels/src/testkit/sessionPullRequestBindingFixture';
import { MemoryCollection } from '../../../../../../packages/plugins/channels/src/testkit/memoryCollection';
import { useDeploymentPreparationRead } from './useDeploymentPreparationRead';
import type { DeploymentPreparationRead } from './deploymentPreparationRead';

// Global setup has already loaded runtimeFetch with this platform boundary.
// Keep that same object so the actual placement owner observes the native host.
const originalPlatform = Platform.OS;
const { createRequire } = getVitestNodeBuiltin<typeof import('node:module')>('node:module');
const { pathToFileURL } = getVitestNodeBuiltin<typeof import('node:url')>('node:url');
let nativeFetchBoundary: Awaited<ReturnType<typeof loadVitestModuleForNodeRequire>> | undefined;
beforeEach(async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    // Native SDK consumers can enter through Metro's call-time CJS require.
    // Bridge the same mocked Expo transport into that loader as well as Vite.
    nativeFetchBoundary = await loadVitestModuleForNodeRequire(
        pathToFileURL(createRequire(import.meta.url).resolve('expo/fetch')), () => import('expo/fetch'));
});
afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    nativeFetchBoundary?.dispose();
    nativeFetchBoundary = undefined;
});
// Native networking delegates to the same real Home HTTP boundary used by the harness.
vi.mock('expo/fetch', () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init) }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Package declaration bytes only; actual authored Account activation and Resource logic stay real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', async () => {
    const base = await import('@/dev/testkit/mocks/bundledPluginUiAssets');
    const [{ CHANNELS_PLUGIN }, { PLUGIN_MANIFEST }, { GITHUB_PLUGIN }, { projectPluginPortableUiDeclarationsV1 }, { ingestPluginManifestV2 }, { normalizePluginAccountCollectionContractsV1 }] = await Promise.all([
        import('../../../../../../packages/plugins/channels/src/manifest'), import('@happier-dev/plugins-triage/manifest'),
        import('../../../../../../packages/plugins/scm-github/src/manifest'), import('@happier-dev/protocol/plugins/contributions/ui'),
        import('@happier-dev/protocol/plugins/manifest/ingest'),
        import('@happier-dev/protocol/plugins/data/collectionsV1'),
    ]);
    return { ...base, BUNDLED_PLUGIN_UI_APP_DECLARATIONS: [CHANNELS_PLUGIN.manifest, PLUGIN_MANIFEST, GITHUB_PLUGIN.manifest].map(authored => {
        const admitted = ingestPluginManifestV2(authored);
        if (!admitted.ok) throw new Error(`Invalid authored declaration bytes: ${JSON.stringify(admitted.diagnostics)}`);
        const manifest = admitted.manifest;
        return {
            pluginId: manifest.id, pluginVersion: manifest.version, packageName: manifest.id, displayName: manifest.displayName,
            normalizedManifest: manifest, artifactGraphs: [], entriesById: projectPluginPortableUiDeclarationsV1(manifest),
            collectionContracts: normalizePluginAccountCollectionContractsV1({ pluginId: manifest.id,
                contributions: manifest.contributes.accountCollections }).map(({ pluginId, collectionId, schemaVersion, contractDigest }) =>
                ({ pluginId, collectionId, schemaVersion, contractDigest })),
        };
    }) };
});

const manifests = [CHANNELS_PLUGIN.manifest, TRIAGE_MANIFEST, GITHUB_PLUGIN.manifest];
const contracts = manifests.flatMap(manifest => normalizePluginAccountCollectionContractsV1({
    pluginId: manifest.id, contributions: manifest.contributes.accountCollections,
}));
const rows = new MemoryCollection<Record<string, unknown>>();
// The installed Account already has its declaration-derived Collection writers.
// Cold installation/claiming is covered by the Data owner's composed suite.
const claimed = new Map(manifests.map(manifest => [manifest.id,
    PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.parse({ intent: { pluginId: manifest.id,
        desiredVersion: null, enabled: true, offlineUiHosting: 'disabled', revision: '1',
        writableCollections: contracts.filter(contract => contract.pluginId === manifest.id)
            .map(({ pluginId, collectionId, schemaVersion, contractDigest }) => ({ pluginId, collectionId, schemaVersion, contractDigest })),
    } }).intent] as const));
const intentRead = (pluginId: string) => PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
    hostingCapability: { enabled: false }, intent: claimed.get(pluginId) ?? null, release: null, uiArtifacts: [], packageAssets: [] });
const intentList = (knownPluginIds: readonly string[] = []) => {
    const pluginIds = [...new Set([...claimed.keys(), ...knownPluginIds])].sort();
    return PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1, pluginIds,
        failedPluginIds: [], intentReads: pluginIds.map(pluginId => ({ pluginId, response: intentRead(pluginId) })) });
};
// Validate authored HTTP responses before Sync can retry a malformed fixture.
intentList();
let cursor = 1;
let collectionReads = 0;
const boundaryFailures: string[] = [];
const validateChannelState = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
function stored(row: Readonly<{ rowId: string; revision: number; value: Record<string, unknown> }>) {
    const contract = contracts.find(contract => contract.pluginId === CHANNELS_PLUGIN.manifest.id && contract.collectionId === CHANNEL_STATE_COLLECTION.id);
    if (!contract) throw new Error('Missing authored Channels contract');
    const value = normalizeStrictJsonValue(row.value);
    if (!isJsonObject(value)) throw new Error('Expected a persisted Collection object');
    const encoded = encodePluginCollectionLogicalValueV1({ contract, value, isValidLogicalValue: candidate =>
        isValidPluginJsonSchemaValue(validateChannelState, candidate), encryptionMode: 'plain', material: null,
        randomBytes: length => new Uint8Array(length) });
    if (encoded.status !== 'encoded') throw new Error(`Invalid Collection boundary row: ${encoded.reason}`);
    return { rowId: row.rowId, revision: row.revision, content: encoded.content, projection: encoded.projection };
}
const runtime = installSessionPaneRuntimeTestHarness({ features: () => {
    const features = createRootLayoutFeaturesResponse();
    return { ...features, capabilities: { ...features.capabilities, accountStoredContentCompatibility: {
        v: 1, minimumProtocolVersion: 2, currentProtocolVersion: 3, declarationTransport: 'http-header-and-socket-auth-v1',
    } } };
}, request: async (url, init) => {
    try {
    const path = new URL(String(url)).pathname;
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) {
        return Response.json(intentRead(PluginAvailabilityIntentReadActionInputV1Schema.parse(body).pluginId));
    }
    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
        return Response.json(intentList(PluginAvailabilityIntentsListActionInputV1Schema.parse(body).knownPluginIds));
    }
    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
        return Response.json(PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 1,
            snapshots: [], inventoryComplete: true, releases: [] }));
    }
    if (path === '/v1/plugins/data/contract') {
        const { ref } = PluginCollectionContractReadRequestV1Schema.parse(body);
        const contract = contracts.find(contract => contract.pluginId === ref.pluginId && contract.collectionId === ref.collectionId);
        if (!contract) throw new Error(`Unexpected contract ${ref.pluginId}/${ref.collectionId}`);
        return Response.json({ access: 'writable', contract });
    }
    if (path === '/v1/plugins/data/query') {
        collectionReads++;
        const request = PluginCollectionQueryRequestV1Schema.parse(body);
        if (request.pluginId !== CHANNELS_PLUGIN.manifest.id || request.collectionId !== CHANNEL_STATE_COLLECTION.id) return Response.json({ rows: [], changeCursor: cursor });
        const page = await rows.query({ index: request.indexId, prefix: request.prefix, order: request.order, limit: request.limit });
        return Response.json({ rows: page.rows.map(stored), changeCursor: cursor });
    }
    if (path === '/v1/plugins/data/get') {
        const request = PluginCollectionGetRequestV1Schema.parse(body);
        const row = request.pluginId === CHANNELS_PLUGIN.manifest.id ? await rows.get(request.rowId) : null;
        return Response.json({ row: row ? stored(row) : null, absenceEpoch: 0 });
    }
    if (manifests.some(manifest => path === `/v1/account/plugin-settings/${manifest.id}`)) {
        return Response.json(PluginAccountSettingsReadResponseV1Schema.parse({ status: 'absent' }));
    }
    if (path.startsWith('/v1/account/plugin-storage/')) return Response.json({ status: 'absent' });
    return null;
    } catch (error) {
        boundaryFailures.push(error instanceof Error ? error.message : String(error));
        throw error;
    }
} });

it('shares the actual Session PR Resource and follows its Channels publication without a second acquisition', async () => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected real Home Account');
    expect(await readRuntimeFetchHost('https://session-pane.test')).toBe('native');
    await sync.refreshPluginAccountAvailability();
    const installed = [];
    for (const [manifest, activate] of [[TRIAGE_MANIFEST, activateTriage], [CHANNELS_PLUGIN.manifest, activateChannels]] as const) {
        const execution = await readPluginAccountAvailability(lifetime.scope).ensureCurrentAccountExecution(manifest.id);
        if (execution.kind !== 'available') throw new Error(`Authored fixture unavailable: ${execution.code}`);
        installed.push(await installPortableAccountPluginForTest({ manifest, activate, accountLifetime: lifetime, deferActivation: true,
            origin: { ...lifetime.scope, custodyId: execution.custodyId, sourceCustody: execution.sourceCustody } }));
    }
    const composition = getInstalledPluginUiClientExecutableComposition();
    const attempts = await composition.reconcile(installed.flatMap(plugin => plugin.activations));
    expect(attempts.every(attempt => attempt.result.ok)).toBe(true);
    const projection = mergeInstalledPluginUiProjections(installed.map(plugin => plugin.projection), null);
    const unpublish = publishCommittedAppShellPluginUiProjection(() => projection);
    const observed: { latest: DeploymentPreparationRead | null; target: ReturnType<typeof usePluginSessionSurfaceTarget>;
        runtime: ReturnType<typeof useSessionPluginRuntime> | null } = { latest: null, target: null, runtime: null };
    function Probe() {
        observed.latest = useDeploymentPreparationRead(lifetime!, { serverId: runtime.serverId, sessionId: 's1' });
        observed.target = usePluginSessionSurfaceTarget({ sessionId: 's1', serverId: runtime.serverId, authority: lifetime });
        observed.runtime = useSessionPluginRuntime({ address: { serverId: runtime.serverId, sessionId: 's1' } });
        return null;
    }
    const screen = await renderScreen(<Probe />, { wrapper: runtime.Wrapper });
    let lease: ReturnType<typeof acquirePluginContextualResourceStore> = null;
    try {
        await vi.waitFor(() => expect(observed.latest?.pullRequests, JSON.stringify({ result: observed.latest?.pullRequests, boundaryFailures }))
            .toMatchObject({ kind: 'ready', sessionId: 's1', pullRequests: [] }));
        const declaration = readPluginUiResourceProjection(projection?.resourcesById, { pluginId: TRIAGE_MANIFEST.id,
            localId: TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_LOCAL_ID_V1 });
        if (!declaration) throw new Error('Missing actual Triage Resource');
        const binding = resolvePluginContextualResourceBinding({ projection: observed.runtime?.pluginUiProjection ?? null,
            machineId: observed.runtime?.machineId ?? null, serverId: runtime.serverId,
            accountLifetime: lifetime, isCurrent: lifetime.isCurrent }, declaration,
        { kind: 'session', sessionId: 's1', ...(observed.target ? { target: observed.target } : {}) });
        if (!binding) throw new Error('Expected exact admitted Resource binding');
        lease = acquirePluginContextualResourceStore(binding);
        if (!lease) throw new Error('Expected existing shared Resource lease');
        const entry = lease.store.getEntry(TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_LOCAL_ID_V1);
        await vi.waitFor(() => expect(entry.getSnapshot(), JSON.stringify(entry.getSnapshot().error))
            .toMatchObject({ subscription: 'live', pending: 'idle' }));
        const before = collectionReads;
        const release = entry.subscribe(() => {}, true);
        await act(async () => { await Promise.resolve(); });
        expect(collectionReads).toBe(before);
        const owner = storage.getState().sessions.s1;
        if (!owner) throw new Error('Expected the actual addressed Session');
        const ownerMetadata = readSessionOwnerMetadataView(owner);
        if (!ownerMetadata) throw new Error('Expected hydrated owner metadata');
        const workState = SessionWorkStateV1Schema.parse({ v: 1, backendId: 'agent', updatedAt: 10,
            items: [{ id: 'prepare-task', kind: 'task', origin: 'vendor', status: 'active', title: 'Review deployment health', updatedAt: 10 }] });
        await act(async () => {
            storage.getState().applySessions([{ ...owner, metadataVersion: owner.metadataVersion + 1,
                ownerMetadataView: { ...ownerMetadata, sessionWorkStateV1: workState } }]);
            storage.getState().applyMessages('s1', [{ id: 'prose', localId: null, seq: 2, createdAt: 20,
                role: 'agent', isSidechain: false, content: [{ type: 'text', text: 'PR opened; all checks passed',
                    uuid: 'prose', parentUUID: null }] }]);
        });
        expect(observed.latest?.workState?.items[0]?.title).toBe('Review deployment health');
        await vi.waitFor(() => expect(entry.getSnapshot()).toMatchObject({ subscription: 'live', pending: 'idle' }));
        expect(collectionReads).toBe(before);
        const bindingValue = sessionPullRequestBindingFixture('prepare-pr', 's1', 42, 'merged');
        await rows.put(withChannelStateSessionIdentity(bindingValue, bindingValue.payload.target), { expectedRevision: 'absent' });
        cursor++;
        const contract = contracts.find(contract => contract.pluginId === CHANNELS_PLUGIN.manifest.id && contract.collectionId === CHANNEL_STATE_COLLECTION.id)!;
        await act(async () => publishActivePluginCollectionChanges([{ cursor, kind: 'pluginDomain',
            entityId: `pluginDomain/${CHANNELS_PLUGIN.manifest.id}/data-collection/${CHANNEL_STATE_COLLECTION.id}`, changedAt: 1,
            hint: { pluginDomain: 'dataCollection', pluginId: CHANNELS_PLUGIN.manifest.id, collectionId: CHANNEL_STATE_COLLECTION.id,
                contractDigest: contract.contractDigest, revision: 2, full: true } }]));
        await vi.waitFor(() => expect(observed.latest?.pullRequests).toMatchObject({ kind: 'ready', pullRequests: [{
            bindingId: 'prepare-pr', link: { number: 42, state: 'merged' }, nativeStatus: { kind: 'unavailable' },
        }] }));
        expect(observed.latest?.phase).toBe('pullRequest');
        expect(observed.latest?.validation).toEqual({ kind: 'unreported' });
        release();
        await act(async () => retireActiveServerAccountScopeLifetime());
        expect(observed.latest?.pullRequests).toBeNull();
    } finally {
        lease?.dispose(); await screen.unmount(); unpublish();
        for (const plugin of installed) await plugin.dispose();
    }
});
