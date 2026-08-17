import * as React from 'react';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    PluginSurfaceDestinationNavigationBindingProvider,
    usePluginSurfaceDestinationNavigationBindingForScope,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const endpointConnectivityState = vi.hoisted(() => ({
    status: 'online' as 'online' | 'offline',
}));
const paneScopeSeed = vi.hoisted(() => ({
    activeTabId: null as string | null,
    selectedDestination: null as unknown,
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

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

const mountedSurfaceProps = vi.hoisted(() => [] as any[]);

vi.mock('@/components/plugins/surfaces', () => ({
    PluginSurfacePlacementHost: (props: any) => {
        mountedSurfaceProps.push(props);
        return React.createElement(
            'View',
            {
                testID: `plugin-host-renderer-${props.placement?.renderer?.rendererId ?? props.placement?.descriptorId ?? 'unknown'}`,
            },
        );
    },
}));

/** The last props the mount received for a given placement descriptor. */
function latestMountFor(descriptorId: string): any {
    for (let index = mountedSurfaceProps.length - 1; index >= 0; index -= 1) {
        if (mountedSurfaceProps[index]?.placement?.descriptorId === descriptorId) {
            return mountedSurfaceProps[index];
        }
    }
    return null;
}

vi.mock('@/sync/domains/state/storage', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/state/storage')>(),
    useEndpointStatus: () => endpointConnectivityState.status,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => ({
        pluginUiProjection: null,
        interactionEnabled: true,
        machineId: null,
        serverId: null,
        platform: 'web',
    }),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => {
        const [right, setRight] = React.useState(() => ({
            isOpen: true,
            activeTabId: paneScopeSeed.activeTabId,
            selectedDestination: paneScopeSeed.selectedDestination,
            tabState: {},
        }));
        return {
            scopeState: {
                right,
                details: { isOpen: false, tabState: {}, tabs: [], activeTabKey: null },
                bottom: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
            },
            openRight: ({ tabId }: Readonly<{ tabId?: string }> = {}) => {
                setRight((previous) => ({
                    ...previous,
                    isOpen: true,
                    activeTabId: tabId ?? previous.activeTabId,
                    selectedDestination: tabId ? { kind: 'builtin', id: tabId } : previous.selectedDestination,
                }));
            },
            selectRightDestination: (destination: unknown) => {
                setRight((previous) => ({ ...previous, isOpen: true, selectedDestination: destination }));
            },
        };
    },
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => accountLifetimeState.lifetime,
}));

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
    return {
        serverIdentityId: 'srv_account_one',
        materializationRef: {
            pluginId: 'acme.preview',
            machineId: input.machineId,
            materializationId: input.materializationId,
        },
    };
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
            serverId: 'server-1',
            machineId: input.machineId,
            generation: input.generation,
            phase: 'current',
            interactionEnabled: true,
            executionOrigin: executionOrigin(input),
        }),
    });
}

