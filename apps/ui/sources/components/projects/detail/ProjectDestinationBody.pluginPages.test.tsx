import * as React from 'react';
import { View } from 'react-native';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { PluginAccountAvailabilityIntentReadResponseV1Schema, PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { renderScreen } from '@/dev/testkit';
import { projectLastActiveRootPathState, projectLastActiveWorktreeIdState } from '@/sync/domains/state/navigationUiState';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import { resolveProjectSelectionPreferenceKeys } from '@/sync/domains/settings/projectSelectionPersistence';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';

const viewport = vi.hoisted(() => ({ width: 1440 }));
installSessionDetailsPanelNonRnModuleMocks();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Dimensions: { get: () => ({ width: viewport.width, height: 900, scale: 1, fontScale: 1 }) },
    useWindowDimensions: () => ({ width: viewport.width, height: 900, scale: 1, fontScale: 1 }),
}));
type RpcRequest = Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope>[0];
const daemon = vi.hoisted(() => vi.fn<(request: RpcRequest) => Promise<unknown>>(
    async () => ({ success: false, errorCode: 'FEATURE_UNSUPPORTED' })));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(daemon));

const runtime = installSessionPaneRuntimeTestHarness({ features: () => createRootLayoutFeaturesResponse({
    features: { plugins: { enabled: true, ui: { enabled: true, hostedWeb: { enabled: false }, reactNativeBundles: { enabled: true } } } },
}) });
const { storage } = await import('@/sync/domains/state/storage');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { router: navigation } = await import('expo-router');
const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
const { getInstalledPluginReactNativeModuleRegistry } = await import('@/components/plugins/reactNative/moduleRegistry');
const { createInstalledPluginUiReactNativeRuntimeProjectionSource } = await import('@/components/plugins/reactNative/projectionInvalidation');
const { ProjectDestinationBody } = await import('./ProjectDestinationBody');
const { PluginSurfaceFallback } = await import('@/components/sessions/panes/PluginSurfaceFallback');
const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
const { SessionCockpitChromeRegistryProvider } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
const { MobileBottomChromeHost } = await import('@/components/navigation/mobile/chrome/MobileBottomChromeHost');
const { ProjectCockpitTabBar } = await import('@/components/navigation/mobile/chrome/bars/ProjectCockpitTabBar');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');

beforeEach(() => {
    daemon.mockClear();
    replacePersistentUiStateForTest(projectLastActiveRootPathState, {});
    replacePersistentUiStateForTest(projectLastActiveWorktreeIdState, {});
});

