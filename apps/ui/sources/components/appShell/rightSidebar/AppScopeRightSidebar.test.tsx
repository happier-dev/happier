import * as React from 'react';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderScreen as renderPanelScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import type { SelectedPaneDestinationV1 } from '@/components/appShell/panes/model/selectedPaneDestination';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import { selectPluginDestinationSurfacePlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    PluginSurfaceDestinationNavigationBindingProvider,
    PluginSurfacePaneLaunchScope,
    usePluginSurfaceDestinationNavigationBinding,
    usePluginSurfaceDestinationNavigationBindingForScope,
    useRegisterPluginSurfaceDestinationNavigationOwner,
    type PluginSurfaceDestinationNavigationBinding,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import {
    APP_PANE_SCOPE_ID,
    useAppScopeRightSidebarDestinationHandler,
} from './appScopeRightSidebarNavigation';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const endpointConnectivityState = vi.hoisted(() => ({
    status: 'online' as 'online' | 'offline',
}));
const paneScopeSeed = vi.hoisted(() => ({
    activeTabId: null as string | null,
    selectedDestination: null as SelectedPaneDestinationV1 | null,
}));
const accountLifetimeState = vi.hoisted(() => ({
    lifetime: null as ActiveServerAccountScopeLifetime | null,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

/** The last props the mount received for a given placement descriptor. */
const runtime = installSessionPaneRuntimeTestHarness({ scopeId: APP_PANE_SCOPE_ID });
let mountedScreen: Awaited<ReturnType<typeof renderPanelScreen>> | null = null;
let ActualSurfaceHost: typeof import('@/components/plugins/surfaces')['PluginSurfacePlacementHost'];
type SurfaceMountProps = React.ComponentProps<typeof import('@/components/plugins/surfaces')['PluginSurfacePlacementHost']>;

function latestMountFor(descriptorId: string): SurfaceMountProps | null {
    // The component query preserves the mounted surface's real public props.
    return mountedScreen?.tree.findAllByType<typeof ActualSurfaceHost>(ActualSurfaceHost)
        .find(node => node.props.placement?.descriptorId === descriptorId)?.props ?? null;
}

function AppScopeTestWrapper({ children }: React.PropsWithChildren) {
    return <runtime.Wrapper><AppShellPluginUiProjectionValueProvider value={{
        pluginUiProjection: null, pluginBrowserProjection: null, phase: 'current',
        interactionEnabled: true, machineId: 'machine-a', serverId: runtime.serverId, platform: 'web',
        accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
        reloadConnectedAccountProjection: () => {},
    }}>{children}</AppShellPluginUiProjectionValueProvider></runtime.Wrapper>;
}

async function renderScreen(element: React.ReactElement) {
    const screen = await renderPanelScreen(<React.Fragment />, { wrapper: AppScopeTestWrapper });
    await act(async () => {
        if (paneScopeSeed.activeTabId) runtime.pane.openRight({ tabId: paneScopeSeed.activeTabId });
        if (paneScopeSeed.selectedDestination) runtime.pane.selectRightDestination(paneScopeSeed.selectedDestination);
    });
    mountedScreen = screen;
    await screen.update(element);
    return screen;
}


vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});


const routerState = vi.hoisted(() => ({ pathname: '/settings/plugins' }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => routerState.pathname }).module;
});

function createAppSidebarPlacement(input: Readonly<{
    descriptorId: string;
    rendererId: string;
    order: number;
    availability?: PluginUiSurfacePlacementProjection['availability'];
}>): PluginUiSurfacePlacementProjection {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: 'acme.preview',
        destinationId: input.descriptorId,
        rendererId: input.rendererId,
        container: 'rightSidebarTab',
        target: { kind: 'app' },
    });
    if (!binding) {
        throw new Error('test fixture must use an admitted V2 destination binding');
    }
    return {
        id: `surfacePlacement:acme.preview:${input.descriptorId}`,
        pluginId: 'acme.preview',
        occurrenceId: 'acme-preview-occurrence',
        contributionKind: 'surfacePlacement',
        descriptorId: input.descriptorId,
        binding,
        target: { kind: 'app' },
        renderer: { kind: 'host', rendererId: input.rendererId },
        display: { developerFallback: `Acme ${input.descriptorId}` },
        availability: input.availability ?? { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
        order: input.order,
    };
}

