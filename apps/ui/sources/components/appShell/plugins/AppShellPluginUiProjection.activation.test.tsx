import * as React from 'react';
import { Linking } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginContributesV2Schema} from '@happier-dev/protocol/plugins/contributions/v2';
import { PluginProjectionV2Schema, type PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginSearchQueryV1Schema, PluginSearchResultV1Schema } from '@happier-dev/protocol/plugins/contributions/search-providers';
import type { PluginActionPresentUserAuthorizationFacts } from '@happier-dev/protocol/plugins/actions/invocation';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { DaemonPluginUiArtifactBytesReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
    PluginUiArtifactsManifestEntryV2Schema,
    PluginUiTargetedContributionsV1Schema,
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';

import { createDeferred, createMachineFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { pluginArtifactTransferDaemonState } from '@/dev/testkit/harness/pluginArtifactTransferBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createAccountSettingsHttpBoundary } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentsListActionOutputV1Schema,
    PluginAvailabilityMaterializationsReadActionOutputV1Schema, PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { storage } from '@/sync/domains/state/storageStore';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { publishMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import { resolvePluginUiClientExecutablePlatform, usePluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { clearPluginAccountAvailabilityProjection, readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, useActivePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import * as availabilityProjection from '@/sync/domains/plugins/availability/projection';
import * as executionOriginSelection from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { PluginAccountAvailabilitySnapshot } from '@/sync/domains/plugins/availability/reader';
import { dispatchPluginSurfaceAction } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import { createPluginUiProjectedActionResolver, normalizePluginInstalledUiDeclarations } from '@/sync/domains/plugins/ui/projection';
import { mergeInstalledPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { getInstalledPluginUiClientExecutableComposition } from '@/components/plugins/reactNative/clientExecutableContributions';
import { derivePluginReactNativeBundleCacheKey, getInstalledPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import { resolveProjectedPluginUiClientExecutables } from '@/components/plugins/reactNative/clientExecutableProjection';
import { buildPluginSearchProviderSections } from '@/components/appShell/search/pluginSearchProviderSections';
import { useMountedTargetedContributions } from '@/components/plugins/surfaces/mountedTargetedContributions';
import { useBoundPluginSurfaceController } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import { useManagedProvisionerPresentation } from '@/components/settings/machines/managed/useManagedProvisionerPresentation';
import { unloadAppShellProjectedClientExecutables } from './appShellClientExecutableActivation';
import { AppShellPluginUiProjectionProvider, useAppShellPluginUiProjection } from './AppShellPluginUiProjection';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { getVoiceAdapterRegistry } from '@/voice/session/voiceAdapterRegistry';
import { getVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleControllerStore';
import { resetVoiceSessionStoreForTests } from '@/voice/session/voiceSessionStore';
import { useVoiceProviderRuntimeDemand } from '@/voice/session/useVoiceProviderRuntimeDemand';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { VoiceServiceListScreen } from '@/voice/settings/screens/VoiceServiceListScreen';

const daemon = vi.hoisted(() => ({ projection: null as PluginProjectionV2 | null, peerProjection: null as PluginProjectionV2 | null,
    mountedProjection: null as PluginProjectionV2 | null, peerMountedProjection: null as PluginProjectionV2 | null,
    peerMountedReads: 0, bytes: new Uint8Array(), entryPath: '', artifactDigest: '',
    successorBytes: new Uint8Array(), successorDigest: '', projectionReads: 0, artifactReads: 0 }));
const route = vi.hoisted(() => ({ pathname: '/' }));
// Only the real network transport is replaced. Account, storage, projection,
// Artifact leases, CommonJS evaluation, registration and reconciliation stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const { createPluginArtifactTransferBoundary } = await import('@/dev/testkit/harness/pluginArtifactTransferBoundary');
    const artifacts = createPluginArtifactTransferBoundary(async ({ payload }) => {
        const successor = payload.cacheIdentity.artifactDigest === daemon.successorDigest;
        const bytes = successor ? daemon.successorBytes : daemon.bytes;
        const digest = successor ? daemon.successorDigest : daemon.artifactDigest;
        const { computePluginUiArtifactSha256DigestV1 } = await import('@happier-dev/protocol/plugins/ui');
        return DaemonPluginUiArtifactBytesReadResponseSchema.parse({ ok: true, artifactFamily: 'reactNative', cacheIdentity: { artifactDigest: digest },
            artifact: { artifactKind: 'reactNativeBundle', digest, format: 'plainJs', byteSize: bytes.byteLength },
            files: [{ relativePath: successor ? 'react-native/next/entry.cjs.bundle' : daemon.entryPath, digest: computePluginUiArtifactSha256DigestV1(bytes),
                byteSize: bytes.byteLength, bytesBase64: Buffer.from(bytes).toString('base64') }] });
    });
    return createServerScopedMachineRpcBoundaryMock(async ({ method, payload, machineId }) => {
        if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            if (payload && typeof payload === 'object' && 'selection' in payload && payload.selection === 'mountedActions') {
                if (machineId === 'machine-peer') {
                    daemon.peerMountedReads += 1;
                    return { protocolVersion: 1, projection: daemon.peerMountedProjection };
                }
                return { protocolVersion: 1, projection: daemon.mountedProjection };
            }
            daemon.projectionReads += 1;
            return { protocolVersion: 1, projection: machineId === 'machine-peer' ? daemon.peerProjection : daemon.projection };
        }
        if (artifacts.handles(method)) {
            daemon.artifactReads += 1;
            return artifacts.request({ method, payload, machineId });
        }
        if (method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return { ok: true, inputSchema: {} };
        throw new Error(`Unexpected executable fixture RPC: ${method}`);
    });
});
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: () => route.pathname,
}).module);
installDisconnectedServerSocketBoundary();

const initialStorage = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const pluginId = 'acme.executable-continuity';
const peerPluginId = 'acme.cleanup-peer';
const actionId = 'hold';
const artifactId = 'continuity';
const serverIdentityId = 'srv_executable_continuity';
const platform = resolvePluginUiClientExecutablePlatform();
const defaultOccurrenceId = 'continuity-install';
const origin = { serverIdentityId, sourceRef: { machineId: 'machine-live', pluginId,
    sourceCustody: { kind: 'development', registeredRootId: '/fixture/plugins/executable-continuity' } } } as const;

// This is a foreign plugin executable fixture, loaded and evaluated by the
// production CommonJS owner. Its pending work crosses no mocked internal owner.
const pluginBoundary: { pending: ReturnType<typeof createDeferred<string>>; cleanups: number; signal: AbortSignal | null;
    activationGate: ReturnType<typeof createDeferred<void>> | null; enteredActivation: boolean; evaluations: number; peerActivations: number;
    peerCleanupGate: ReturnType<typeof createDeferred<void>> | null; peerCleanupEntered: boolean; peerCleanupFinished: boolean } = {
    pending: createDeferred<string>(), cleanups: 0, signal: null, activationGate: null, enteredActivation: false, evaluations: 0, peerActivations: 0,
    peerCleanupGate: null, peerCleanupEntered: false, peerCleanupFinished: false,
};
const fixtureGlobal = globalThis as typeof globalThis & { executableContinuityFixture?: typeof pluginBoundary };

/** AppShell observes catalogs passively; these fixture consumers own actual demand. */
function CatalogDemand(props: Readonly<{ machineId: string; serverId: string }>) {
    usePluginUiProjectionCurrentness(props);
    return null;
}

beforeEach(() => { route.pathname = '/'; });

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

async function mountClientExecutableFixture(options: { waitForAdmission?: boolean; admitPeer?: boolean; searchProvider?: boolean; coldDaemon?: boolean; mountedOnly?: boolean;
    managedRepair?: boolean;
    artifactLabel?: string;
    scopedGrants?: PluginActionPresentUserAuthorizationFacts['scopedGrants'] } = {}) {
    const pluginId = options.managedRepair ? 'happier.machine.docker-sandboxes' : 'acme.executable-continuity';
    const actionId = options.managedRepair ? 'install-docs' : 'hold';
    const artifactId = options.managedRepair ? 'docker-sandboxes-machine-native' : 'continuity';
    const occurrenceId = options.managedRepair ? `${pluginId}:42` : defaultOccurrenceId;
    const executionOrigin = options.managedRepair
        ? { serverIdentityId, sourceRef: { machineId: 'machine-live', pluginId,
            sourceCustody: { kind: 'development' as const, registeredRootId: '/fixture/plugins/machine-docker-sandboxes' } } }
        : origin;
    pluginBoundary.pending = createDeferred<string>();
    pluginBoundary.cleanups = 0;
    pluginBoundary.signal = null;
    pluginBoundary.enteredActivation = false;
    pluginBoundary.evaluations = 0;
    pluginBoundary.peerActivations = 0;
    daemon.peerMountedReads = 0;
    pluginBoundary.peerCleanupEntered = false;
    pluginBoundary.peerCleanupFinished = false;
    // Bootstrap and the explicit projection fixture publish the same daemon
    // inventory; its HTTP response waits until the fixture has built that set.
    const availabilityReady = createDeferred<PluginAccountAvailabilitySnapshot>();
    connection = await restoreServerAccountForTest({ serverUrl: 'https://executable-continuity.test', serverIdentityId, accountId: 'account-continuity',
        request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health') return Response.json({ status: 'ok' });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ version: 1, updatedAt: 1 }));
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
                features: { machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: false }, serverRouted: { enabled: false } } },
                    plugins: { enabled: true, ui: { enabled: true, hostedWeb: { enabled: true }, reactNativeBundles: { enabled: true } } } },
            }));
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                const snapshot = await availabilityReady.promise;
                return Response.json(PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({
                    availabilityCursor: snapshot.availabilityCursor, snapshots: snapshot.snapshots,
                }));
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                const snapshot = await availabilityReady.promise;
                return Response.json(PluginAvailabilityIntentsListActionOutputV1Schema.parse({
                    availabilityCursor: snapshot.availabilityCursor,
                    pluginIds: snapshot.intentReads.map(entry => entry.pluginId), intentReads: snapshot.intentReads, failedPluginIds: [],
                }));
            }
            // Real Sync owns census admission after restoration. An unserved
            // list would turn these hydrated fixture rows into stale supplies.
            if (path === '/v1/machines') return Response.json(['machine-live', 'machine-peer'].map(id =>
                createPlainMachineRowFixture({ id, accountId: 'account-continuity', machine: createMachineFixture({ id, activeAt: Date.now(), daemonState: pluginArtifactTransferDaemonState }) })));
            return createEmptyAccountBootstrapHttpResponse(path, init) ?? Response.json({ error: 'not_found' }, { status: 404 });
        } });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing real Account lifetime');
    const serverId = lifetime.scope.serverId;
    const machine = createMachineFixture({ id: 'machine-live', active: true, activeAt: Date.now(), daemonStateVersion: 1, daemonState: pluginArtifactTransferDaemonState });
    const peerMachine = createMachineFixture({ id: 'machine-peer', active: true, activeAt: Date.now(), daemonStateVersion: 1, daemonState: pluginArtifactTransferDaemonState });
    const peerExecutionOrigin = { serverIdentityId, sourceRef: { machineId: peerMachine.id, pluginId: peerPluginId,
        sourceCustody: { kind: 'development' as const, registeredRootId: '/fixture/plugins/cleanup-peer' } } };
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
        api.actions.register('${actionId}', async function(input, context) {
            globalThis.executableContinuityFixture.signal = context.signal;
            if (${options.managedRepair === true}) {
                await context.ui.executeAction('links.openExternal', { url: 'https://docs.docker.com/ai/sandboxes/install/' }, { signal: context.signal });
            }
            if (${options.searchProvider === true}) return { items: [{ id: 'match', title: input.query,
                command: { kind: 'openSurface', destination: 'details' } }], truncated: false };
            return await globalThis.executableContinuityFixture.pending.promise;
        });
        if (globalThis.executableContinuityFixture.activationGate) await globalThis.executableContinuityFixture.activationGate.promise;
        return function() { globalThis.executableContinuityFixture.cleanups += 1; };
    };`);
    const entryPath = `react-native/${artifactId}/entry.cjs.bundle`;
    daemon.entryPath = entryPath;
    const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entryPath, bytes: daemon.bytes }]);
    const artifactGraph = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId, tier: 'reactNative', entry: entryPath,
        files: [{ relativePath: entryPath, digest: computePluginUiArtifactSha256DigestV1(daemon.bytes), byteSize: daemon.bytes.byteLength }],
        digest: artifactDigest, builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: options.managedRepair ? ['activate', 'renderSurface'] : ['activate'] }, hostUiApiRange: '^1.0.0' });
    daemon.artifactDigest = artifactDigest;
    daemon.successorBytes = new TextEncoder().encode(`exports.activate = function(api) {
        globalThis.executableContinuityFixture.peerActivations += 1;
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
    const action = { id: actionId, title: 'Hold', scopes: [options.searchProvider || options.managedRepair ? 'global' : 'session'], surfaces: ['ui'],
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
            occurrenceId: occurrenceId, executionOrigin, sourceCustody: executionOrigin.sourceRef.sourceCustody,
            source: { kind: options.managedRepair ? 'bundled' : 'localPath', locator: options.managedRepair ? '@happier-dev/plugins-machine-docker-sandboxes' : `/fixture/plugins/${pluginId}` } } },
        agentsById: {}, resourcesById: {}, settingsById: {}, diagnostics: [],
        actionsById: { [`${pluginId}/${actionId}`]: { ...projectedAction, pluginId, available: true,
            occurrenceId: occurrenceId, executionOrigin,
            authorization: { generation: { targetGeneration: occurrenceId,
                desiredGeneration: occurrenceId,
                appliedGeneration: options.coldDaemon || options.managedRepair ? null : occurrenceId, targetGenerationMode: 'current' },
                resourceSelections: [], scopedGrants: options.scopedGrants ?? [], serviceAvailability: [], operatingSystemAuthorization: [] } } },
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
            ...(options.managedRepair ? { [`reactNativeBundle:${pluginId}:sandboxes-machine-native`]: {
                id: `reactNativeBundle:${pluginId}:sandboxes-machine-native`, pluginId, contributionKind: 'reactNativeBundle',
                contributionId: 'sandboxes-machine-native', occurrenceId, executionOrigin,
                generatedOwnerKind: 'renderer', artifactGraph, artifactSelectionOwner: 'daemonProjection',
                entry: { artifactId, exportName: 'renderSurface' },
                runtime: { decision: { state: 'load', reason: 'compatible' }, loadPolicy: { source: 'installedArtifact' }, cacheIdentity: { artifactDigest }, cacheKey: artifactDigest },
            } } : {}),
            [`reactNativeBundle:${pluginId}:${actionId}`]: {
            id: `reactNativeBundle:${pluginId}:${actionId}`, pluginId, contributionKind: 'reactNativeBundle', contributionId: actionId,
            occurrenceId: occurrenceId, executionOrigin,
            generatedOwnerKind: 'clientContribution', artifactGraph, entry: { artifactId, exportName: 'activate' },
            artifactSelectionOwner: 'daemonProjection',
            runtime: { decision: { state: 'load' }, loadPolicy: { source: 'installedArtifact' }, cacheIdentity: { artifactDigest },
                cacheKey: derivePluginReactNativeBundleCacheKey({ pluginId, contributionId: actionId, artifactId, artifactDigest, platform }) },
        } } } } });
    const firstAction = daemon.projection.actionsById[`${pluginId}/${actionId}`];
    if (!firstAction?.authorization) throw new Error('Missing fixture Action authorization');
    const ownPluginUi = daemon.projection.familiesById.pluginUi;
    if (!ownPluginUi) throw new Error('Missing fixture plugin UI family');
    const firstBundle = ownPluginUi.entriesById[`reactNativeBundle:${pluginId}:${actionId}`];
    daemon.projection = PluginProjectionV2Schema.parse({ ...daemon.projection,
        installedPackagesById: { ...daemon.projection.installedPackagesById, [peerPluginId]: { ...daemon.projection.installedPackagesById[pluginId], id: peerPluginId,
            occurrenceId: 'peer-install', executionOrigin: peerExecutionOrigin, sourceCustody: peerExecutionOrigin.sourceRef.sourceCustody,
            displayName: peerPluginId, source: { kind: 'localPath', locator: `/fixture/plugins/${peerPluginId}` } } },
        actionsById: { ...daemon.projection.actionsById, [`${peerPluginId}/next`]: { ...firstAction, ...projectedPeerAction, pluginId: peerPluginId,
            authorization: { ...firstAction.authorization, generation: { targetGeneration: 'peer-install',
                desiredGeneration: 'peer-install', appliedGeneration: options.coldDaemon ? null : 'peer-install' } },
            occurrenceId: 'peer-install', executionOrigin: peerExecutionOrigin, available: options.admitPeer === true } },
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: { ...ownPluginUi.entriesById,
            [`reactNativeBundle:${peerPluginId}:next`]: { ...firstBundle, id: `reactNativeBundle:${peerPluginId}:next`, pluginId: peerPluginId, contributionId: 'next',
                occurrenceId: 'peer-install', executionOrigin: peerExecutionOrigin, artifactGraph: nextGraph,
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
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
            ...(options.managedRepair ? { [`reactNativeBundle:${pluginId}:sandboxes-machine-native`]: ownPluginUi.entriesById[`reactNativeBundle:${pluginId}:sandboxes-machine-native`] } : {}),
            [`reactNativeBundle:${pluginId}:${actionId}`]: firstBundle,
            ...(options.searchProvider ? { [`searchProvider:${pluginId}:entries`]: {
                id: `searchProvider:${pluginId}:entries`, pluginId, occurrenceId: occurrenceId,
                contributionKind: 'searchProvider', descriptorId: 'entries',
                // Match projectSearchProviders' closed descriptor arm; execution origin belongs to the referenced Action.
                identity: { pluginId, localId: 'entries' }, action: { pluginId, localId: actionId },
            } } : {}),
        } } } });
    daemon.mountedProjection = daemon.projection;
    daemon.peerMountedProjection = daemon.peerProjection;
    if (options.mountedOnly) {
        daemon.projection = PluginProjectionV2Schema.parse({ ...daemon.projection,
            actionsById: {}, familiesById: { pluginUi: { family: 'pluginUi', entriesById: {} } } });
        daemon.peerProjection = PluginProjectionV2Schema.parse({ ...daemon.peerProjection,
            actionsById: {}, familiesById: { pluginUi: { family: 'pluginUi', entriesById: {} } } });
    }
    const slot = { contributionId: actionId, artifactId, tier: 'reactNative' as const, platform, artifactDigest, hostUiApiRange: '^1.0.0' };
    const slots = [slot];
    const peerSlot = { ...slot, contributionId: 'next', artifactId: 'next', artifactDigest: successorDigest };
    // These lifecycle cases exercise Machine-owned executable occurrences.
    // A portable Account release would own client Actions independently of
    // that Machine, so publish the host's release-less local installation.
    const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: pluginId,
        engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, hostAccess: { required: [], optional: [] }, secrets: [], contributes });
    const peerManifest = PluginPortableReleaseManifestV1Schema.parse({ ...manifest, id: peerPluginId, displayName: peerPluginId, contributes: peerContributes });
    const materialization = { serverIdentityId, machineId: machine.id, materializationId: occurrenceId, pluginId,
        version: '1.0.0', sourceClass: 'localPath' as const, portableRelease: false, declaredManifest: manifest,
        declaredUiEntries: projectPluginPortableUiDeclarationsV1(manifest, [artifactGraph]),
        uiArtifacts: slots, enabled: true, trustState: 'trusted' as const, observedAt: 1 } satisfies PluginAccountAvailabilitySnapshot['materializations'][number];
    let snapshot: PluginAccountAvailabilitySnapshot = { availabilityCursor: 1,
        intentReads: [{ pluginId, response: { availabilityCursor: 1, packageAssets: [], hostingCapability: { enabled: false },
            intent: { pluginId, desiredVersion: null, enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
            release: null, uiArtifacts: [] } }],
        materializations: [materialization], snapshots: [{ serverIdentityId, machineId: machine.id, materializations: [materialization] }] };
    const ownIntent = snapshot.intentReads[0];
    const peerMaterialization = { ...materialization, machineId: peerMachine.id, pluginId: peerPluginId, materializationId: 'peer-install', uiArtifacts: [peerSlot],
        declaredManifest: peerManifest, declaredUiEntries: projectPluginPortableUiDeclarationsV1(peerManifest, [nextGraph]) };
    const peerIntent = ownIntent?.response.intent;
    if (!ownIntent || !peerIntent) throw new Error('Missing fixture intent');
    const intentReads: PluginAccountAvailabilitySnapshot['intentReads'] = [...snapshot.intentReads, { pluginId: peerPluginId, response: { ...ownIntent.response,
        intent: { ...peerIntent, pluginId: peerPluginId } } }];
    const materializations = [...snapshot.materializations, peerMaterialization];
    snapshot = { ...snapshot, intentReads, materializations, snapshots: [{ serverIdentityId, machineId: machine.id, materializations: [materialization] },
        { serverIdentityId, machineId: peerMachine.id, materializations: [peerMaterialization] }] };
    if (options.managedRepair) snapshot = { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] };
    availabilityReady.resolve(snapshot);
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot });
    const reader = readPluginAccountAvailability(lifetime.scope);
    if (!options.managedRepair) expect(reader.readCurrentArtifact({ pluginId, contributionId: actionId, tier: 'reactNative', platform })).toMatchObject({ kind: 'unavailable' });
    let observed: ReturnType<typeof useAppShellPluginUiProjection> | null = null;
    const readObserved = (): ReturnType<typeof useAppShellPluginUiProjection> | null => observed;
    let mountedState: ReturnType<typeof useMountedTargetedContributions> | null = null;
    const readMounted = (): ReturnType<typeof useMountedTargetedContributions> | null => mountedState;
    let mountedController: ReturnType<typeof useBoundPluginSurfaceController> | null = null;
    const readMountedController = (): ReturnType<typeof useBoundPluginSurfaceController> | null => mountedController;
    let mountedLifetime: ReturnType<typeof useServerCredentialAccountScopeBinding>['binding'] = null;
    const readMountedLifetime = (): ReturnType<typeof useServerCredentialAccountScopeBinding>['binding'] => mountedLifetime;
    let managedPresentation: ReturnType<typeof useManagedProvisionerPresentation> | null = null;
    function ManagedRepairDemand() {
        mountedLifetime = useServerCredentialAccountScopeBinding(serverId).binding;
        managedPresentation = useManagedProvisionerPresentation({ serverId, purpose: 'repair',
            controller: { machineId: machine.id, installationId: 'test-installation' } });
        return null;
    }
    const emptyTarget = PluginUiTargetedContributionsV1Schema.parse({
        target: { pluginId, occurrenceId: occurrenceId,
            sourceCustody: executionOrigin.sourceRef.sourceCustody },
        points: [],
    });
    function MountedDemand() {
        const owner = useAppShellPluginUiProjection();
        mountedLifetime = useServerCredentialAccountScopeBinding(serverId).binding;
        mountedState = useMountedTargetedContributions({ accountLifetime: mountedLifetime, machineId: machine.id, serverId,
            pluginId, mountedOccurrenceId: occurrenceId, enabled: true,
            emptyTargetedContributions: emptyTarget });
        mountedController = useBoundPluginSurfaceController({ facts: {
            pluginId, contributionId: 'panel', surfaceId: 'mounted-only-client-action',
            placement: 'appSurface', platform, channel: 'internal', machineId: machine.id, serverId, sessionId: 'session-continuity',
            occurrenceId: occurrenceId, executionOrigin, accountLifetime: mountedLifetime,
            targetedContributions: mountedState.targetedContributions,
            targetSourceCustody: emptyTarget.target.sourceCustody,
            actionInputSelectionFactsKey: mountedState.actionInputSelectionFactsKey,
            pluginUiProjection: mountedState.pluginUiProjection,
            pluginProjectionById: mountedState.projectionInputs?.pluginProjectionById,
            interactionEnabled: true, daemonInteractionEnabled: mountedState.phase === 'ready',
            resolveContributedAction: createPluginUiProjectedActionResolver(mountedState.pluginUiProjection?.actionsById),
            readClientExecutableAdmission: () => ({ projection: owner.pluginUiProjection,
                mountedActionProjections: owner.mountedActionProjections, platform,
                activation: owner.clientExecutableActivation, accountLifetime: owner.accountLifetime }),
        } });
        return null;
    }
    let observedAt: number | undefined;
    function Probe() {
        observed = useAppShellPluginUiProjection();
        const inventory = useActivePluginAccountAvailabilityReader()?.readMaterializations();
        observedAt = inventory?.kind === 'available' ? inventory.materializations[0]?.observedAt : undefined;
        return null;
    }
    let mountDemand = options.mountedOnly === true;
    const render = () => <AppShellPluginUiProjectionProvider>
        {options.managedRepair ? <ManagedRepairDemand /> : <CatalogDemand machineId={machine.id} serverId={serverId} />}
        <CatalogDemand machineId={peerMachine.id} serverId={serverId} />
        {mountDemand ? <MountedDemand /> : null}
        <Probe />
    </AppShellPluginUiProjectionProvider>;
    const screen = await renderScreen(render());
    const unmountDemand = async () => { mountDemand = false; await screen.update(render()); };
    const composition = getInstalledPluginUiClientExecutableComposition();
    const address = { family: 'actions' as const, pluginId, localId: actionId, target: { artifactId, exportName: 'activate', platform }, executionOrigin,
        occurrenceId: occurrenceId };
    const dispatch = () => dispatchPluginSurfaceAction({ action: { pluginId, localId: actionId }, input: null, clientAction: { sessionId: 'session-continuity' },
        resolveContributedAction: identity => createPluginUiProjectedActionResolver(readObserved()?.pluginUiProjection?.actionsById)(identity) });
    const fixture = { lifetime, machine, peerMachine, materialization, snapshot, address, composition, screen, dispatch,
        repairAction: { action: { pluginId, localId: actionId }, input: {} },
        readObserved, readMounted, readMountedController, readMountedLifetime, unmountDemand, readObservedAt: () => observedAt,
        readManagedPresentation: () => managedPresentation };
    if (options.waitForAdmission === false) return { ...fixture, registration: null };
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(readObserved()?.unavailableReasonCode).toBeUndefined();
        expect(observed).toMatchObject({ phase: 'current', clientExecutableActivation: { status: 'ready' } });
    });
    expect(lifetime.isCurrent()).toBe(true);
    const current = readObserved();
    expect(current?.accountLifetime).toBe(lifetime);
    expect(readPluginAccountAvailability(lifetime.scope).readCurrentArtifact({ pluginId, contributionId: actionId, tier: 'reactNative', platform })).toMatchObject({ kind: 'unavailable' });
    const normalizedTargets = resolveProjectedPluginUiClientExecutables({ actionProjection: current?.pluginUiProjection ? { projection: current.pluginUiProjection } : null, platform });
    expect(normalizedTargets).toHaveLength(options.admitPeer ? 2 : 1);
    expect(normalizedTargets.find(target => target.pluginId === pluginId)?.authority).toEqual({ machineId: machine.id, serverId });
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(observed).toMatchObject({ phase: 'current', clientExecutableActivation: { status: 'ready' } });
        expect(observed?.pluginUiProjection?.actionsById[`${pluginId}/${actionId}`]).toMatchObject({ available: true, occurrenceId: occurrenceId });
        expect(resolveProjectedPluginUiClientExecutables({ actionProjection: observed?.pluginUiProjection ? { projection: observed.pluginUiProjection } : null, platform })).toHaveLength(options.admitPeer ? 2 : 1);
        expect(composition.read(address)).not.toBeNull();
    });
    const registration = composition.read(address);
    if (!registration || registration.registration.family !== 'actions') throw new Error('Missing actual client Action registration');
    return { ...fixture, registration };
}

