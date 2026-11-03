import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginContributesV2Schema, PluginProjectionV2Schema, type PluginProjectionV2 } from '@happier-dev/protocol';
import { PluginSearchQueryV1Schema, PluginSearchResultV1Schema } from '@happier-dev/protocol/plugins/contributions/search-providers';
import type { PluginActionPresentUserAuthorizationFacts } from '@happier-dev/protocol/plugins/actions/invocation';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { DaemonPluginUiArtifactBytesReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
    PluginUiArtifactsManifestEntryV2Schema,
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';

import { createDeferred, createMachineFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { storage } from '@/sync/domains/state/storageStore';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { clearPluginAccountAvailabilityProjection, readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, useActivePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import * as availabilityProjection from '@/sync/domains/plugins/availability/projection';
import * as executionOriginSelection from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { PluginAccountAvailabilitySnapshot } from '@/sync/domains/plugins/availability/reader';
import { dispatchPluginSurfaceAction } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import { createPluginUiProjectedActionResolver, normalizePluginInstalledUiDeclarations } from '@/sync/domains/plugins/ui/projection';
import { mergeInstalledPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { getInstalledPluginUiClientExecutableComposition } from '@/components/plugins/reactNative/clientExecutableContributions';
import { derivePluginReactNativeBundleCacheKey } from '@/components/plugins/reactNative/bundleCache';
import { resolveProjectedPluginUiClientExecutables } from '@/components/plugins/reactNative/clientExecutableProjection';
import { buildPluginSearchProviderSections } from '@/components/appShell/search/pluginSearchProviderSections';
import { unloadAppShellProjectedClientExecutables } from './appShellClientExecutableActivation';
import { AppShellPluginUiProjectionProvider, useAppShellPluginUiProjection } from './AppShellPluginUiProjection';

const daemon = vi.hoisted(() => ({ projection: null as PluginProjectionV2 | null, peerProjection: null as PluginProjectionV2 | null, bytes: new Uint8Array(), artifactDigest: '',
    successorBytes: new Uint8Array(), successorDigest: '' }));
// Only the real network transport is replaced. Account, storage, projection,
// Artifact leases, CommonJS evaluation, registration and reconciliation stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(async ({ method, payload, machineId }) => {
        if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            return { protocolVersion: 1, projection: machineId === 'machine-peer' ? daemon.peerProjection : daemon.projection };
        }
        if (method === RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ) {
            const successor = typeof payload === 'object' && payload !== null && 'cacheIdentity' in payload
                && typeof payload.cacheIdentity === 'object' && payload.cacheIdentity !== null && 'artifactDigest' in payload.cacheIdentity
                && payload.cacheIdentity.artifactDigest === daemon.successorDigest;
            const bytes = successor ? daemon.successorBytes : daemon.bytes;
            const digest = successor ? daemon.successorDigest : daemon.artifactDigest;
            const { computePluginUiArtifactSha256DigestV1 } = await import('@happier-dev/protocol/plugins/ui');
            return DaemonPluginUiArtifactBytesReadResponseSchema.parse({ ok: true, artifactFamily: 'reactNative', cacheIdentity: { artifactDigest: digest },
                artifact: { artifactKind: 'reactNativeBundle', digest, format: 'plainJs', byteSize: bytes.byteLength },
                files: [{ relativePath: successor ? 'react-native/next/entry.cjs.bundle' : 'react-native/continuity/entry.cjs.bundle', digest: computePluginUiArtifactSha256DigestV1(bytes),
                    byteSize: bytes.byteLength, bytesBase64: Buffer.from(bytes).toString('base64') }] });
        }
        if (method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return { ok: true, inputSchema: {} };
        throw new Error(`Unexpected executable fixture RPC: ${method}`);
    });
});
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

const initialStorage = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const pluginId = 'acme.executable-continuity';
const peerPluginId = 'acme.cleanup-peer';
const actionId = 'hold';
const artifactId = 'continuity';
const serverIdentityId = 'srv_executable_continuity';
const platform = resolvePluginUiClientExecutablePlatform();
const origin = { serverIdentityId, materializationRef: { machineId: 'machine-live', materializationId: 'continuity-install', pluginId } } as const;

// This is a foreign plugin executable fixture, loaded and evaluated by the
// production CommonJS owner. Its pending work crosses no mocked internal owner.
const pluginBoundary: { pending: ReturnType<typeof createDeferred<string>>; cleanups: number; signal: AbortSignal | null;
    activationGate: ReturnType<typeof createDeferred<void>> | null; enteredActivation: boolean; evaluations: number;
    peerCleanupGate: ReturnType<typeof createDeferred<void>> | null; peerCleanupEntered: boolean; peerCleanupFinished: boolean } = {
    pending: createDeferred<string>(), cleanups: 0, signal: null, activationGate: null, enteredActivation: false, evaluations: 0,
    peerCleanupGate: null, peerCleanupEntered: false, peerCleanupFinished: false,
};
const fixtureGlobal = globalThis as typeof globalThis & { executableContinuityFixture?: typeof pluginBoundary };