function executionOrigin(input: Readonly<{
    machineId: string;
    materializationId: string;
}>): PluginMachineExecutionOriginV1 {
    return PluginMachineExecutionOriginV1Schema.parse({
        // An advertised Home identity is not the device-local server profile id.
        serverIdentityId: runtime.serverIdentityId,
        materializationRef: {
            pluginId: 'acme.preview',
            machineId: input.machineId,
            materializationId: input.materializationId,
        },
    });
}

function withSelectedContributionOrigin(
    placement: PluginUiSurfacePlacementProjection,
    input: Readonly<{
        generation: number;
        machineId: string;
        materializationId: string;
    }>,
): PluginUiSurfacePlacementProjection {
    return Object.freeze({
        ...placement,
        hostOrigin: Object.freeze({
            serverId: runtime.serverId,
            machineId: input.machineId,
            generation: input.generation,
            phase: 'current',
            interactionEnabled: true,
            executionOrigin: executionOrigin(input),
        }),
    });
}


const appSidebarPlacement = createAppSidebarPlacement({
    descriptorId: 'app-panel',
    rendererId: 'descriptor-panel',
    order: 10,
});
const appDetailPlacement = createAppSidebarPlacement({
    descriptorId: 'detail-panel',
    rendererId: 'detail-panel',
    order: 20,
});

function projectionWith(...placements: readonly PluginUiSurfacePlacementProjection[]): PluginUiProjectionModel {
    return {
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: 1,
        surfacePlacementsById: Object.fromEntries(placements.map((placement) => [placement.id, placement])),
    };
}

/**
 * Mirrors the shell's app-target navigation boundary: the one binding, the
 * app-lifetime pane handoff scope, and the app-lifetime `rightSidebarTab`
 * owner. The sidebar leaf below it registers nothing of its own.
 */
function AppScopeRightSidebarNavigationOwner(): null {
    const binding = usePluginSurfaceDestinationNavigationBinding();
    const handler = useAppScopeRightSidebarDestinationHandler();
    const owner = React.useMemo(() => ({
        container: 'rightSidebarTab' as const,
        handler,
    }), [handler]);
    useRegisterPluginSurfaceDestinationNavigationOwner(owner, binding);
    return null;
}

function AppTargetNavigationScope(props: React.PropsWithChildren<Readonly<{
    projection: PluginUiProjectionModel;
    onBinding?: (binding: PluginSurfaceDestinationNavigationBinding) => void;
}>>): React.ReactElement {
    const binding = usePluginSurfaceDestinationNavigationBindingForScope({
        placements: selectPluginDestinationSurfacePlacements(props.projection),
        settingsPages: Object.values(props.projection.settingsPagesById),
        targetKind: 'app',
        accountLifetime: accountLifetimeState.lifetime,
    });
    const { onBinding } = props;
    React.useEffect(() => { onBinding?.(binding); }, [binding, onBinding]);
    return (
        <PluginSurfaceDestinationNavigationBindingProvider binding={binding}>
            <PluginSurfacePaneLaunchScope>
                <AppScopeRightSidebarNavigationOwner />
                {props.children}
            </PluginSurfacePaneLaunchScope>
        </PluginSurfaceDestinationNavigationBindingProvider>
    );
}

/**
 * Drive the mounted surface through the REAL bound controller and the REAL
 * public React Native host-API adapter.
 *
 * §3.1: this sidebar no longer composes a Host API — it hands the bound
 * controller the one fact it owns, its destination selector. The composed proof
 * therefore builds the controller from the facts the sidebar actually passed to
 * the mount (exactly as `PluginSurfaceHost` does), so a sidebar that stopped
 * supplying `openSurface`, or supplied it for the wrong placement, fails here.
 */