it.each(['selected', 'presented-local-picker'] as const)('discovers Voice descriptors on a fresh Home before executable demand (%s)', async (selection) => {
    daemon.projectionReads = 0;
    daemon.artifactReads = 0;
    const selectedPluginId = 'acme.fresh-voice';
    const contribution = PluginContributesV2Schema.parse({ voiceProviders: [{ id: 'conversation', title: 'Fresh Voice',
        kind: 'conversation', roles: ['realtime_conversation'], platforms: ['web', 'ios', 'android'],
        capabilities: { turn: { cancelResponse: true, bargeIn: false } },
        client: { artifactId: 'voice-client', exportName: 'activate' },
    }] }).voiceProviders[0]!;
    const providerId = `${selectedPluginId}/${contribution.id}`;
    const executionOrigin = { serverIdentityId, sourceRef: { machineId: 'machine-live', pluginId: selectedPluginId,
        sourceCustody: { kind: 'development' as const, registeredRootId: '/fixture/plugins/fresh-voice' } } };
    const occurrenceId = 'fresh-voice-install';
    // This is the daemon response, not a seeded client projection/currentness cache.
    daemon.projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById: { [selectedPluginId]: { id: selectedPluginId, displayName: 'Fresh Voice', version: '1.0.0', enabled: true,
            occurrenceId, executionOrigin, sourceCustody: executionOrigin.sourceRef.sourceCustody,
            source: { kind: 'localPath', locator: '/fixture/plugins/fresh-voice' } } },
        familiesById: { voiceProviders: { family: 'voiceProviders', entriesById: { [providerId]: {
            id: providerId, pluginId: selectedPluginId, occurrenceId, generation: 1, contributionKey: providerId, definition: contribution,
        } } } },
    });
    const settings = { ...initialStorage.settings,
        ...normalizeVoiceSettingsLocalDelta({ voice: voiceSettingsParse({ providerId: selection === 'selected' ? providerId : 'local_conversation',
            executionMachine: { mode: 'fixed', machineId: 'machine-live' } }) }, initialStorage.settings),
    };
    const machine = createMachineFixture({ id: 'machine-live', active: true, activeAt: Date.now(),
        daemonStateVersion: 1, daemonState: pluginArtifactTransferDaemonState });
    resetVoiceSessionStoreForTests();
    const settingsHttp = createAccountSettingsHttpBoundary({ serverUrl: 'https://fresh-voice-descriptor.test',
        initialAccounts: [{ accountId: 'account-continuity', snapshot: { version: 1, content: { t: 'plain', v: settings } } }],
    });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://fresh-voice-descriptor.test', serverIdentityId,
        accountId: 'account-continuity', activation: 'switch', request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            const settingsResponse = settingsHttp.handle(url, init);
            if (settingsResponse) return settingsResponse;
            if (path === '/health') return Response.json({ status: 'ok' });
            if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: 'account-continuity' }));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ version: 1, updatedAt: 1 }));
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({ features: {
                voice: { enabled: true }, plugins: { enabled: true, ui: { enabled: true, hostedWeb: { enabled: true }, reactNativeBundles: { enabled: true } } },
            } }));
            if (path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: machine.id, accountId: 'account-continuity', machine })]);
            return createEmptyAccountBootstrapHttpResponse(path, init) ?? Response.json({ error: 'not_found' }, { status: 404 });
        } });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing fresh Voice Account lifetime');
    const serverId = lifetime.scope.serverId;
    storage.setState({ profileScope: lifetime.scope, settingsScope: lifetime.scope, endpointStatus: 'online', isDataReady: true, settings,
        machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    observeMachinePresenceForTest(lifetime.scope, [machine.id]);
    const registry = createDefaultVoiceProviderRegistry();
    expect(registry.get(providerId)).toBeNull();
    let demand: ReadonlySet<string> = new Set();
    function Probe() { demand = useVoiceProviderRuntimeDemand(); return null; }
    let pickerOpen = false;
    let pickerPresented = false;
    const render = () => <InjectedAuthProvider credentials={null}>
        <AppShellPluginUiProjectionProvider>
            <Probe />
            {pickerOpen ? <PluginSurfaceFocusEligibilityProvider active={pickerPresented} presentationActive={pickerPresented}>
                <VoiceServiceListScreen />
            </PluginSurfaceFocusEligibilityProvider> : null}
        </AppShellPluginUiProjectionProvider>
    </InjectedAuthProvider>;
    const screen = await renderScreen(render());
    if (selection === 'presented-local-picker') {
        await flushHookEffects();
        expect(daemon.projectionReads).toBe(0);
        expect(registry.get(providerId)).toBeNull();
        pickerOpen = true;
        await screen.update(render());
        await flushHookEffects();
        expect(daemon.projectionReads).toBe(0);
        expect(registry.get(providerId)).toBeNull();
        pickerPresented = true;
        route.pathname = '/settings/voice/service';
        await screen.update(render());
    }
    await vi.waitFor(() => expect(registry.get(providerId)).toMatchObject({ providerId,
        kind: 'voice.conversation-provider.v1', declaration: { title: 'Fresh Voice' } }));
    if (selection === 'presented-local-picker') {
        await screen.pressByTestIdAsync(`settings.voice.provider.${encodeURIComponent(providerId)}.default`);
        await vi.waitFor(() => expect(storage.getState().settings.voiceSettingsV1.providerId).toBe(providerId));
    }
    expect([...demand]).toEqual([]);
    expect(daemon.artifactReads).toBe(0);
    expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();
    expect(getVoiceSessionLifecycleController()).toBeNull();
});