afterEach(async () => {
    pluginBoundary.pending.resolve('cleanup');
    pluginBoundary.activationGate?.resolve();
    pluginBoundary.activationGate = null;
    pluginBoundary.peerCleanupGate?.resolve();
    pluginBoundary.peerCleanupGate = null;
    await standardCleanup();
    await unloadAppShellProjectedClientExecutables();
    clearPluginAccountAvailabilityProjection();
    await connection?.dispose();
    connection = null;
    storage.setState(initialStorage, true);
    delete fixtureGlobal.executableContinuityFixture;
    vi.restoreAllMocks();
});

async function mountClientExecutableFixture(options: { waitForAdmission?: boolean; admitPeer?: boolean; searchProvider?: boolean; coldDaemon?: boolean;
    artifactLabel?: string;
    scopedGrants?: PluginActionPresentUserAuthorizationFacts['scopedGrants'] } = {}) {
    pluginBoundary.pending = createDeferred<string>();
    pluginBoundary.cleanups = 0;
    pluginBoundary.signal = null;
    pluginBoundary.enteredActivation = false;
    pluginBoundary.evaluations = 0;
    pluginBoundary.peerCleanupEntered = false;
    pluginBoundary.peerCleanupFinished = false;
    connection = await restoreServerAccountForTest({ serverUrl: 'https://executable-continuity.test', serverIdentityId, accountId: 'account-continuity',
        request: async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/health') return Response.json({ status: 'ok' });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ version: 1, updatedAt: 1 }));
            // Real Sync owns census admission after restoration. An unserved
            // list would turn these hydrated fixture rows into stale supplies.
            if (path === '/v1/machines') return Response.json(['machine-live', 'machine-peer'].map(id =>
                createPlainMachineRowFixture({ id, accountId: 'account-continuity' })));
            return Response.json({ error: 'not_found' }, { status: 404 });
        } });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing real Account lifetime');
    const serverId = lifetime.scope.serverId;
    const machine = createMachineFixture({ id: 'machine-live', active: true, activeAt: Date.now(), daemonStateVersion: 1 });
    const peerMachine = createMachineFixture({ id: 'machine-peer', active: true, activeAt: Date.now(), daemonStateVersion: 1 });
    storage.setState({ profileScope: lifetime.scope, settingsScope: lifetime.scope, endpointStatus: 'online', isDataReady: true,
        machines: { [machine.id]: machine, [peerMachine.id]: peerMachine }, machineListByServerId: { [serverId]: [machine, peerMachine] },
        machineListStatusByServerId: { [serverId]: 'idle' }, settings: { ...storage.getState().settings,
            machineAdministrationTargetsLocalV1: { [`plugin.runOn:${pluginId}`]: { serverIdentityId, machineId: machine.id } } } });
    // Restoring display rows after the prior Account transport retires does not
    // re-observe those Machines. This fixture supplies a fresh census ingress.
    observeMachinePresenceForTest(lifetime.scope, [machine.id, peerMachine.id]);

    fixtureGlobal.executableContinuityFixture = pluginBoundary;
    daemon.bytes = new TextEncoder().encode(`// ${options.artifactLabel ?? 'continuity'}
    globalThis.executableContinuityFixture.evaluations += 1;
    exports.activate = async function(api) {
        globalThis.executableContinuityFixture.enteredActivation = true;
        api.actions.register('hold', async function(input, context) {
            globalThis.executableContinuityFixture.signal = context.signal;
            if (${options.searchProvider === true}) return { items: [{ id: 'match', title: input.query,
                command: { kind: 'openSurface', destination: 'details' } }], truncated: false };
            return await globalThis.executableContinuityFixture.pending.promise;
        });
        if (globalThis.executableContinuityFixture.activationGate) await globalThis.executableContinuityFixture.activationGate.promise;
        return function() { globalThis.executableContinuityFixture.cleanups += 1; };
    };`);
    const entryPath = 'react-native/continuity/entry.cjs.bundle';
    const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entryPath, bytes: daemon.bytes }]);
    const artifactGraph = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId, tier: 'reactNative', entry: entryPath,
        files: [{ relativePath: entryPath, digest: computePluginUiArtifactSha256DigestV1(daemon.bytes), byteSize: daemon.bytes.byteLength }],
        digest: artifactDigest, builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['activate'] }, hostUiApiRange: '^1.0.0' });
    daemon.artifactDigest = artifactDigest;
    daemon.successorBytes = new TextEncoder().encode(`exports.activate = function(api) {
        api.actions.register('next', async function() { return 'next'; });
        return async function() {
            globalThis.executableContinuityFixture.peerCleanupEntered = true;
            if (globalThis.executableContinuityFixture.peerCleanupGate) await globalThis.executableContinuityFixture.peerCleanupGate.promise;
            globalThis.executableContinuityFixture.peerCleanupFinished = true;
        };
    };`);
    const nextPath = 'react-native/next/entry.cjs.bundle';
    const successorDigest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: nextPath, bytes: daemon.successorBytes }]);
    daemon.successorDigest = successorDigest;
    const nextGraph = PluginUiArtifactsManifestEntryV2Schema.parse({ ...artifactGraph, artifactId: 'next', entry: nextPath, digest: successorDigest,
        files: [{ relativePath: nextPath, digest: computePluginUiArtifactSha256DigestV1(daemon.successorBytes), byteSize: daemon.successorBytes.byteLength }] });
    const action = { id: actionId, title: 'Hold', scopes: [options.searchProvider ? 'global' : 'session'], surfaces: ['ui'],
        placementBindings: options.searchProvider ? [] : ['detailsPanel'], dangerLevel: 'safe',
        ...(options.searchProvider ? { inputSchema: PluginSearchQueryV1Schema.jsonSchema, resultSchema: PluginSearchResultV1Schema.jsonSchema } : {}),
        execution: { target: 'client', client: { artifactId, exportName: 'activate' }, platforms: [platform] } };
    const contributes = PluginContributesV2Schema.parse({ actions: [action],
        ...(options.searchProvider ? { searchProviders: [{ id: 'entries', action: actionId }] } : {}) });
    const peerContributes = PluginContributesV2Schema.parse({ actions: [{ ...action, id: 'next', execution: { ...action.execution, client: { artifactId: 'next', exportName: 'activate' } } }] });
    // The describe producer withholds schemas from the public Action projection;
    // execution reads them through DAEMON_PLUGIN_ACTION_SCHEMAS_READ instead.
    const { inputSchema: _inputSchema, resultSchema: _resultSchema, ...projectedAction } = contributes.actions[0]!;
    const { inputSchema: _peerInputSchema, resultSchema: _peerResultSchema, ...projectedPeerAction } = peerContributes.actions[0]!;
    // Match buildInstalledPackagesById in CLI projection/registry/projection/v2.ts:
    // describe stamps the package's serving occurrence and install-registry origin.
    // Closed search-provider descriptors resolve authority through that package row.
    daemon.projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById: { [pluginId]: { id: pluginId, displayName: pluginId, version: '1.0.0', enabled: true,
            occurrenceId: origin.materializationRef.materializationId, executionOrigin: origin,
            source: { kind: 'registryPackage', locator: pluginId } } },
        agentsById: {},   resourcesById: {}, settingsById: {}, diagnostics: [],
        actionsById: { [`${pluginId}/${actionId}`]: { ...projectedAction, pluginId, available: true,
            occurrenceId: origin.materializationRef.materializationId, executionOrigin: origin,
            authorization: { generation: { targetGeneration: origin.materializationRef.materializationId,
                desiredGeneration: origin.materializationRef.materializationId,
                appliedGeneration: options.coldDaemon ? null : origin.materializationRef.materializationId },
                resourceSelections: [], scopedGrants: options.scopedGrants ?? [], serviceAvailability: [], operatingSystemAuthorization: [] } } },
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [`reactNativeBundle:${pluginId}:${actionId}`]: {
            id: `reactNativeBundle:${pluginId}:${actionId}`, pluginId, contributionKind: 'reactNativeBundle', contributionId: actionId,
            occurrenceId: origin.materializationRef.materializationId, executionOrigin: origin,
            generatedOwnerKind: 'clientContribution', artifactGraph, runtime: { decision: { state: 'load' }, loadPolicy: { source: 'installedArtifact' }, cacheIdentity: { artifactDigest },
                cacheKey: derivePluginReactNativeBundleCacheKey({ pluginId, contributionId: actionId, artifactId, artifactDigest, platform }) },
        } } } } });
    const firstAction = daemon.projection.actionsById[`${pluginId}/${actionId}`];
    const ownPluginUi = daemon.projection.familiesById.pluginUi;
    if (!ownPluginUi) throw new Error('Missing fixture plugin UI family');
    const firstBundle = ownPluginUi.entriesById[`reactNativeBundle:${pluginId}:${actionId}`];
    daemon.projection = PluginProjectionV2Schema.parse({ ...daemon.projection,
        installedPackagesById: { ...daemon.projection.installedPackagesById, [peerPluginId]: { ...daemon.projection.installedPackagesById[pluginId], id: peerPluginId,
            occurrenceId: 'peer-install', executionOrigin: { serverIdentityId, materializationRef: { machineId: peerMachine.id, pluginId: peerPluginId, materializationId: 'peer-install' } },
            displayName: peerPluginId, source: { kind: 'registryPackage', locator: peerPluginId } } },
        actionsById: { ...daemon.projection.actionsById, [`${peerPluginId}/next`]: { ...firstAction, ...projectedPeerAction, pluginId: peerPluginId,
            occurrenceId: 'peer-install', executionOrigin: { serverIdentityId, materializationRef: { machineId: peerMachine.id, pluginId: peerPluginId, materializationId: 'peer-install' } }, available: options.admitPeer === true } },
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: { ...ownPluginUi.entriesById,
            [`reactNativeBundle:${peerPluginId}:next`]: { ...firstBundle, id: `reactNativeBundle:${peerPluginId}:next`, pluginId: peerPluginId, contributionId: 'next',
                occurrenceId: 'peer-install', executionOrigin: { serverIdentityId, materializationRef: { machineId: peerMachine.id, pluginId: peerPluginId, materializationId: 'peer-install' } }, artifactGraph: nextGraph,
                runtime: { decision: { state: 'load' }, loadPolicy: { source: 'installedArtifact' }, cacheIdentity: { artifactDigest: successorDigest },
                    cacheKey: derivePluginReactNativeBundleCacheKey({ pluginId: peerPluginId, contributionId: 'next', artifactId: 'next', artifactDigest: successorDigest, platform }) } } } } } });
    const combined = daemon.projection;
    const combinedPluginUi = combined.familiesById.pluginUi;
    if (!combinedPluginUi) throw new Error('Missing combined fixture plugin UI family');
    daemon.peerProjection = PluginProjectionV2Schema.parse({ ...combined,
        installedPackagesById: { [peerPluginId]: combined.installedPackagesById[peerPluginId] },
        actionsById: { [`${peerPluginId}/next`]: combined.actionsById[`${peerPluginId}/next`] },
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [`reactNativeBundle:${peerPluginId}:next`]: combinedPluginUi.entriesById[`reactNativeBundle:${peerPluginId}:next`] } } } });
    daemon.projection = PluginProjectionV2Schema.parse({ ...combined,
        installedPackagesById: { [pluginId]: combined.installedPackagesById[pluginId] }, actionsById: { [`${pluginId}/${actionId}`]: firstAction },
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [`reactNativeBundle:${pluginId}:${actionId}`]: firstBundle,
            ...(options.searchProvider ? { [`searchProvider:${pluginId}:entries`]: {
                id: `searchProvider:${pluginId}:entries`, pluginId, occurrenceId: origin.materializationRef.materializationId,
                contributionKind: 'searchProvider', descriptorId: 'entries',
                // Match projectSearchProviders' closed descriptor arm; execution origin belongs to the referenced Action.
                identity: { pluginId, localId: 'entries' }, action: { pluginId, localId: actionId },
            } } : {}),
        } } } });
    const slot = { contributionId: actionId, artifactId, tier: 'reactNative' as const, platform, artifactDigest, hostUiApiRange: '^1.0.0' };
    const slots = [slot];
    const peerSlot = { ...slot, contributionId: 'next', artifactId: 'next', artifactDigest: successorDigest };
    const archiveDigestSha256: PluginUiArtifactDigestV1 = `sha256:${'a'.repeat(64)}`;
    const materialization = { serverIdentityId, machineId: machine.id, materializationId: origin.materializationRef.materializationId, pluginId,
        version: '1.0.0', sourceClass: 'registryPackage' as const, portableRelease: true, archiveDigestSha256, uiArtifacts: slots, enabled: true, trustState: 'trusted' as const, observedAt: 1 } satisfies PluginAccountAvailabilitySnapshot['materializations'][number];
    let snapshot: PluginAccountAvailabilitySnapshot = { availabilityCursor: 1,
        intentReads: [{ pluginId, response: { availabilityCursor: 1, packageAssets: [], hostingCapability: { enabled: false },
            intent: { pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
            release: { ref: { pluginId, version: '1.0.0' }, archiveDigestSha256, normalizedManifest: { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: pluginId,
                engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, hostAccess: { required: [], optional: [] }, secrets: [], contributes }, collectionContracts: [], uiSlots: slots,
                packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } }, uiArtifacts: [] } }],
        materializations: [materialization], snapshots: [{ serverIdentityId, machineId: machine.id, materializations: [materialization] }] };
    const ownIntent = snapshot.intentReads[0];
    const peerMaterialization = { ...materialization, machineId: peerMachine.id, pluginId: peerPluginId, materializationId: 'peer-install', uiArtifacts: [peerSlot] };
    const peerIntent = ownIntent?.response.intent;
    const peerRelease = ownIntent?.response.release;
    if (!ownIntent || !peerIntent || !peerRelease) throw new Error('Missing fixture release');
    const intentReads: PluginAccountAvailabilitySnapshot['intentReads'] = [...snapshot.intentReads, { pluginId: peerPluginId, response: { ...ownIntent.response,
        intent: { ...peerIntent, pluginId: peerPluginId }, release: { ...peerRelease, ref: { ...peerRelease.ref, pluginId: peerPluginId },
            normalizedManifest: { ...peerRelease.normalizedManifest, id: peerPluginId, displayName: peerPluginId, contributes: peerContributes }, uiSlots: [peerSlot] } } }];
    const materializations = [...snapshot.materializations, peerMaterialization];
    snapshot = { ...snapshot, intentReads, materializations, snapshots: [{ serverIdentityId, machineId: machine.id, materializations: [materialization] },
        { serverIdentityId, machineId: peerMachine.id, materializations: [peerMaterialization] }] };
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot });
    const reader = readPluginAccountAvailability(lifetime.scope);
    expect(reader.readCurrentArtifact({ pluginId, contributionId: actionId, tier: 'reactNative', platform })).toMatchObject({ kind: 'available' });
    let observed: ReturnType<typeof useAppShellPluginUiProjection> | null = null;
    const readObserved = (): ReturnType<typeof useAppShellPluginUiProjection> | null => observed;
    let observedAt: number | undefined;
    function Probe() {
        observed = useAppShellPluginUiProjection();
        const inventory = useActivePluginAccountAvailabilityReader()?.readMaterializations();
        observedAt = inventory?.kind === 'available' ? inventory.materializations[0]?.observedAt : undefined;
        return null;
    }
    const screen = await renderScreen(<AppShellPluginUiProjectionProvider><Probe /></AppShellPluginUiProjectionProvider>);
    const composition = getInstalledPluginUiClientExecutableComposition();
    const address = { family: 'actions' as const, pluginId, localId: actionId, target: { artifactId, exportName: 'activate', platform }, executionOrigin: origin,
        occurrenceId: origin.materializationRef.materializationId };
    const dispatch = () => dispatchPluginSurfaceAction({ action: { pluginId, localId: actionId }, input: null, clientAction: { sessionId: 'session-continuity' },
        resolveContributedAction: identity => createPluginUiProjectedActionResolver(readObserved()?.pluginUiProjection?.actionsById)(identity) });
    const fixture = { lifetime, machine, peerMachine, materialization, snapshot, address, composition, screen, dispatch,
        readObserved, readObservedAt: () => observedAt };
    if (options.waitForAdmission === false) return { ...fixture, registration: null };
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(readObserved()?.unavailableReasonCode).toBeUndefined();
        expect(observed).toMatchObject({ phase: 'current', clientExecutableActivation: { status: 'ready' } });
    });
    expect(lifetime.isCurrent()).toBe(true);
    const current = readObserved();
    expect(current?.accountLifetime).toBe(lifetime);
    expect(readPluginAccountAvailability(lifetime.scope).readCurrentArtifact({ pluginId, contributionId: actionId, tier: 'reactNative', platform })).toMatchObject({ kind: 'available' });
    const normalizedTargets = resolveProjectedPluginUiClientExecutables({ actionProjection: current?.pluginUiProjection ? { projection: current.pluginUiProjection } : null, platform });
    expect(normalizedTargets).toHaveLength(options.admitPeer ? 2 : 1);
    expect(normalizedTargets.find(target => target.pluginId === pluginId)?.authority).toEqual({ machineId: machine.id, serverId });
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(observed).toMatchObject({ phase: 'current', clientExecutableActivation: { status: 'ready' } });
        expect(observed?.pluginUiProjection?.actionsById[`${pluginId}/${actionId}`]).toMatchObject({ available: true, occurrenceId: origin.materializationRef.materializationId });
        expect(resolveProjectedPluginUiClientExecutables({ actionProjection: observed?.pluginUiProjection ? { projection: observed.pluginUiProjection } : null, platform })).toHaveLength(options.admitPeer ? 2 : 1);
        expect(composition.read(address)).not.toBeNull();
    });
    const registration = composition.read(address);
    if (!registration || registration.registration.family !== 'actions') throw new Error('Missing actual client Action registration');
    return { ...fixture, registration };
}