async function createMountedHostApiClient(descriptorId: string) {
    const mount = latestMountFor(descriptorId);
    expect(mount?.binding, 'the sidebar must hand its facts to the bound controller').toBeTruthy();
    if (!mount?.binding) throw new Error('Expected an actual mounted plugin surface binding');
    const { createBoundPluginSurfaceController } = await import(
        '@/components/plugins/surfaces/boundPluginSurfaceController'
    );
    const { createCanonicalPluginReactNativeHostApiAdapter } = await import(
        '@/components/plugins/reactNative/hostApi'
    );
    const controller = createBoundPluginSurfaceController({
        facts: {
            pluginId: mount.placement.pluginId,
            contributionId: mount.placement.descriptorId,
            surfaceId: mount.placement.id,
            placement: 'rightSidebarSurface',
            platform: 'web',
            accountLifetime: accountLifetimeState.lifetime,
            interactionEnabled: endpointConnectivityState.status === 'online',
            // This composed sidebar proof supplies no daemon transport fact.
            // `openSurface` is placement-local, so it must remain available
            // without pretending that daemon Action/Resource transport exists.
            daemonInteractionEnabled: false,
        },
        binding: mount.binding,
    });
    return createCanonicalPluginReactNativeHostApiAdapter({
        surface: createPluginSurfaceContextFixture({
            mount: {
                kind: 'destination',
                destination: {
                    pluginId: mount.placement.pluginId,
                    localId: mount.placement.descriptorId,
                },
                container: 'rightSidebarTab',
            },
            target: { kind: 'app' },
        }),
        requestSurface: controller.surfaceContext,
        requestIdPrefix: `test:${descriptorId}`,
        handleRequest: controller.hostApi.handleRequest,
        installedMethods: controller.hostApi.installedMethods,
    });
}