it('dispatches a controller prerequisite repair through the mounted managed catalog and AppShell activation', async () => {
    // The answering platform is the only boundary replaced; the nested host
    // Action must retain normal scope, admission and policy through the dispatcher.
    const opened = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const fixture = await mountClientExecutableFixture({ managedRepair: true, waitForAdmission: false });
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(fixture.readManagedPresentation()?.projectionReady).toBe(true);
        expect(fixture.composition.read(fixture.address)).not.toBeNull();
    });
    // The card's repair callback must execute the declared client Action, even
    // when this controller is not an ambient AppShell catalog demand.
    pluginBoundary.pending.resolve('install reviewed');
    const binding = fixture.readMountedLifetime();
    if (!binding) throw new Error('Missing routed repair lifetime');
    const result = await fixture.readManagedPresentation()?.repair(fixture.repairAction, binding);
    expect(result).toEqual({ ok: true, result: 'install reviewed' });
    expect(opened).toHaveBeenCalledExactlyOnceWith('https://docs.docker.com/ai/sandboxes/install/');
});

it('withdraws executable authority before AppShell unmount cleanup yields to a successor', async () => {
    const { registration, composition, address } = await mountClientExecutableFixture();
    if (!registration) throw new Error('Missing committed Action');
    const cleanup = unloadAppShellProjectedClientExecutables();
    try {
        // React can replay mount effects before awaiting cleanup. The old
        // authority must already be withdrawn before that successor starts.
        expect(registration.lifecycle.signal.aborted).toBe(true);
        expect(registration.lifecycle.isCurrent()).toBe(false);
        expect(composition.read(address)).toBeNull();
    } finally { await cleanup; }
});