it('waits for the exact client search registration and applies it independently of cold daemon activation', async () => {
    pluginBoundary.activationGate = createDeferred<void>();
    const fixture = await mountClientExecutableFixture({ searchProvider: true, waitForAdmission: false, coldDaemon: true });
    await vi.waitFor(() => expect(pluginBoundary.enteredActivation).toBe(true));
    const sections = () => buildPluginSearchProviderSections({
        projection: fixture.readObserved()?.pluginUiProjection, accountLifetime: fixture.lifetime,
        scopedLaunchFacts: { machineId: null, serverId: fixture.lifetime.scope.serverId, interactionEnabled: true },
        onCommitActivation: () => { throw new Error('Search must not activate a result'); },
    });
    expect(Object.keys(fixture.readObserved()?.pluginUiProjection?.searchProvidersById ?? {})).toHaveLength(1);
    expect(sections()).toHaveLength(0);
    pluginBoundary.activationGate.resolve();
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(fixture.readObserved()?.clientExecutableActivation.status).toBe('ready');
        expect(sections()).toHaveLength(1);
    });
    expect(await sections()[0]!.resolve('needle', new AbortController().signal))
        .toMatchObject({ options: [{ label: 'needle' }] });
});

it('dispatches the same palette query from Session and Home beside portable Account UI without mounting a plugin page', async () => {
    const { lifetime, readObserved, machine, composition, snapshot } = await mountClientExecutableFixture({ searchProvider: true, coldDaemon: true });
    const current = readObserved();
    expect(current?.pluginUiProjection?.actionsById[`${pluginId}/${actionId}`]?.authorization?.generation)
        .toMatchObject({ targetGeneration: origin.materializationRef.materializationId, appliedGeneration: null });
    const sections = buildPluginSearchProviderSections({
        projection: current?.pluginUiProjection, accountLifetime: lifetime,
        scopedLaunchFacts: { machineId: machine.id, serverId: lifetime.scope.serverId, interactionEnabled: true },
        onCommitActivation: () => { throw new Error('Search must not activate a result'); },
    });
    expect(sections).toHaveLength(1);
    const result = await sections[0]!.resolve('needle', new AbortController().signal);
    expect(result).toMatchObject({ options: [{ label: 'needle' }] });
    expect(pluginBoundary.signal?.aborted).toBe(false);

    // The Account's portable renderer catalog intentionally has no runtime
    // search descriptors. Compose it through the same final merge as AppShell.
    const release = snapshot.intentReads[0]?.response.release;
    if (!release) throw new Error('Missing producer release');
    const manifest = { ...release.normalizedManifest, contributes: PluginContributesV2Schema.parse({
        ...release.normalizedManifest.contributes,
        ui: { renderers: [{ id: 'main', kind: 'reactNative', artifact: 'main', requiredHostMethods: [] }],
            views: [{ id: 'page', container: 'appPage', target: { kind: 'app' }, title: 'Entries', renderer: 'main' }] },
    }) };
    const portable = normalizePluginInstalledUiDeclarations(projectPluginPortableUiDeclarationsV1(manifest), undefined, {
        id: pluginId, displayName: 'Entries', version: '1.0.0', enabled: true, source: { kind: 'bundled', locator: pluginId },
    });
    const homeProjection = mergeInstalledPluginUiProjections([portable], current?.pluginUiProjection ?? null);
    if (!homeProjection) throw new Error('Missing merged Home projection');
    const homeSections = buildPluginSearchProviderSections({
        projection: homeProjection, accountLifetime: lifetime,
        scopedLaunchFacts: { machineId: null, serverId: lifetime.scope.serverId, interactionEnabled: true },
        onCommitActivation: () => { throw new Error('Search must not activate a result'); },
    });
    expect(homeSections).toHaveLength(1);
    expect(await homeSections[0]!.resolve('needle', new AbortController().signal))
        .toMatchObject({ options: [{ label: 'needle' }] });
    expect(pluginBoundary.signal?.aborted).toBe(false);
    const admittedAction = homeProjection.actionsById[`${pluginId}/${actionId}`];
    if (!admittedAction?.authorization) throw new Error('Missing exact producer authorization');
    for (const [generation, refusal] of [
        [{ ...admittedAction.authorization.generation, desiredGeneration: 'successor' }, 'plugin_action_generation_retired'],
        [{ targetGeneration: 'predecessor', desiredGeneration: 'predecessor', appliedGeneration: 'predecessor', targetGenerationMode: 'retained' as const }, 'plugin_action_generation_not_applied'],
    ] as const) {
        const staleSections = buildPluginSearchProviderSections({
            projection: { ...homeProjection, actionsById: { ...homeProjection.actionsById,
                [`${pluginId}/${actionId}`]: { ...admittedAction, authorization: { ...admittedAction.authorization, generation } } } },
            accountLifetime: lifetime,
            scopedLaunchFacts: { machineId: null, serverId: lifetime.scope.serverId, interactionEnabled: true },
            onCommitActivation: () => { throw new Error('Search must not activate a result'); },
        });
        await expect(staleSections[0]!.resolve('needle', new AbortController().signal)).rejects.toThrow(refusal);
    }
    await composition.invalidatePlugin(pluginId);
    await expect(homeSections[0]!.resolve('needle', new AbortController().signal))
        .rejects.toThrow('plugin_surface_client_action_unavailable');
    // No plugin surface or page was mounted; the real Artifact, activation,
    // registration, semantic router and dispatcher supplied the handler.
});