function createTestAccountLifetime(accountId: string): Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    retire: () => void;
}> {
    let current = true;
    const retireListeners = new Set<() => void>();
    const lifetime: ActiveServerAccountScopeLifetime = {
        scope: { serverId: 'server-1', accountId },
        isCurrent: () => current,
        onRetire: (listener) => {
            if (!current) {
                listener();
                return Object.freeze({ dispose() {} });
            }
            retireListeners.add(listener);
            return Object.freeze({ dispose: () => retireListeners.delete(listener) });
        },
    };
    return Object.freeze({
        lifetime,
        retire: () => {
            if (!current) return;
            current = false;
            for (const listener of [...retireListeners]) listener();
            retireListeners.clear();
        },
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

/** Mirrors the shell's single app-target navigation-binding boundary. */
function AppTargetNavigationScope(props: React.PropsWithChildren<Readonly<{
    projection: PluginUiProjectionModel;
}>>): React.ReactElement {
    const binding = usePluginSurfaceDestinationNavigationBindingForScope({
        placements: Object.values(props.projection.surfacePlacementsById),
        settingsPages: Object.values(props.projection.settingsPagesById),
        targetKind: 'app',
        accountLifetime: accountLifetimeState.lifetime,
    });
    return (
        <PluginSurfaceDestinationNavigationBindingProvider binding={binding}>
            {props.children}
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
    beforeEach(() => {
        endpointConnectivityState.status = 'online';
        mountedSurfaceProps.length = 0;
        paneScopeSeed.activeTabId = null;
        paneScopeSeed.selectedDestination = null;
        accountLifetimeState.lifetime = createTestAccountLifetime('account-a').lifetime;
    });

    it('mounts an available app-scope plugin tab surface through the canonical host', async () => {
        const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');

        const screen = await renderScreen(
            <AppScopeRightSidebar
                scopeId="scope1"
                pluginUiProjection={projectionWith(appSidebarPlacement)}
                platform="web"
                testID="app-scope-right-sidebar"
            />,
        );

        expect(screen.findByTestId('app-scope-right-sidebar-tab:plugin:acme.preview:app-panel')).toBeTruthy();
        expect(screen.findByTestId('plugin-host-renderer-descriptor-panel')).toBeTruthy();
    });

    it('does not construct a fallback app-target navigation binding outside the shell host', async () => {
        const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');

        const screen = await renderScreen(
            <AppScopeRightSidebar
                scopeId="scope1"
                pluginUiProjection={projectionWith(appSidebarPlacement)}
                platform="web"
            />,
        );

        expect(screen.findByTestId('plugin-host-renderer-descriptor-panel')).toBeTruthy();
        expect(latestMountFor('app-panel')?.binding?.openSurface).toBeUndefined();
    });

    it('selects the exact qualified destination requested by the compact App route', async () => {
        const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');

        const screen = await renderScreen(
            <AppScopeRightSidebar
                scopeId="scope1"
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

        expect(screen.findByTestId('plugin-host-renderer-detail-panel')).toBeTruthy();
        expect(screen.findByTestId('plugin-host-renderer-descriptor-panel')).toBeNull();
    });

    // §3.1: connectivity is no longer this sidebar's decision. The bound
    // controller keeps the already-admitted local destination selector alive
    // while daemon interaction is inactive; only daemon-backed methods retire.
    it('keeps the local destination selector available while the endpoint is offline', async () => {
        endpointConnectivityState.status = 'offline';
        const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');
        const projection = projectionWith(appSidebarPlacement);

        await renderScreen(
            <AppTargetNavigationScope projection={projection}>
                <AppScopeRightSidebar
                    scopeId="scope1"
                    pluginUiProjection={projection}
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
                scopeId="scope1"
                pluginUiProjection={projectionWith()}
                platform="web"
                testID="app-scope-right-sidebar-empty"
            />,
        );

        expect(screen.findByTestId('app-scope-right-sidebar-empty')).toBeTruthy();
        expect(screen.findByTestId('plugin-host-renderer-descriptor-panel')).toBeNull();
    });

    it('keeps a restored app plugin destination pending, then tombstones it when the settled catalog lacks it', async () => {
        paneScopeSeed.activeTabId = 'plugin:acme.preview:removed-panel';
        const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');

        const screen = await renderScreen(
            <AppScopeRightSidebar
                scopeId="scope1"
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
                scopeId="scope1"
                pluginUiProjection={projectionWith()}
                projectionPhase="current"
                platform="web"
                testID="app-scope-right-sidebar-empty"
            />,
        );

        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('pluginSurfaces.appScopeRightSidebar.empty');
        expect(screen.findByTestId('plugin-host-renderer-descriptor-panel')).toBeNull();
    });

    it('does not mount a fallback/unavailable plugin tab surface (fail-closed)', async () => {
        const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');

        const screen = await renderScreen(
            <AppScopeRightSidebar
                scopeId="scope1"
                pluginUiProjection={projectionWith({
                    ...appSidebarPlacement,
                    availability: { state: 'fallback', reason: 'feature_disabled', diagnostics: ['feature_disabled'] },
                })}
                platform="web"
                testID="app-scope-right-sidebar-deferred"
            />,
        );

        // The disabled-by-default tab is hidden, so the surface renders the empty state.
        expect(screen.findByTestId('plugin-host-renderer-descriptor-panel')).toBeNull();
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
            return renderScreen(
                <AppTargetNavigationScope projection={projection}>
                    <AppScopeRightSidebar
                        scopeId="scope1"
                        pluginUiProjection={projection}
                        platform="web"
                        testID="app-scope-right-sidebar-launch"
                    />
                </AppTargetNavigationScope>,
            );
        }

        it('delivers author-supplied launch input to the destination render context', async () => {
            const screen = await renderTwoTabSidebar();
            const caller = await createMountedHostApiClient('app-panel');

            expect(caller.api.version().methods).toContain('openSurface');

            await act(async () => {
                await caller.api.openSurface({ pluginId: 'acme.preview', localId: 'detail-panel' }, { itemId: 'item-7' });
            });

            expect(screen.findByTestId('plugin-host-renderer-detail-panel')).toBeTruthy();
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
            await renderScreen(
                <AppTargetNavigationScope projection={projection}>
                    <AppScopeRightSidebar
                        scopeId="scope1"
                        pluginUiProjection={projection}
                        platform="web"
                    />
                </AppTargetNavigationScope>,
            );
            const caller = await createMountedHostApiClient('app-panel');

            await act(async () => {
                await expect(
                    caller.api.openSurface({ pluginId: 'acme.preview', localId: 'detail-panel' }, { itemId: 'missing-origin' }),
                ).rejects.toMatchObject({
                    code: 'unavailable',
                    diagnostics: ['plugin_surface_open_origin_unavailable'],
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
                    diagnostics: ['plugin_surface_open_payload_invalid'],
                });
            });

            // Nothing is opened and nothing is truncated.
            expect(latestMountFor('detail-panel')).toBeNull();
        });

        it('does not deliver a previous generation launch input after generation replacement', async () => {
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
                            scopeId="scope1"
                            pluginUiProjection={projection}
                            platform="web"
                            testID="app-scope-right-sidebar-launch"
                        />
                    </AppTargetNavigationScope>
                );
            };
            const screen = await renderScreen(sidebarAtGeneration(4));
            const caller = await createMountedHostApiClient('app-panel');
            await act(async () => {
                await caller.api.openSurface({ pluginId: 'acme.preview', localId: 'detail-panel' }, { itemId: 'item-7' });
            });
            expect(latestMountFor('detail-panel')?.launchInput).toEqual({ itemId: 'item-7' });

            await screen.update(sidebarAtGeneration(5));

            // The tab id survives a generation replacement, but the argument
            // belongs to the generation that was opened with it: the replacement
            // mounts the same selected tab with no launch input.
            expect(latestMountFor('detail-panel')).toBeTruthy();
            expect(latestMountFor('detail-panel')?.launchInput).toBeUndefined();
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
                            scopeId="scope1"
                            pluginUiProjection={projection}
                            platform="web"
                        />
                    </AppTargetNavigationScope>
                );
            };
            const screen = await renderScreen(sidebarAtMaterialization('install-a'));
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
            const accountA = createTestAccountLifetime('account-a');
            const accountB = createTestAccountLifetime('account-b');
            accountLifetimeState.lifetime = accountA.lifetime;
            await renderTwoTabSidebar();
            const caller = await createMountedHostApiClient('app-panel');

            await act(async () => {
                await caller.api.openSurface({ pluginId: 'acme.preview', localId: 'detail-panel' }, { itemId: 'account-a' });
            });
            expect(latestMountFor('detail-panel')?.launchInput).toEqual({ itemId: 'account-a' });

            await act(async () => {
                accountLifetimeState.lifetime = accountB.lifetime;
                accountA.retire();
            });

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
                    diagnostics: ['plugin_surface_open_destination_unknown'],
                });
            });

            expect(latestMountFor('detail-panel')).toBeNull();
            expect(latestMountFor('app-panel')).toBeTruthy();
        });
    });
});