it('activates an exact mounted-only client Action through AppShell and releases it with its mounted demand', async () => {
    pluginBoundary.activationGate = createDeferred<void>();
    const fixture = await mountClientExecutableFixture({ mountedOnly: true, admitPeer: true, waitForAdmission: false,
        artifactLabel: 'mounted-only-client-action' });
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(fixture.readMounted()?.phase).toBe('ready');
        expect(fixture.readMounted()?.pluginUiProjection?.actionsById[`${pluginId}/${actionId}`]).toMatchObject({ available: true });
        expect(fixture.readObserved()?.mountedActionProjections).toHaveLength(1);
        expect(resolveProjectedPluginUiClientExecutables({ mountedActionProjections: fixture.readObserved()?.mountedActionProjections, platform })).toHaveLength(1);
        expect(pluginBoundary.enteredActivation, JSON.stringify(fixture.readObserved()?.clientExecutableActivation)).toBe(true);
    });
    expect(fixture.readObserved()?.pluginUiProjection?.actionsById[`${pluginId}/${actionId}`]).toBeUndefined();
    expect(fixture.readObserved()?.pluginUiProjection?.actionsById[`${peerPluginId}/next`]).toBeUndefined();
    expect(daemon.peerMountedProjection?.actionsById[`${peerPluginId}/next`]).toMatchObject({ available: true,
        occurrenceId: 'peer-install', authorization: { generation: { targetGeneration: 'peer-install',
            desiredGeneration: 'peer-install', appliedGeneration: 'peer-install' } } });
    expect(fixture.composition.read(fixture.address)).toBeNull();
    expect(pluginBoundary.signal).toBeNull();
    expect(pluginBoundary.evaluations).toBe(1);
    expect(pluginBoundary.peerActivations).toBe(0);
    expect(daemon.peerMountedReads).toBe(0);
    expect(fixture.readMountedLifetime()).not.toBe(fixture.lifetime);
    expect(fixture.readMountedLifetime()?.scope).toEqual(fixture.lifetime.scope);
    expect(fixture.readMountedLifetime()?.isCurrent()).toBe(true);

    const controller = fixture.readMountedController();
    if (!controller) throw new Error('Missing actual mounted surface controller');
    expect(controller.isRequesterAdmitted()).toBe(true);
    expect(controller.canInteractWithDaemon()).toBe(true);
    let settled = false;
    const pendingAction = Promise.resolve(controller.hostApi.handleRequest({ version: 1, requestId: 'mounted-only-invocation',
        surface: controller.surfaceContext, method: 'executeAction',
        payload: { action: { pluginId, localId: actionId }, input: null },
    }));
    void pendingAction.then(() => { settled = true; }, () => { settled = true; });
    await act(async () => {});
    expect(settled, 'the real mounted admission waiter must retain an invocation until exact registration commits').toBe(false);
    expect(pluginBoundary.signal).toBeNull();

    pluginBoundary.activationGate.resolve();
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(fixture.composition.read(fixture.address)).not.toBeNull();
    });
    const registration = fixture.composition.read(fixture.address);
    if (!registration) throw new Error('Missing mounted-only Action registration');
    const cache = getInstalledPluginReactNativeBundleCache();
    const artifactIdentity = { artifactDigest: daemon.artifactDigest as PluginUiArtifactDigestV1 };
    expect(cache.readInstalledArtifact(artifactIdentity, fixture.lifetime.scope)).not.toBeNull();
    await vi.waitFor(() => expect(pluginBoundary.signal).not.toBeNull());
    pluginBoundary.pending.resolve('mounted-finished');
    await expect(pendingAction).resolves.toBe('mounted-finished');

    await fixture.unmountDemand();
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(fixture.composition.read(fixture.address)).toBeNull();
        expect(pluginBoundary.cleanups).toBe(1);
        expect(cache.readInstalledArtifact(artifactIdentity, fixture.lifetime.scope)).toBeNull();
    });
    expect(registration.lifecycle.signal.aborted).toBe(true);
    expect(fixture.lifetime.isCurrent()).toBe(true);
    expect(pluginBoundary.peerActivations).toBe(0);
    expect(daemon.peerMountedReads).toBe(0);
});