it('refuses revoked and foreign scoped grants for a committed cold-client Action', async () => {
    const requiredScope = { accountId: 'account-continuity', projectId: 'project-continuity' };
    const revokedGrant = { id: 'continuity-access', required: true, status: 'revoked' as const,
        requiredScope, grantedScope: requiredScope };
    const { readObserved, composition, address, registration } = await mountClientExecutableFixture({
        searchProvider: true, coldDaemon: true, scopedGrants: [revokedGrant],
    });
    expect(registration).not.toBeNull();
    expect(composition.read(address)).toBe(registration);
    const projectedAction = readObserved()?.pluginUiProjection?.actionsById[`${pluginId}/${actionId}`];
    if (!projectedAction?.authorization) throw new Error('Missing producer authorization');
    const authorization = projectedAction.authorization;
    expect(authorization.generation).toMatchObject({
        targetGeneration: origin.materializationRef.materializationId,
        desiredGeneration: origin.materializationRef.materializationId, appliedGeneration: null,
    });
    const producerGrant = authorization.scopedGrants[0];
    if (!producerGrant) throw new Error('Missing producer scoped grant');
    const dispatchWithGrant = (grant: typeof producerGrant) => {
        const resolveContributedAction = createPluginUiProjectedActionResolver({ [`${pluginId}/${actionId}`]: {
            ...projectedAction, authorization: { ...authorization, scopedGrants: [grant] },
        } });
        return dispatchPluginSurfaceAction({ action: { pluginId, localId: actionId }, input: { query: 'needle' },
            clientAction: {}, resolveContributedAction });
    };
    for (const [grant, reason] of [
        [producerGrant, 'plugin_action_grant_revoked'],
        [{ ...producerGrant, status: 'active', grantedScope: { ...requiredScope, accountId: 'another-account' } },
            'plugin_action_grant_scope_mismatch'],
        [{ ...producerGrant, status: 'active', grantedScope: { ...requiredScope, projectId: 'another-project' } },
            'plugin_action_grant_scope_mismatch'],
    ] as const) {
        expect.soft(await dispatchWithGrant(grant), `${grant.status}: ${JSON.stringify(grant.grantedScope)}`)
            .toMatchObject({ ok: false, reason });
    }
    expect.soft(pluginBoundary.signal, 'Refused grants must not enter the client handler').toBeNull();
    // The same registration and cold generation execute with matching access,
    // so a missing handler or generation refusal cannot satisfy the denials.
    await expect(dispatchWithGrant({ ...producerGrant, status: 'active', grantedScope: requiredScope }))
        .resolves.toMatchObject({ ok: true, result: { items: [{ id: 'match', title: 'needle' }] } });
});

