// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PluginProjectionV2Schema, DaemonPluginUiArtifactBytesReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { normalizePluginUiDestinationBindingV1, computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';
import { createMachineFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { pluginArtifactTransferDaemonState } from '@/dev/testkit/harness/pluginArtifactTransferBoundary';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: { id: 'owner-machine', serverId: 'srv_machine_plugin_use', tab: 'plugin', pluginId: 'acme.machine-use', localId: 'status' },
}).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: 1440, height: 1000, scale: 1, fontScale: 1 }),
    Dimensions: { get: () => ({ width: 1440, height: 1000, scale: 1, fontScale: 1 }), addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// Only the network is replaced: acquisition, Account projection, Administration
// selection, Artifact adoption and the mounted page's Resource client stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(boundary.rpc));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { MachinePageScreen } = await import('./MachinePageScreen');
const { AppShellPluginUiProjectionProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { storage } = await import('@/sync/domains/state/storageStore');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { clearPluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
const { createPluginArtifactTransferBoundary } = await import('@/dev/testkit/harness/pluginArtifactTransferBoundary');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { PluginSurfaceFallback } = await import('@/components/sessions/panes/PluginSurfaceFallback');

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => {
    await standardCleanup();
    clearPluginAccountAvailabilityProjection();
    await connection?.dispose();
    connection = undefined;
    boundary.rpc.mockReset();
    vi.restoreAllMocks();
});

it('opens the addressed owner installed materialization Machine page for a Use viewer without Account installation census', async () => {
    installReactDomPortalBoundaryForTests();
    await prepareSessionDraftPersistenceStorage();
    const serverIdentityId = 'srv_machine_plugin_use';
    const pluginId = 'acme.machine-use';
    const machine = createMachineFixture({ id: 'owner-machine', active: true, activeAt: Date.now(), storageMode: 'plain',
        isShared: true, access: { role: 'use', custodian: { accountId: 'owner-a', displayName: 'Owner A' },
            resourceMode: 'plain', accessState: 'ready' }, daemonState: pluginArtifactTransferDaemonState });
    const other = createMachineFixture({ id: 'unopened-machine', active: true, activeAt: Date.now(), storageMode: 'plain', daemonState: pluginArtifactTransferDaemonState });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://machine-plugin-use.example.test', serverIdentityId, accountId: 'viewer-b',
        request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
                features: { machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: false }, serverRouted: { enabled: false } } },
                    plugins: { enabled: true, ui: { enabled: true, reactNativeBundles: { enabled: true } } } },
            }));
            if (path === '/v1/machines') return Response.json([machine, other].map(row => createPlainMachineRowFixture({ id: row.id, accountId: 'owner-a', machine: row })));
            return createEmptyAccountBootstrapHttpResponse(path, init) ?? Response.json({}, { status: 404 });
        } });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected viewer Account lifetime');
    const serverId = lifetime.scope.serverId;
    storage.setState({ isDataReady: true, isSessionDraftsReady: true, profileScope: lifetime.scope, settingsScope: lifetime.scope,
        machines: { [machine.id]: machine, [other.id]: other }, machineListByServerId: { [serverId]: [machine, other] },
        machineListStatusByServerId: { [serverId]: 'idle' } });
    observeMachinePresenceForTest({ serverId, accountId: lifetime.scope.accountId }, [machine.id, other.id]);
    const sourceCustody = { kind: 'development' as const, registeredRootId: 'owner-plugin-root' };
    const origin: PluginMachineExecutionOriginV1 = { serverIdentityId,
        materializationRef: { machineId: machine.id, pluginId, materializationId: 'owner-materialization' } };
    const bytes = new TextEncoder().encode(`
        const React = require('react');
        const Native = require('react-native');
        const { defineUiSurface, usePluginHostApi } = require('@happier-dev/plugin-ui');
        function Status() {
            const host = usePluginHostApi();
            const [value, setValue] = React.useState('waiting');
            React.useEffect(() => { let current = true;
                host.readResource('status').then(result => { if (current) setValue(String.fromCharCode(...result.bytes)); },
                    error => { if (current) setValue(error.code || error.message); });
                return () => { current = false; };
            }, [host]);
            return React.createElement(Native.Text, { testID: 'owner-plugin-status' }, value);
        }
        exports.renderSurface = defineUiSurface(Status);
    `);
    const entry = 'react-native/status-renderer/entry.cjs.bundle';
    const digest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entry, bytes }]);
    const graph = { artifactId: 'status-renderer', tier: 'reactNative', entry, digest,
        files: [{ relativePath: entry, digest: computePluginUiArtifactSha256DigestV1(bytes), byteSize: bytes.byteLength }],
        builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0' };
    const binding = normalizePluginUiDestinationBindingV1({ pluginId, destinationId: 'status', rendererId: 'status-renderer',
        container: 'appPage', target: { kind: 'machine' } });
    if (!binding) throw new Error('Expected public Machine page binding');
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Owner plugin', version: '1.0.0', enabled: true,
            occurrenceId: 'owner-installation', sourceCustody, executionOrigin: origin, source: { kind: 'path', locator: '/owner/plugin' } } },
        agentsById: {}, actionsById: {}, resourcesById: { [`${pluginId}/status`]: {
            id: 'status', pluginId, occurrenceId: 'owner-installation', executionOrigin: origin,
            resourceKind: 'config', scope: 'global', contentType: 'text/plain',
        } }, settingsById: {}, diagnostics: [],
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
            [`surfacePlacement:${pluginId}:status`]: { id: `surfacePlacement:${pluginId}:status`, pluginId, occurrenceId: 'owner-installation',
                executionOrigin: origin, contributionKind: 'surfacePlacement', descriptorId: 'status', binding, target: binding.target,
                renderer: { kind: 'reactNative', contributionId: 'status-renderer' }, display: { title: 'Owner status' },
                availability: { state: 'available', reason: 'available', diagnostics: [] },
                runtime: { resourceCapability: { readable: true, dynamic: true } } },
            [`reactNativeBundle:${pluginId}:status-renderer`]: { id: `reactNativeBundle:${pluginId}:status-renderer`, pluginId,
                occurrenceId: 'owner-installation', executionOrigin: origin, contributionKind: 'reactNativeBundle', contributionId: 'status-renderer',
                artifactSelectionOwner: 'daemonProjection', generatedV2: true, artifactGraph: graph,
                hostApi: { minVersion: '1.0.0', methods: ['readResource'] },
                runtime: { decision: { state: 'load', reason: 'compatible', diagnostics: [] }, loadPolicy: { source: 'installedArtifact' }, cacheKey: digest,
                    cacheIdentity: { artifactDigest: digest } } },
        } } } });
    const artifacts = createPluginArtifactTransferBoundary(() => DaemonPluginUiArtifactBytesReadResponseSchema.parse({
        ok: true, artifactFamily: 'reactNative', cacheIdentity: { artifactDigest: digest },
        artifact: { artifactKind: 'reactNativeBundle', digest, format: 'plainJs', byteSize: bytes.byteLength },
        files: graph.files.map(file => ({ ...file, bytesBase64: Buffer.from(bytes).toString('base64') })),
    }));
    const described: string[] = [];
    boundary.rpc.mockImplementation(async (request: { method: string; machineId: string; payload: unknown }) => {
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            described.push(request.machineId);
            return { protocolVersion: 1, projection };
        }
        if (artifacts.handles(request.method)) return artifacts.request(request);
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) return {
            status: 'current', targetedContributions: {
                target: { pluginId, occurrenceId: 'owner-installation', sourceCustody }, points: [],
            }, targetedSurfaceMounts: [],
            resourceDeclarationsByPluginId: { [pluginId]: projection.resourcesById },
        };
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) return {
            ok: true, resource: { pluginId, localId: 'status' }, kind: 'config', contentType: 'text/plain',
            digest: `sha256:${'a'.repeat(64)}`, bytesBase64: Buffer.from('owner-installed-ready').toString('base64'),
        };
        return new Promise(() => {});
    });
    const content = (active: boolean) => <AuthProvider initialCredentials={connection!.credentials}>
        <AppShellPluginUiProjectionProvider><PluginSurfaceFocusEligibilityProvider active={active}>
            <MachinePageScreen />
        </PluginSurfaceFocusEligibilityProvider></AppShellPluginUiProjectionProvider>
    </AuthProvider>;
    const screen = await renderScreen(content(false));
    await flushHookEffects();
    expect(described).toEqual([]);
    await screen.update(content(true));
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(screen.getTextContent(), JSON.stringify(screen.findAllByType(PluginSurfaceFallback).map(node => node.props.reasonCode))).toContain('owner-installed-ready');
    }, { timeout: 5_000 });
    expect(readPluginAccountAvailability(lifetime.scope)?.readInstalledPlugins()).toMatchObject({ kind: 'available', plugins: [] });
    expect(described.length).toBeGreaterThan(0);
    expect(new Set(described)).toEqual(new Set([machine.id]));
    const reads = boundary.rpc.mock.calls.map(([request]) => request).filter(request => request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ);
    expect(reads).toEqual(expect.arrayContaining([expect.objectContaining({ machineId: machine.id,
        payload: expect.objectContaining({ callerPluginId: pluginId, expectedCallerOccurrenceId: 'owner-installation' }) })]));
});