describe('external Project page through the real destination host', () => {
    it.each([1440, 390])('renders offline at width %i without Run-on, keeps exact local location, and leaves never-presented siblings asleep', async width => {
        viewport.width = width;
        const pluginId = 'fixture.project-pages';
        const ids = ['builds', 'notes'] as const;
        const workspaceRef = { id: 'wr_external', serverId: runtime.serverId, machineId: 'offline-checkout',
            rootPath: '/offline/repo', projectKey: 'logical-project', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [workspaceRef] });
        storage.getState().applyMachines([], true, { sourceServerId: runtime.serverId });
        // This journey opens only the page. Tablet's optional, initially open Git
        // companion has its own checkout workload and is not part of page discovery.
        storage.setState({ settings: { ...storage.getState().settings, mobileWorkspaceExperienceV1: 'cockpit' },
            localSettings: { ...storage.getState().localSettings, uiMultiPanePanelsEnabled: false } });
        const artifactGraphs = ids.map((localId, index) => {
            const artifactId = `project-${localId}`;
            const entry = `react-native/${artifactId}/entry.cjs.bundle`;
            return PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId, tier: 'reactNative', entry,
                files: [{ relativePath: entry, digest: `sha256:${'b'.repeat(64)}`, byteSize: 16 }],
                digest: `sha256:${(index === 0 ? 'a' : 'c').repeat(64)}`, builtWith: { bundler: 'esbuild', version: '0.27.2' },
                executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0' });
        });
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('The real Home fixture must admit an Account');
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
            hostingCapability: { enabled: false }, intent: { pluginId, desiredVersion: '1.0.0', enabled: true,
                offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
            release: { ref: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
                normalizedManifest: PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: pluginId,
                    version: '1.0.0', displayName: 'Project tools', engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
                    contributes: { ui: { renderers: ids.map((id, index) => ({ id: `${id}-renderer`, kind: 'reactNative', artifact: artifactGraphs[index]!.artifactId,
                            requiredHostMethods: ['context'] })),
                        views: ids.map(id => ({ id, container: 'appPage', target: { kind: 'project' }, renderer: `${id}-renderer`,
                            title: id, instancePolicy: 'singleton' })) } } }),
                collectionContracts: [], uiSlots: ids.map((id, index) => ({ contributionId: `${id}-renderer`,
                    artifactId: artifactGraphs[index]!.artifactId, tier: 'reactNative', platform: 'web',
                    artifactDigest: artifactGraphs[index]!.digest, hostUiApiRange: '^1.0.0', artifactGraph: artifactGraphs[index] })),
                packageAssetArchive: { archiveDigestSha256: `sha256:${'e'.repeat(64)}`, resources: [] } },
            packageAssets: [], uiArtifacts: [] });
        replacePluginAccountAvailabilityProjection({ scope: accountLifetime.scope, snapshot: { availabilityCursor: 1,
            intentReads: [{ pluginId, response }], materializations: [], snapshots: [], inventoryComplete: true } });
        const accountReader = readPluginAccountAvailability(accountLifetime.scope);
        expect(accountReader.readCurrentAccountExecution(pluginId)).toMatchObject({ kind: 'available' });
        const model = accountReader.readAccountUiProjection();
        if (!model) throw new Error('The Account Availability producer must publish the external Project pages');
        expect(Object.values(model.surfacePlacementsById).map(page => page.binding.kind === 'destination'
            ? page.binding.destination.localId : null)).toEqual([...ids]);
        expect(Object.values(model.surfacePlacementsById).every(page => page.hostAccountOrigin !== undefined)).toBe(true);
        const cacheKeys = ids.map(id => {
            const entry = Object.values(model.reactNativeBundlesById).find(bundle => bundle.contributionId === `${id}-renderer`);
            const facts = entry?.runtime;
            if (!facts || typeof facts !== 'object' || !('cacheKey' in facts) || typeof facts.cacheKey !== 'string') {
                throw new Error(`The Account renderer ${id} must have an admitted module cache key`);
            }
            return facts.cacheKey;
        });
        const contexts: RenderContext[] = [];
        let siblingRenders = 0;
        // The standalone projection value provider does not own runtime activation.
        // Borrow the same Account projection source the real AppShell uses so a
        // checkout companion cannot retire this current Account's admitted modules.
        const artifactSource = createInstalledPluginUiReactNativeRuntimeProjectionSource();
        onTestFinished(() => artifactSource.dispose());
        artifactSource.update({ projection: model, accountLifetime, isCurrent: () => accountLifetime.isCurrent() });
        const registry = getInstalledPluginReactNativeModuleRegistry();
        // Foreign plugin execution is supplied at the installed-module boundary. The real
        // registry, native renderer, surface mount, catalog, route and stores stay in the path.
        for (const [index, localId] of ids.entries()) {
            const cacheKey = cacheKeys[index]!;
            const fence = registry.captureWriteFence(cacheKey);
            if (!fence) throw new Error('fixture module must have active admission');
            registry.write(cacheKey, { renderSurface: context => {
                if (localId === 'notes') siblingRenders += 1;
                else contexts.push(context);
                return <View testID={`external-project-${localId}`} />;
            } }, fence);
        }
        const projection = { pluginUiProjection: model, pluginBrowserProjection: null, phase: 'current' as const,
            interactionEnabled: true, machineId: null, serverId: runtime.serverId, platform: 'web' as const,
            accountLifetime, clientExecutableActivation: { status: 'ready' as const },
            reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} };
        const render = (subPath: string, visible: boolean, focused = visible, projectRoot = false) => <runtime.Wrapper>
            <MainAppTabStateProvider><SessionCockpitChromeRegistryProvider>
            <AppShellPluginUiProjectionValueProvider value={projection}>
                <DestinationInstanceHost tabId="external-project" ref={{ kind: 'project', params: {
                    workspaceRefId: workspaceRef.id, serverId: runtime.serverId,
                    ...(projectRoot ? {} : { pageId: `plugins/${pluginId}/builds${subPath ? `/${subPath}` : ''}` }),
                } }} pathname={projectRoot ? `/projects/${workspaceRef.id}`
                    : `/projects/${workspaceRef.id}/plugins/${pluginId}/builds${subPath ? `/${subPath}` : ''}`}
                    visible={visible} focused={focused} navigation={navigation}>
                    <ProjectDestinationBody />
                    {width === 390 ? <MobileBottomChromeHost /> : null}
                </DestinationInstanceHost>
            </AppShellPluginUiProjectionValueProvider>
            </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider>
        </runtime.Wrapper>;
        const settingsWrite = vi.spyOn(storage.getState(), 'applyLocalSettings');
        onTestFinished(() => settingsWrite.mockRestore());
        const screen = await renderScreen(render('', false));
        expect(daemon.mock.calls).toHaveLength(0);
        expect(contexts).toHaveLength(0);
        expect(siblingRenders).toBe(0);
        const preferenceKeys = resolveProjectSelectionPreferenceKeys([workspaceRef], workspaceRef)!;
        expect(projectLastActiveRootPathState.read(preferenceKeys.storageKey)).toBeUndefined();
        await screen.update(render('runs/42', true));
        await vi.waitFor(() => expect(screen.findHostByTestId('external-project-builds'), JSON.stringify(
            screen.findAllByType(PluginSurfaceFallback).map(node => ({ testID: node.props.testID, reasonCode: node.props.reasonCode })),
        )).not.toBeNull());
        expect(screen.findHostByTestId('plugin-page-execution.chip')).toBeNull();
        expect(screen.findHostByTestId('plugin-page-execution.current')).toBeNull();
        expect(contexts.at(-1)?.surface.target).toMatchObject({ kind: 'project', projectKey: workspaceRef.projectKey,
            checkout: { id: workspaceRef.id, serverId: runtime.serverId, machineId: workspaceRef.machineId } });
        expect(contexts.at(-1)?.subPath).toBe('runs/42');
        if (width === 390) {
            const pageIds = ids.map(id => `plugin:${pluginId}:${id}`);
            expect(screen.findByType(ProjectCockpitTabBar).props.pages.map((page: { id: string }) => page.id))
                .toEqual(expect.arrayContaining(pageIds));
            const more = screen.findAllByType(DropdownMenu).find(menu => menu.props.items.some(
                (item: { id: string }) => item.id === pageIds[0]));
            expect(more?.props.items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(pageIds));
        }
        expect(projectLastActiveRootPathState.read(preferenceKeys.storageKey)).toBe('/offline/repo');
        expect(projectLastActiveWorktreeIdState.read(preferenceKeys.storageKey)).toBe('@root');
        expect(settingsWrite).not.toHaveBeenCalled();
        await screen.update(render('runs/42/page', true));
        await vi.waitFor(() => expect(contexts.at(-1)?.subPath).toBe('runs/42/page'));
        await screen.update(render('runs/42/page', true, false));
        expect(screen.findHostByTestId('external-project-builds')).not.toBeNull();
        await screen.update(render('runs/42/page', false));
        expect(screen.findHostByTestId('external-project-builds')).toBeNull();
        expect(siblingRenders).toBe(0);
        expect(daemon.mock.calls).toHaveLength(0);
        if (width === 390) {
            await screen.update(render('', true, true, true));
            expect(screen.findByType(ProjectCockpitTabBar).props.pages.map((page: { id: string }) => page.id))
                .toEqual(expect.arrayContaining(ids.map(id => `plugin:${pluginId}:${id}`)));
            expect(siblingRenders).toBe(0);
        }
        await screen.unmount();
    });
});