it('keeps the mounted shell and execution-origin reporters at zero renders during ten settled seconds without changed facts', async () => {
    vi.useFakeTimers();
    try {
        // Forwarding spies count the actual mounted component's unconditional hook
        // entry, not snapshot reads or a replacement implementation of the owner.
        const shellRenders = vi.spyOn(availabilityProjection, 'useActivePluginAccountUiProjectionInputs');
        const reporterRenders = vi.spyOn(executionOriginSelection, 'usePluginMachineExecutionOriginSelection');
        const { lifetime, registration, machine, peerMachine } = await mountClientExecutableFixture();
        if (!registration) throw new Error('Missing committed Action');
        const publishReceipt = () => storage.getState().applyMachines(structuredClone([machine, peerMachine]), false,
            { sourceServerId: lifetime.scope.serverId });
        await act(async () => { publishReceipt(); });
        await flushHookEffects({ cycles: 12 });
        expect(registration.lifecycle.isCurrent()).toBe(true);
        expect(shellRenders).toHaveBeenCalled();
        expect(reporterRenders.mock.calls.some(([input]) => input.includeMachineCandidates === false)).toBe(true);
        shellRenders.mockClear();
        reporterRenders.mockClear();

        for (let receipt = 0; receipt < 100; receipt++) {
            await act(async () => {
                publishReceipt();
                await vi.advanceTimersByTimeAsync(100);
            });
        }
        await flushHookEffects();
        expect.soft(shellRenders).not.toHaveBeenCalled();
        expect.soft(reporterRenders.mock.calls.filter(([input]) => input.includeMachineCandidates === false)).toHaveLength(0);
        expect(registration.lifecycle.isCurrent()).toBe(true);

        // Prove that both counters observe genuine source withdrawal and that the
        // quiet interval did not disconnect a consumer or freeze admission.
        await act(async () => { availabilityProjection.retirePluginAccountAvailabilityProjection([pluginId]); });
        await flushHookEffects({ cycles: 12 });
        expect(shellRenders).toHaveBeenCalled();
        expect(reporterRenders.mock.calls.some(([input]) => input.includeMachineCandidates === false)).toBe(true);
        expect(registration.lifecycle.isCurrent()).toBe(false);
        expect(lifetime.isCurrent()).toBe(true);
    } finally { vi.useRealTimers(); }
});