describe('AppScopeRightSidebar', () => {
    beforeEach(async () => {
        endpointConnectivityState.status = 'online';
        mountedScreen = null;
        paneScopeSeed.activeTabId = null;
        paneScopeSeed.selectedDestination = null;
        routerState.pathname = '/settings/plugins';
        accountLifetimeState.lifetime = captureActiveServerAccountScopeLifetime();
        ({ PluginSurfacePlacementHost: ActualSurfaceHost } = await import('@/components/plugins/surfaces'));
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-a', activeAt: Date.now() })]);
    });

    it('mounts an available app-scope plugin tab surface through the canonical host', async () => {
        const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');
        paneScopeSeed.selectedDestination = {
            kind: 'plugin',
            destination: appSidebarPlacement.binding.destination,
        };

        const screen = await renderScreen(
            <AppScopeRightSidebar
                scopeId={APP_PANE_SCOPE_ID}
                pluginUiProjection={projectionWith(appSidebarPlacement)}
                projectionPhase="current"
                platform="web"
                testID="app-scope-right-sidebar"
            />,
        );

        expect(screen.findByTestId('app-scope-right-sidebar-tab:plugin:acme.preview:app-panel')).toBeTruthy();
        expect(latestMountFor('app-panel')).toBeTruthy();
    });

    it('does not construct a fallback app-target navigation binding outside the shell host', async () => {
        const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');
        paneScopeSeed.selectedDestination = {
            kind: 'plugin',
            destination: appSidebarPlacement.binding.destination,
        };

        const screen = await renderScreen(
            <AppScopeRightSidebar
                scopeId={APP_PANE_SCOPE_ID}
                pluginUiProjection={projectionWith(appSidebarPlacement)}
                projectionPhase="current"
                platform="web"
            />,
        );

        expect(latestMountFor('app-panel')).toBeTruthy();
        expect(latestMountFor('app-panel')?.binding?.openSurface).toBeUndefined();
    });

    it('selects the exact qualified destination requested by the compact App route', async () => {
        const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');

        const screen = await renderScreen(
            <AppScopeRightSidebar
                scopeId={APP_PANE_SCOPE_ID}
                requestedDestination={{ pluginId: 'acme.preview', localId: 'detail-panel' }}
                pluginUiProjection={projectionWith(
                    withSelectedContributionOrigin(appSidebarPlacement, {
                        generation: 1,
                        machineId: 'machine-a',
                        materializationId: 'install-a',
                    }),
                    withSelectedContributionOrigin(appDetailPlacement, {
                        generation: 1,
                        machineId: 'machine-a',
                        materializationId: 'install-a',
                    }),
                )}
                platform="web"
            />,
        );

        expect(latestMountFor('detail-panel')).toBeTruthy();
        expect(latestMountFor('app-panel')).toBeNull();
    });

    // §3.1: connectivity is no longer this sidebar's decision. The bound
    // controller keeps the already-admitted local destination selector alive
    // while daemon interaction is inactive; only daemon-backed methods retire.
    it('keeps the local destination selector available while the endpoint is offline', async () => {
        endpointConnectivityState.status = 'offline';
        const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');
        const projection = projectionWith(appSidebarPlacement);
        paneScopeSeed.selectedDestination = {
            kind: 'plugin',
            destination: appSidebarPlacement.binding.destination,
        };

        await renderScreen(
            <AppTargetNavigationScope projection={projection}>
                <AppScopeRightSidebar
                    scopeId={APP_PANE_SCOPE_ID}
                    pluginUiProjection={projection}
                    projectionPhase="current"
                    platform="web"
                />
            </AppTargetNavigationScope>,
        );

        const offline = await createMountedHostApiClient('app-panel');
        expect(offline.api.version().methods).toContain('openSurface');

        endpointConnectivityState.status = 'online';
        const online = await createMountedHostApiClient('app-panel');
        expect(online.api.version().methods).toContain('openSurface');
    });

    it('renders the empty state when no app-scope plugin tabs are available', async () => {
        const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');

        const screen = await renderScreen(
            <AppScopeRightSidebar
                scopeId={APP_PANE_SCOPE_ID}
                pluginUiProjection={projectionWith()}
                platform="web"
                testID="app-scope-right-sidebar-empty"
            />,
        );

        expect(screen.findByTestId('app-scope-right-sidebar-empty')).toBeTruthy();
        expect(latestMountFor('app-panel')).toBeNull();
    });

    it('keeps a restored app plugin destination pending, then tombstones it when the settled catalog lacks it', async () => {
        paneScopeSeed.activeTabId = 'plugin:acme.preview:removed-panel';
        const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');

        const screen = await renderScreen(
            <AppScopeRightSidebar
                scopeId={APP_PANE_SCOPE_ID}
                pluginUiProjection={projectionWith()}
                projectionPhase="establishing"
                platform="web"
                testID="app-scope-right-sidebar-empty"
            />,
        );

        // A restored destination is user intent, so an empty establishing
        // catalog is pending rather than the sidebar's ordinary empty state.
        expect(screen.getTextContent()).toContain('common.loading');
        expect(screen.getTextContent()).not.toContain('pluginSurfaces.appScopeRightSidebar.empty');
        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();

        await screen.update(
            <AppScopeRightSidebar
                scopeId={APP_PANE_SCOPE_ID}
                pluginUiProjection={projectionWith()}
                projectionPhase="current"
                platform="web"
                testID="app-scope-right-sidebar-empty"
            />,
        );

        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('pluginSurfaces.appScopeRightSidebar.empty');
        expect(latestMountFor('app-panel')).toBeNull();
    });

    it('does not mount a fallback/unavailable plugin tab surface (fail-closed)', async () => {
        const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');

        const screen = await renderScreen(
            <AppScopeRightSidebar
                scopeId={APP_PANE_SCOPE_ID}
                pluginUiProjection={projectionWith({
                    ...appSidebarPlacement,
                    availability: { state: 'fallback', reason: 'feature_disabled', diagnostics: ['feature_disabled'] },
                })}
                platform="web"
                testID="app-scope-right-sidebar-deferred"
            />,
        );

        // The disabled-by-default tab is hidden, so the surface renders the empty state.
        expect(latestMountFor('app-panel')).toBeNull();
    });

    describe('openSurface launch input (EU-5a)', () => {
        async function renderTwoTabSidebar() {
            const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');
            const projection = projectionWith(
                withSelectedContributionOrigin(appSidebarPlacement, {
                    generation: 1,
                    machineId: 'machine-a',
                    materializationId: 'install-a',
                }),
                withSelectedContributionOrigin(appDetailPlacement, {
                    generation: 1,
                    machineId: 'machine-a',
                    materializationId: 'install-a',
                }),
            );
            const screen = await renderScreen(
                <AppTargetNavigationScope projection={projection}>
                    <AppScopeRightSidebar
                        scopeId={APP_PANE_SCOPE_ID}
                        pluginUiProjection={projection}
                        platform="web"
                        testID="app-scope-right-sidebar-launch"
                    />
                </AppTargetNavigationScope>,
            );
            await act(async () => {
                screen.pressByTestId('app-scope-right-sidebar-tab:plugin:acme.preview:app-panel');
            });
            return screen;
        }

        it('delivers author-supplied launch input to the destination render context', async () => {
            const screen = await renderTwoTabSidebar();
            const caller = await createMountedHostApiClient('app-panel');

            expect(caller.api.version().methods).toContain('openSurface');

            await act(async () => {
                await caller.api.openSurface({ pluginId: 'acme.preview', localId: 'detail-panel' }, { itemId: 'item-7' });
            });

            expect(latestMountFor('detail-panel')).toBeTruthy();
            expect(latestMountFor('detail-panel')?.launchInput).toEqual({ itemId: 'item-7' });
        });

        it('reopens an already-selected destination with the new launch input', async () => {
            await renderTwoTabSidebar();
            const caller = await createMountedHostApiClient('app-panel');

            await act(async () => {
                await caller.api.openSurface({ pluginId: 'acme.preview', localId: 'detail-panel' }, { itemId: 'first' });
            });
            expect(latestMountFor('detail-panel')?.launchInput).toEqual({ itemId: 'first' });

            // The destination is now the selected tab; reopening it must replace
            // the launch input rather than keep the first one.
            const reopener = await createMountedHostApiClient('detail-panel');
            await act(async () => {
                await reopener.api.openSurface({ pluginId: 'acme.preview', localId: 'detail-panel' }, { itemId: 'second' });
            });
            expect(latestMountFor('detail-panel')?.launchInput).toEqual({ itemId: 'second' });
        });

        it('leaves launch input undefined when the author supplies none', async () => {
            await renderTwoTabSidebar();
            const caller = await createMountedHostApiClient('app-panel');

            await act(async () => {
                await caller.api.openSurface({ pluginId: 'acme.preview', localId: 'detail-panel' });
            });

            const destination = latestMountFor('detail-panel');
            expect(destination).toBeTruthy();
            if (!destination) throw new Error('Expected the admitted detail-panel mount');
            expect(destination.launchInput).toBeUndefined();
        });

        it('refuses a tab without an exact selected contribution origin instead of falling back to the union authority', async () => {
            const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');
            const projection = projectionWith(
                withSelectedContributionOrigin(appSidebarPlacement, {
                    generation: 1,
                    machineId: 'machine-a',
                    materializationId: 'install-a',
                }),
                appDetailPlacement,
            );
            const screen = await renderScreen(
                <AppTargetNavigationScope projection={projection}>
                    <AppScopeRightSidebar
                        scopeId={APP_PANE_SCOPE_ID}
                        pluginUiProjection={projection}
                        platform="web"
                    />
                </AppTargetNavigationScope>,
            );
            await act(async () => {
                screen.pressByTestId('app-scope-right-sidebar-tab:plugin:acme.preview:app-panel');
            });
            const caller = await createMountedHostApiClient('app-panel');

            await act(async () => {
                await expect(
                    caller.api.openSurface({ pluginId: 'acme.preview', localId: 'detail-panel' }, { itemId: 'missing-origin' }),
                ).rejects.toMatchObject({
                    code: 'unavailable',
                    diagnostics: [{ code: 'plugin_surface_open_origin_unavailable', severity: 'error' }],
                });
            });

            expect(latestMountFor('detail-panel')).toBeNull();
            expect(latestMountFor('app-panel')).toBeTruthy();
        });

        it('rejects launch input above the bounded size with a typed error instead of truncating it', async () => {
            const { PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1 } = await import('@happier-dev/protocol/plugins/ui');
            await renderTwoTabSidebar();
            const caller = await createMountedHostApiClient('app-panel');

            expect(PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1).toBeGreaterThan(0);
            const oversize = { blob: 'x'.repeat(PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1) };
            await act(async () => {
                await expect(
                    caller.api.openSurface({ pluginId: 'acme.preview', localId: 'detail-panel' }, oversize),
                ).rejects.toMatchObject({
                    code: 'invalid_payload',
                    diagnostics: [{ code: 'plugin_surface_open_payload_invalid', severity: 'error' }],
                });
            });

            // Nothing is opened and nothing is truncated.
            expect(latestMountFor('detail-panel')).toBeNull();
        });

        it('retains launch input across a projection refresh from the same exact producer', async () => {
            const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');
            const sidebarAtGeneration = (generation: number) => {
                const projection = {
                    ...projectionWith(
                        withSelectedContributionOrigin(appSidebarPlacement, {
                            generation,
                            machineId: 'machine-a',
                            materializationId: 'install-a',
                        }),
                        withSelectedContributionOrigin(appDetailPlacement, {
                            generation,
                            machineId: 'machine-a',
                            materializationId: 'install-a',
                        }),
                    ),
                    generation,
                };
                return (
                    <AppTargetNavigationScope projection={projection}>
                        <AppScopeRightSidebar
                            scopeId={APP_PANE_SCOPE_ID}
                            pluginUiProjection={projection}
                            platform="web"
                            testID="app-scope-right-sidebar-launch"
                        />
                    </AppTargetNavigationScope>
                );
            };
            const screen = await renderScreen(sidebarAtGeneration(4));
            await act(async () => {
                screen.pressByTestId('app-scope-right-sidebar-tab:plugin:acme.preview:app-panel');
            });
            const caller = await createMountedHostApiClient('app-panel');
            await act(async () => {
                await caller.api.openSurface({ pluginId: 'acme.preview', localId: 'detail-panel' }, { itemId: 'item-7' });
            });
            expect(latestMountFor('detail-panel')?.launchInput).toEqual({ itemId: 'item-7' });

            await screen.update(sidebarAtGeneration(5));

            // Projection generation is freshness, not a new Account, occurrence, or materialization.
            expect(latestMountFor('detail-panel')).toBeTruthy();
            expect(latestMountFor('detail-panel')?.launchInput).toEqual({ itemId: 'item-7' });
        });

        it('does not deliver a same-machine input after the selected materialization changes', async () => {
            const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');
            const sidebarAtMaterialization = (materializationId: string) => {
                const projection = projectionWith(
                    withSelectedContributionOrigin(appSidebarPlacement, {
                        generation: 4,
                        machineId: 'machine-a',
                        materializationId,
                    }),
                    withSelectedContributionOrigin(appDetailPlacement, {
                        generation: 4,
                        machineId: 'machine-a',
                        materializationId,
                    }),
                );
                return (
                    <AppTargetNavigationScope projection={projection}>
                        <AppScopeRightSidebar
                            scopeId={APP_PANE_SCOPE_ID}
                            pluginUiProjection={projection}
                            platform="web"
                        />
                    </AppTargetNavigationScope>
                );
            };
            const screen = await renderScreen(sidebarAtMaterialization('install-a'));
            await act(async () => {
                screen.pressByTestId('app-scope-right-sidebar-tab:plugin:acme.preview:app-panel');
            });
            const caller = await createMountedHostApiClient('app-panel');

            await act(async () => {
                await caller.api.openSurface({ pluginId: 'acme.preview', localId: 'detail-panel' }, { itemId: 'install-a' });
            });
            expect(latestMountFor('detail-panel')?.launchInput).toEqual({ itemId: 'install-a' });

            await screen.update(sidebarAtMaterialization('install-b'));

            // Generation and machine identity deliberately remain stable. The
            // target's selected materialization is a distinct producer, so it
            // cannot receive bounded input from the selected predecessor.
            expect(latestMountFor('detail-panel')?.launchInput).toBeUndefined();
        });

        it('retires tab launch input synchronously when the Account changes at the same server and machine', async () => {
            const accountA = captureActiveServerAccountScopeLifetime();
            expect(accountA?.isCurrent()).toBe(true);
            await renderTwoTabSidebar();
            const caller = await createMountedHostApiClient('app-panel');

            await act(async () => {
                await caller.api.openSurface({ pluginId: 'acme.preview', localId: 'detail-panel' }, { itemId: 'account-a' });
            });
            expect(latestMountFor('detail-panel')?.launchInput).toEqual({ itemId: 'account-a' });

            const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
            await act(async () => {
                await restoreConnectionToActiveServer({ token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-b' })).toString('base64url')}.signature` });
                // Transport restoration hydrates caches, not the authenticated profile scope.
                // Drive the canonical Account producer before checking lifetime retirement.
                storage.getState().activateProfileScope({ serverId: runtime.serverId, accountId: 'account-b' });
                accountLifetimeState.lifetime = captureActiveServerAccountScopeLifetime();
            });
            expect(accountA?.isCurrent()).toBe(false);
            expect(accountLifetimeState.lifetime?.scope.accountId).toBe('account-b');

            expect(latestMountFor('detail-panel')?.launchInput).toBeUndefined();
        });

        it('rejects an unresolvable destination with a typed error and keeps the current selection', async () => {
            await renderTwoTabSidebar();
            const caller = await createMountedHostApiClient('app-panel');

            await act(async () => {
                await expect(
                    caller.api.openSurface({ pluginId: 'acme.preview', localId: 'missing-panel' }),
                ).rejects.toMatchObject({
                    code: 'unavailable',
                    diagnostics: [{ code: 'plugin_surface_open_destination_unknown', severity: 'error' }],
                });
            });

            expect(latestMountFor('detail-panel')).toBeNull();
            expect(latestMountFor('app-panel')).toBeTruthy();
        });
    });

    // The whole point of an app-target container: the sidebar route is NOT
    // mounted yet. While the opener lived on the sidebar leaf, this exact first
    // open answered `plugin_surface_open_destination_owner_unavailable` because
    // the route that would have installed the resolver had never been entered.
    describe('app-lifetime rightSidebarTab navigation owner', () => {
        function coldProjection(): PluginUiProjectionModel {
            return projectionWith(
                withSelectedContributionOrigin(appSidebarPlacement, {
                    generation: 1,
                    machineId: 'machine-a',
                    materializationId: 'install-a',
                }),
                withSelectedContributionOrigin(appDetailPlacement, {
                    generation: 1,
                    machineId: 'machine-a',
                    materializationId: 'install-a',
                }),
            );
        }

        it('opens an app right-sidebar destination before that route has ever mounted, then stays idempotent', async () => {
            const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');
            const { router } = await import('expo-router');
            const projection = coldProjection();
            let binding: PluginSurfaceDestinationNavigationBinding | null = null;

            // Cold app: the shell boundary is up, no sidebar route is mounted.
            const screen = await renderScreen(
                <AppTargetNavigationScope
                    projection={projection}
                    onBinding={(next) => { binding = next; }}
                />,
            );
            expect(binding).not.toBeNull();
            expect(latestMountFor('detail-panel')).toBeNull();

            await act(async () => {
                await expect(binding!.openSurface({
                    destination: { pluginId: 'acme.preview', localId: 'detail-panel' },
                    input: { itemId: 'cold-open' },
                })).resolves.toEqual({ ok: true });
            });

            expect(router.push).toHaveBeenCalledWith('/plugins/panels?pluginId=acme.preview&destinationId=detail-panel');
            expect(runtime.pane.scopeState?.right).toMatchObject({
                selectedDestination: {
                    kind: 'plugin',
                    destination: { pluginId: 'acme.preview', localId: 'detail-panel' },
                },
            });

            // The route now mounts and renders the destination the open selected,
            // together with the launch input that rode across the navigation.
            routerState.pathname = '/plugins/panels';
            await act(async () => {
                await screen.update(
                    <AppTargetNavigationScope
                        projection={projection}
                        onBinding={(next) => { binding = next; }}
                    >
                        <AppScopeRightSidebar
                            scopeId={APP_PANE_SCOPE_ID}
                            pluginUiProjection={projection}
                            platform="web"
                            testID="app-scope-right-sidebar-cold"
                        />
                    </AppTargetNavigationScope>,
                );
            });

            expect(latestMountFor('detail-panel')).toBeTruthy();
            expect(latestMountFor('detail-panel')?.launchInput).toEqual({ itemId: 'cold-open' });

            // A second open of the same destination remains a single owner and a
            // single truthful success; it must not double-register or re-navigate.
            const pushCallsBeforeReopen = (router.push as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
            await act(async () => {
                await expect(binding!.openSurface({
                    destination: { pluginId: 'acme.preview', localId: 'detail-panel' },
                    input: { itemId: 'reopened' },
                })).resolves.toEqual({ ok: true });
            });

            expect(latestMountFor('detail-panel')?.launchInput).toEqual({ itemId: 'reopened' });
            expect((router.push as unknown as { mock: { calls: unknown[] } }).mock.calls.length)
                .toBe(pushCallsBeforeReopen);
        });
    });
});
