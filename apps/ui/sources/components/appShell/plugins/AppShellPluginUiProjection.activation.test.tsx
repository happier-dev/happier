import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginContributesV2Schema, PluginProjectionV2Schema, type PluginProjectionV2 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonPluginUiArtifactBytesReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
    PluginUiArtifactsManifestEntryV2Schema,
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';

import { createDeferred, createMachineFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { storage } from '@/sync/domains/state/storageStore';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { clearPluginAccountAvailabilityProjection, readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, useActivePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import type { PluginAccountAvailabilitySnapshot } from '@/sync/domains/plugins/availability/reader';
import { dispatchPluginSurfaceAction } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import { createPluginUiProjectedActionResolver } from '@/sync/domains/plugins/ui/projection';
import { getInstalledPluginUiClientExecutableComposition } from '@/components/plugins/reactNative/clientExecutableContributions';
import { derivePluginReactNativeBundleCacheKey } from '@/components/plugins/reactNative/bundleCache';
import { resolveProjectedPluginUiClientExecutables } from '@/components/plugins/reactNative/clientExecutableProjection';
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
    activationGate: ReturnType<typeof createDeferred<void>> | null; enteredActivation: boolean;
    peerCleanupGate: ReturnType<typeof createDeferred<void>> | null; peerCleanupEntered: boolean; peerCleanupFinished: boolean } = {
    pending: createDeferred<string>(), cleanups: 0, signal: null, activationGate: null, enteredActivation: false,
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

async function mountClientExecutableFixture(options: { waitForAdmission?: boolean; admitPeer?: boolean } = {}) {
    pluginBoundary.pending = createDeferred<string>();
    pluginBoundary.cleanups = 0;
    pluginBoundary.signal = null;
    pluginBoundary.enteredActivation = false;
    pluginBoundary.peerCleanupEntered = false;
    pluginBoundary.peerCleanupFinished = false;
    connection = await restoreServerAccountForTest({ serverUrl: 'https://executable-continuity.test', serverIdentityId, accountId: 'account-continuity',
        request: async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/health') return Response.json({ status: 'ok' });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ version: 1, updatedAt: 1 }));
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
            machineAdministrationSelectionsV1: { v: 1, pluginExecutionOriginsByPluginId: { [pluginId]: origin } } } });

    fixtureGlobal.executableContinuityFixture = pluginBoundary;
    daemon.bytes = new TextEncoder().encode(`exports.activate = async function(api) {
        globalThis.executableContinuityFixture.enteredActivation = true;
        api.actions.register('hold', async function(input, context) {
            globalThis.executableContinuityFixture.signal = context.signal;
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
    const action = { id: actionId, title: 'Hold', scopes: ['session'], surfaces: ['ui'], placementBindings: ['detailsPanel'], dangerLevel: 'safe',
        execution: { target: 'client', client: { artifactId, exportName: 'activate' }, platforms: [platform] } };
    const contributes = PluginContributesV2Schema.parse({ actions: [action] });
    const peerContributes = PluginContributesV2Schema.parse({ actions: [{ ...action, id: 'next', execution: { ...action.execution, client: { artifactId: 'next', exportName: 'activate' } } }] });
    daemon.projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById: { [pluginId]: { id: pluginId, displayName: pluginId, version: '1.0.0', enabled: true, source: { kind: 'registryPackage', locator: pluginId } } },
        agentsById: {}, toolsById: {}, commandsById: {}, resourcesById: {}, settingsById: {}, diagnostics: [],
        actionsById: { [`${pluginId}/${actionId}`]: { ...contributes.actions[0], pluginId, available: true,
            occurrenceId: origin.materializationRef.materializationId, serverIdentityId, materializationRef: origin.materializationRef,
            authorization: { generation: { targetGeneration: '1', desiredGeneration: '1', appliedGeneration: '1' }, resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] } } },
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [`reactNativeBundle:${pluginId}:${actionId}`]: {
            id: `reactNativeBundle:${pluginId}:${actionId}`, pluginId, contributionKind: 'reactNativeBundle', contributionId: actionId,
            occurrenceId: origin.materializationRef.materializationId, serverIdentityId, materializationRef: origin.materializationRef,
            generatedOwnerKind: 'clientContribution', artifactGraph, runtime: { decision: { state: 'load' }, loadPolicy: { source: 'installedArtifact' }, cacheIdentity: { artifactDigest },
                cacheKey: derivePluginReactNativeBundleCacheKey({ pluginId, contributionId: actionId, artifactId, artifactDigest, platform }) },
        } } } } });
    const firstAction = daemon.projection.actionsById[`${pluginId}/${actionId}`];
    const ownPluginUi = daemon.projection.familiesById.pluginUi;
    if (!ownPluginUi) throw new Error('Missing fixture plugin UI family');
    const firstBundle = ownPluginUi.entriesById[`reactNativeBundle:${pluginId}:${actionId}`];
    daemon.projection = PluginProjectionV2Schema.parse({ ...daemon.projection,
        installedPackagesById: { ...daemon.projection.installedPackagesById, [peerPluginId]: { ...daemon.projection.installedPackagesById[pluginId], id: peerPluginId,
            displayName: peerPluginId, source: { kind: 'registryPackage', locator: peerPluginId } } },
        actionsById: { ...daemon.projection.actionsById, [`${peerPluginId}/next`]: { ...firstAction, ...peerContributes.actions[0], pluginId: peerPluginId,
            occurrenceId: 'peer-install', materializationRef: { machineId: peerMachine.id, pluginId: peerPluginId, materializationId: 'peer-install' }, available: options.admitPeer === true } },
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: { ...ownPluginUi.entriesById,
            [`reactNativeBundle:${peerPluginId}:next`]: { ...firstBundle, id: `reactNativeBundle:${peerPluginId}:next`, pluginId: peerPluginId, contributionId: 'next',
                occurrenceId: 'peer-install', materializationRef: { machineId: peerMachine.id, pluginId: peerPluginId, materializationId: 'peer-install' }, artifactGraph: nextGraph,
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
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [`reactNativeBundle:${pluginId}:${actionId}`]: firstBundle } } } });
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

it('cancels an unfinished real executable activation before it can publish after exact Machine withdrawal', async () => {
    pluginBoundary.activationGate = createDeferred<void>();
    const { lifetime, machine, composition, address } = await mountClientExecutableFixture({ waitForAdmission: false });
    await vi.waitFor(() => expect(pluginBoundary.enteredActivation).toBe(true));
    expect(composition.read(address)).toBeNull();
    await act(async () => storage.setState({ machines: { [machine.id]: { ...machine, active: false, activeAt: 0 } },
        machineListByServerId: { [lifetime.scope.serverId]: [{ ...machine, active: false, activeAt: 0 }] } }));
    await flushHookEffects();
    pluginBoundary.activationGate.resolve();
    await flushHookEffects({ cycles: 12 });
    expect(lifetime.isCurrent()).toBe(true);
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