it('retains a pending client Action and its exact admission across equivalent Availability publication while observing fresh inventory', async () => {
    const { lifetime, materialization, snapshot, address, registration, composition, dispatch, readObserved, readObservedAt } = await mountClientExecutableFixture();
    if (!registration) throw new Error('Missing committed Action');
    let dispatchOutcome: Awaited<ReturnType<typeof dispatch>> | null = null;
    const pendingAction = dispatch().then(outcome => { dispatchOutcome = outcome; return outcome; });
    await vi.waitFor(() => expect({ signal: pluginBoundary.signal, dispatchOutcome }).toMatchObject({ signal: expect.anything(), dispatchOutcome: null }));
    const refreshedMaterialization = { ...materialization, observedAt: 2 };
    const refreshed: PluginAccountAvailabilitySnapshot = { ...snapshot, availabilityCursor: 2, materializations: [refreshedMaterialization],
        snapshots: [{ serverIdentityId, machineId: materialization.machineId, materializations: [refreshedMaterialization] }] };
    await act(async () => { replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: refreshed }); });
    await flushHookEffects({ cycles: 12 });
    expect(composition.read(address)).toBe(registration);
    expect(registration.lifecycle.signal.aborted).toBe(false);
    expect(registration.lifecycle.isCurrent()).toBe(true);
    expect(pluginBoundary.signal?.aborted).toBe(false);
    expect(pluginBoundary.cleanups).toBe(0);
    expect(readObserved()?.phase).toBe('current');
    expect(readObservedAt()).toBe(2);
    pluginBoundary.pending.resolve('finished');
    await expect(pendingAction).resolves.toEqual({ ok: true, result: 'finished' });
});