it('prevents a gated mounted-only client Action from attaching after its mounted demand unmounts', async () => {
    pluginBoundary.activationGate = createDeferred<void>();
    const fixture = await mountClientExecutableFixture({ mountedOnly: true, admitPeer: true, waitForAdmission: false,
        artifactLabel: 'mounted-only-client-action-unmounted' });
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(fixture.readMounted()?.phase).toBe('ready');
        expect(fixture.readObserved()?.mountedActionProjections).toHaveLength(1);
        expect(resolveProjectedPluginUiClientExecutables({ mountedActionProjections: fixture.readObserved()?.mountedActionProjections, platform })).toHaveLength(1);
        expect(pluginBoundary.enteredActivation, JSON.stringify(fixture.readObserved()?.clientExecutableActivation)).toBe(true);
    });
    expect(fixture.composition.read(fixture.address)).toBeNull();
    await fixture.unmountDemand();
    await flushHookEffects();
    pluginBoundary.activationGate.resolve();
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(pluginBoundary.cleanups).toBe(1);
    });
    expect(fixture.composition.read(fixture.address)).toBeNull();
    expect(pluginBoundary.signal).toBeNull();
    expect(fixture.lifetime.isCurrent()).toBe(true);
    expect(pluginBoundary.peerActivations).toBe(0);
    expect(daemon.peerMountedReads).toBe(0);
});

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
        .toMatchObject({ targetGeneration: defaultOccurrenceId, appliedGeneration: null });
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
    const declaredManifest = snapshot.materializations[0]?.declaredManifest;
    if (!declaredManifest) throw new Error('Missing producer manifest');
    const manifest = { ...declaredManifest, contributes: PluginContributesV2Schema.parse({
        ...declaredManifest.contributes,
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
        targetGeneration: defaultOccurrenceId,
        desiredGeneration: defaultOccurrenceId, appliedGeneration: null,
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

it('admits a newly demanded peer through mounted AppShell while the preceding activation is parked', async () => {
    pluginBoundary.activationGate = createDeferred<void>();
    const { lifetime, peerMachine, composition, readObserved } = await mountClientExecutableFixture({
        waitForAdmission: false, artifactLabel: 'independent-shell-admission',
    });
    await vi.waitFor(() => expect(pluginBoundary.enteredActivation).toBe(true));
    if (!daemon.peerProjection) throw new Error('Missing peer producer fixture');
    daemon.peerProjection = PluginProjectionV2Schema.parse({ ...daemon.peerProjection,
        actionsById: Object.fromEntries(Object.entries(daemon.peerProjection.actionsById)
            .map(([key, action]) => [key, { ...action, available: true }])) });
    await act(async () => {
        publishMachineContributionRegistryProjectionInvalidation({ machineId: peerMachine.id, serverId: lifetime.scope.serverId }, 'authority');
    });
    await vi.waitFor(async () => {
        await flushHookEffects();
        const projection = readObserved()?.pluginUiProjection;
        const target = projection && resolveProjectedPluginUiClientExecutables({ actionProjection: { projection }, platform })
            .find(target => target.pluginId === peerPluginId);
        expect(target).toBeDefined();
        if (!target) return;
        const registration = composition.read({ family: 'actions', pluginId: target.pluginId, localId: 'next',
            target: target.target, occurrenceId: target.occurrenceId, executionOrigin: target.executionOrigin });
        expect(registration).not.toBeNull();
        const handler = registration?.registration.value;
        if (typeof handler !== 'function') throw new Error('Missing peer Action');
        expect(await Reflect.apply(handler, undefined, [{}])).toBe('next');
    });
    expect(pluginBoundary.activationGate).not.toBeNull();
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