it('keeps one preparing client artifact evaluation across equivalent Availability publications', async () => {
    pluginBoundary.activationGate = createDeferred<void>();
    // Own a cold byte graph: earlier cases legitimately retain the evaluated
    // namespace for their identical Artifact and Machine activation scope.
    const { lifetime, materialization, snapshot, composition, address } = await mountClientExecutableFixture({
        waitForAdmission: false, artifactLabel: 'preparing-equivalent-availability',
    });
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(pluginBoundary.enteredActivation).toBe(true);
    });
    expect(pluginBoundary.evaluations).toBe(1);
    const refreshedMaterialization = { ...materialization, observedAt: 2 };
    const refreshed: PluginAccountAvailabilitySnapshot = { ...snapshot, availabilityCursor: 2, materializations: [refreshedMaterialization],
        snapshots: [{ serverIdentityId, machineId: materialization.machineId, materializations: [refreshedMaterialization] }] };
    await act(async () => { replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: refreshed }); });
    await flushHookEffects({ cycles: 12 });
    pluginBoundary.activationGate.resolve();
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(composition.read(address)).not.toBeNull();
    });
    expect(pluginBoundary.evaluations).toBe(1);
});

it.each(['Machine', 'Account'] as const)('cancels an unfinished real executable activation before it can publish after exact %s withdrawal', async (withdrawal) => {
    pluginBoundary.activationGate = createDeferred<void>();
    const { lifetime, machine, composition, address } = await mountClientExecutableFixture({ waitForAdmission: false });
    await vi.waitFor(() => expect(pluginBoundary.enteredActivation).toBe(true));
    expect(composition.read(address)).toBeNull();
    await act(async () => storage.setState(withdrawal === 'Machine'
        ? { machines: { [machine.id]: { ...machine, active: false, activeAt: 0 } },
            machineListByServerId: { [lifetime.scope.serverId]: [{ ...machine, active: false, activeAt: 0 }] } }
        : { profileScope: null }));
    await flushHookEffects();
    pluginBoundary.activationGate.resolve();
    await flushHookEffects({ cycles: 12 });
    expect(lifetime.isCurrent()).toBe(withdrawal === 'Machine');
    expect(composition.read(address)).toBeNull();
});

it('withdraws an accepted pending Action before a blocked mounted AppShell update can resume', async () => {
    const { lifetime, machine, peerMachine, composition, address, registration, dispatch, readObserved } = await mountClientExecutableFixture({ admitPeer: true });
    if (!registration) throw new Error('Missing committed Action');
    const pendingAction = dispatch();
    await vi.waitFor(() => expect(pluginBoundary.signal).not.toBeNull());
    // Withdraw a different Machine's exact contribution currentness.
    // Its foreign cleanup holds the mounted AppShell serial update pending,
    // without changing this Action's exact Account/occurrence/Artifact authority.
    pluginBoundary.peerCleanupGate = createDeferred<void>();
    const offlinePeer = { ...peerMachine, active: false, activeAt: 0 };
    await act(async () => storage.setState({ machines: { [machine.id]: machine, [peerMachine.id]: offlinePeer },
        machineListByServerId: { [lifetime.scope.serverId]: [machine, offlinePeer] } }));
    await vi.waitFor(() => expect(pluginBoundary.peerCleanupEntered).toBe(true));
    expect(readObserved()?.clientExecutableActivation.status).toBe('establishing');
    expect(composition.read(address)).toBe(registration);
    expect(pluginBoundary.signal?.aborted).toBe(false);
    await act(async () => storage.setState({ machines: { [machine.id]: { ...machine, active: false, activeAt: 0 } },
        machineListByServerId: { [lifetime.scope.serverId]: [{ ...machine, active: false, activeAt: 0 }] } }));
    await flushHookEffects();
    expect(registration.lifecycle.signal.aborted).toBe(true);
    expect(pluginBoundary.signal?.aborted).toBe(true);
    expect(composition.read(address)).toBeNull();
    expect(lifetime.isCurrent()).toBe(true);
    expect(pluginBoundary.peerCleanupFinished).toBe(false);
    pluginBoundary.pending.resolve('late');
    await expect(pendingAction).resolves.toMatchObject({ ok: false });
    pluginBoundary.peerCleanupGate.resolve();
    await flushHookEffects({ cycles: 12 });
    expect(composition.read(address)).toBeNull();
});
