import * as React from 'react';
import { act } from 'react-test-renderer';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, createSessionFixture, renderScreen as renderPanelScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import type { SelectedPaneDestinationV1 } from './model/selectedPaneDestination';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const deviceTypeState = vi.hoisted(() => ({ value: 'tablet' as 'phone' | 'tablet' }));
installSessionDetailsPanelNonRnModuleMocks();
// Register the SDK geometry before the pane/device consumers are collected.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const dimensions = () => ({ width: deviceTypeState.value === 'phone' ? 390 : 1200, height: 800, scale: 1, fontScale: 1 });
    return createReactNativeWebMock({ useWindowDimensions: dimensions, Dimensions: { get: dimensions } });
});
const runtime = installSessionPaneRuntimeTestHarness({ sessionId: 'session-1', scopeId: 'scope1' });
let currentScreen: Awaited<ReturnType<typeof renderPanelScreen>>;
let ActualSurfaceHost: typeof import('@/components/plugins/surfaces')['PluginSurfacePlacementHost'];
let MultiPaneHostWithBottom: typeof import('@/components/ui/panels/MultiPaneHostWithBottom')['MultiPaneHostWithBottom'];
let paneSeed: Readonly<{ right?: SelectedPaneDestinationV1; bottom?: SelectedPaneDestinationV1 }> = {};
beforeEach(async () => {
    deviceTypeState.value = 'tablet';
    paneSeed = {};
    ({ PluginSurfacePlacementHost: ActualSurfaceHost } = await import('@/components/plugins/surfaces'));
    ({ MultiPaneHostWithBottom } = await import('@/components/ui/panels/MultiPaneHostWithBottom'));
    const session = createSessionFixture({ id: 'session-1', serverId: runtime.serverId });
    const machine = createMachineFixture({ id: 'machine-1' });
    storage.getState().applyMachines([machine]);
    storage.setState({ machineListByServerId: { ...storage.getState().machineListByServerId, [runtime.serverId]: [machine] } });
    storage.getState().applySessions([{ ...session, metadata: session.metadata
        ? { ...session.metadata, machineId: 'machine-1' } : null }]);
    storage.setState({ localSettings: { ...storage.getState().localSettings, uiMultiPanePanelsEnabled: true } });
});
function readLastPaneProp(key: 'rightPane' | 'detailsPane' | 'bottomPane') {
    // The real renderer keeps layout and modal/resize owners mounted beneath this public input.
    const props: React.ComponentProps<typeof MultiPaneHostWithBottom> = currentScreen.findByType<typeof MultiPaneHostWithBottom>(MultiPaneHostWithBottom).props;
    return props[key];
}
function surfaceHostProps(container: 'rightPane' | 'bottomPane') {
    const node = currentScreen.root.findAllByType<typeof ActualSurfaceHost>(ActualSurfaceHost)
        .find(host => host.props.placement.binding.kind === 'destination'
            && host.props.placement.binding.container === container);
    if (!node) throw new Error(`No admitted ${container} surface`);
    const props: React.ComponentProps<typeof ActualSurfaceHost> = node.props;
    return props;
}
function setPaneState(input: Readonly<{ right?: SelectedPaneDestinationV1; bottom?: SelectedPaneDestinationV1 }> = {}) {
    paneSeed = input;
}
async function renderScreen(element: React.ReactElement) {
    currentScreen = await renderPanelScreen(<React.Fragment />, { wrapper: runtime.Wrapper });
    await act(async () => {
        runtime.pane.openRight();
        runtime.pane.openBottom();
        if (paneSeed.right) runtime.pane.selectRightDestination(paneSeed.right);
        if (paneSeed.bottom) runtime.pane.selectBottomDestination(paneSeed.bottom);
    });
    await currentScreen.update(element);
    return currentScreen;
}

function createPlacement(input: Readonly<{
    descriptorId: string;
    container: 'rightPane' | 'bottomPane' | 'detailsPane' | 'rightSidebarTab';
    targetKind?: 'session' | 'project';
    instancePolicy?: 'singleton' | 'multiple';
}>): PluginUiSurfacePlacementProjection {
    const target = input.targetKind === 'project'
        ? { kind: 'project' as const }
        : { kind: 'session' as const };
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: 'acme.preview',
        destinationId: input.descriptorId,
        rendererId: `${input.descriptorId}-renderer`,
        container: input.container,
        target,
        ...(input.instancePolicy === undefined ? {} : { instancePolicy: input.instancePolicy }),
    });
    if (!binding) {
        throw new Error('test fixture must use an admitted V2 binding');
    }
    return {
        id: `surfacePlacement:acme.preview:${input.descriptorId}`,
        pluginId: 'acme.preview',
        occurrenceId: 'acme-preview-occurrence',
        contributionKind: 'surfacePlacement',
        descriptorId: input.descriptorId,
        binding,
        target,
        renderer: { kind: 'hostedWeb', contributionId: `${input.descriptorId}-renderer` },
        display: { developerFallback: input.descriptorId },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
        hostOrigin: {
            machineId: 'machine-1',
            serverId: runtime.serverId,
            generation: 1,
            phase: 'current',
            interactionEnabled: true,
            executionOrigin: PluginMachineExecutionOriginV1Schema.parse({
                // Advertised Home identity is separate from the local profile id.
                serverIdentityId: runtime.serverIdentityId,
                materializationRef: {
                    pluginId: 'acme.preview',
                    machineId: 'machine-1',
                    materializationId: `${input.descriptorId}-install-a`,
                },
            }),
        },
    };
}

function projectionWith(...placements: readonly PluginUiSurfacePlacementProjection[]): PluginUiProjectionModel {
    return {
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: 1,
        surfacePlacementsById: Object.fromEntries(placements.map((placement) => [placement.id, placement])),
    };
}

describe('AppPaneScopeHost plugin destinations', () => {
    it('hands a destination outside a nested Session pane scope to the enclosing semantic owner', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const {
            PluginSurfaceDestinationNavigationBindingProvider,
        } = await import('@/components/plugins/surfaces/pluginSurfaceDestinationNavigation');
        const enclosingOpenSurface = vi.fn(async () => ({ ok: true as const }));
        const enclosingBinding = {
            targetKind: 'app' as const,
            openSurface: enclosingOpenSurface,
            registerOwner: () => () => undefined,
        };
        let nestedOpenSurface: ((request: Readonly<{
            destination: { pluginId: string; localId: string };
        }>) => Promise<unknown>) | undefined;

        await renderScreen(
            <PluginSurfaceDestinationNavigationBindingProvider binding={enclosingBinding}>
                <AppPaneScopeHost
                    scopeId="scope1"
                    main={<div />}
                    surfaceScope={{
                        targetKind: 'session',
                        sessionId: 'session-1',
                        pluginUiProjection: projectionWith(),
                        projectionPhase: 'current',
                        machineId: 'machine-1',
                        serverId: runtime.serverId,
                        platform: 'web',
                        interactionEnabled: true,
                    }}
                    onPluginSurfaceOpenChange={(handler) => {
                        nestedOpenSurface = handler
                            ? async (request) => await handler(request)
                            : undefined;
                    }}
                />
            </PluginSurfaceDestinationNavigationBindingProvider>,
        );

        expect(nestedOpenSurface).toBeTypeOf('function');
        const request = { destination: { pluginId: 'acme.app', localId: 'overview' } };
        await expect(nestedOpenSurface!(request)).resolves.toEqual({ ok: true });
        expect(enclosingOpenSurface).toHaveBeenCalledExactlyOnceWith(request);
    });

    it('rejects a phone-sized web pane destination while retaining tablet-web admission', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const { PluginReactNativeUnavailable } = await import('@/components/plugins/reactNative/PluginReactNativeUnavailable');
        const rightPlacement = createPlacement({ descriptorId: 'phone-web-right', container: 'rightPane' });
        const projection = projectionWith(rightPlacement);

        setPaneState({
            right: {
                kind: 'plugin',
                destination: rightPlacement.binding.destination,
            },
        });
        deviceTypeState.value = 'phone';

        const phoneScreen = await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                surfaceScope={{
                    targetKind: 'session',
                    sessionId: 'session-1',
                    pluginUiProjection: projection,
                    projectionPhase: 'current',
                    machineId: 'machine-1',
                    serverId: runtime.serverId,
                    platform: 'web',
                    interactionEnabled: true,
                }}
            />,
        );

        expect(phoneScreen.findAllByType(PluginReactNativeUnavailable)).toHaveLength(1);
        expect(phoneScreen.findByType<typeof PluginReactNativeUnavailable>(PluginReactNativeUnavailable).props.diagnostics)
            .toEqual(['pane_destination_platform_unavailable']);
        expect(phoneScreen.root.findAllByType(ActualSurfaceHost)).toHaveLength(0);

        deviceTypeState.value = 'tablet';
        const tabletScreen = await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                surfaceScope={{
                    targetKind: 'session',
                    sessionId: 'session-1',
                    pluginUiProjection: projection,
                    projectionPhase: 'current',
                    machineId: 'machine-1',
                    serverId: runtime.serverId,
                    platform: 'web',
                    interactionEnabled: true,
                }}
            />,
        );

        expect(tabletScreen.root.findByType(ActualSurfaceHost).props).toEqual(expect.objectContaining({
            placement: rightPlacement,
            formFactor: 'tablet',
        }));
    });

    it('stages a Session details-pane open through the existing Details workspace owner', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const rightPlacement = createPlacement({ descriptorId: 'side', container: 'rightPane' });
        const detailsPlacement = createPlacement({ descriptorId: 'details', container: 'detailsPane' });
        const projection = projectionWith(rightPlacement, detailsPlacement);
        setPaneState({
            right: {
                kind: 'plugin',
                destination: rightPlacement.binding.destination,
            },
        });

        await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                surfaceScope={{
                    targetKind: 'session',
                    sessionId: 'session-1',
                    pluginUiProjection: projection,
                    projectionPhase: 'current',
                    machineId: 'machine-1',
                    serverId: runtime.serverId,
                    platform: 'web',
                    interactionEnabled: true,
                }}
                detailsPaneBuiltinAdapter={{
                    destinationIds: ['details'],
                    defaultDestinationId: 'details',
                    render: () => <div />,
                }}
            />,
        );

        const openSurface = surfaceHostProps('rightPane').binding?.openSurface;
        expect(openSurface).toBeTypeOf('function');
        if (!openSurface) throw new Error('AppPane did not supply its destination handler');

        await act(async () => {
            await expect(openSurface({
                destination: detailsPlacement.binding.destination,
                input: { activity: 'run-1' },
            })).resolves.toEqual({ ok: true });
        });

        expect(runtime.pane.scopeState?.details.overlay).toMatchObject({ destination: detailsPlacement.binding.destination });
    });

    it('stages a Project full-bleed details destination without enabling a docked details pane', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const rightPlacement = createPlacement({
            descriptorId: 'project-side',
            container: 'rightPane',
            targetKind: 'project',
        });
        const detailsPlacement = createPlacement({
            descriptorId: 'project-details',
            container: 'detailsPane',
            targetKind: 'project',
        });
        const projection = projectionWith(rightPlacement, detailsPlacement);
        setPaneState({
            right: {
                kind: 'plugin',
                destination: rightPlacement.binding.destination,
            },
        });

        await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                // Project's existing WorkspaceDetailsPanel owns the full-bleed
                // overlay in its main region; this must not create docked
                // details chrome simply to deliver the exact open request.
                detailsPaneEnabled={false}
                surfaceScope={{
                    targetKind: 'project',
                    projectId: 'project-1',
                    pluginUiProjection: projection,
                    projectionPhase: 'current',
                    machineId: 'machine-1',
                    serverId: runtime.serverId,
                    platform: 'web',
                    interactionEnabled: true,
                }}
            />,
        );

        const openSurface = surfaceHostProps('rightPane').binding?.openSurface;
        expect(openSurface).toBeTypeOf('function');
        if (!openSurface) throw new Error('AppPane did not supply its destination handler');

        await act(async () => {
            await expect(openSurface({
                destination: detailsPlacement.binding.destination,
                input: { activity: 'project-run-1' },
            })).resolves.toEqual({ ok: true });
        });

        expect(runtime.pane.scopeState?.details.overlay).toMatchObject({ destination: detailsPlacement.binding.destination });
    });

    it('hands an admitted right-pane open to the AppPane bottom selection owner without persisting input', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const rightPlacement = createPlacement({ descriptorId: 'side', container: 'rightPane' });
        const bottomPlacement = createPlacement({ descriptorId: 'bottom', container: 'bottomPane' });
        const projection = projectionWith(rightPlacement, bottomPlacement);
        setPaneState({
            right: {
                kind: 'plugin',
                destination: rightPlacement.binding.destination,
            },
        });

        await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                surfaceScope={{
                    targetKind: 'session',
                    sessionId: 'session-1',
                    pluginUiProjection: projection,
                    projectionPhase: 'current',
                    machineId: 'machine-1',
                    serverId: runtime.serverId,
                    platform: 'web',
                    interactionEnabled: true,
                }}
            />,
        );

        const openSurface = surfaceHostProps('rightPane').binding?.openSurface;
        expect(openSurface).toBeTypeOf('function');
        if (!openSurface) throw new Error('AppPane did not supply its destination handler');

        await act(async () => {
            await expect(openSurface({
                destination: bottomPlacement.binding.destination,
                input: { activity: 'run-1' },
            })).resolves.toEqual({ ok: true });
        });

        expect(runtime.pane.scopeState?.bottom.selectedDestination).toEqual({
            kind: 'plugin', destination: bottomPlacement.binding.destination,
        });
        expect(JSON.stringify(storage.getState().localSettings.appPaneScopesV1)).not.toContain('run-1');
    });

    it('uses a typed default when no pane is selected and otherwise renders no pane', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        setPaneState();

        await renderScreen(<AppPaneScopeHost scopeId="scope1" main={<div />} />);

        expect(readLastPaneProp('rightPane')).toBeNull();
        expect(readLastPaneProp('bottomPane')).toBeNull();

        const DefaultPane = () => React.createElement('DefaultPane');
        const defaultScreen = await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                rightPaneBuiltinAdapter={{
                    destinationIds: ['default'],
                    defaultDestinationId: 'default',
                    render: () => <DefaultPane />,
                }}
            />,
        );

        expect(defaultScreen.findAllByType(DefaultPane)).toHaveLength(1);
        expect(defaultScreen.findAllByType(ActualSurfaceHost)).toHaveLength(0);
    });

    it('keeps a selected plugin destination unresolved when no scope adapter stamps its target', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const { PaneLoadingFallback } = await import('@/components/ui/panels/PaneLoadingFallback');
        const placement = createPlacement({ descriptorId: 'side', container: 'rightPane' });
        setPaneState({
            right: {
                kind: 'plugin',
                destination: placement.binding.destination,
            },
        });

        const screen = await renderScreen(<AppPaneScopeHost scopeId="scope1" main={<div />} />);

        expect(screen.findAllByType(PaneLoadingFallback)).toHaveLength(1);
        expect(screen.findAllByType(ActualSurfaceHost)).toHaveLength(0);
    });

    it('mounts the exact selected plugin bindings ahead of typed built-in adapters', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const rightPlacement = createPlacement({ descriptorId: 'side', container: 'rightPane', instancePolicy: 'multiple' });
        const bottomPlacement = createPlacement({ descriptorId: 'bottom', container: 'bottomPane', instancePolicy: 'multiple' });
        const projection = projectionWith(rightPlacement, bottomPlacement);
        setPaneState({
            right: {
                kind: 'plugin',
                destination: rightPlacement.binding.destination,
                instanceKey: 'instance-right',
            },
            bottom: {
                kind: 'plugin',
                destination: bottomPlacement.binding.destination,
                instanceKey: 'instance-bottom',
            },
        });

        const screen = await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                surfaceScope={{
                    targetKind: 'session',
                    sessionId: 'session-1',
                    pluginUiProjection: projection,
                    projectionPhase: 'current',
                    machineId: 'machine-1',
                    serverId: runtime.serverId,
                    platform: 'web',
                    interactionEnabled: true,
                }}
                rightPaneBuiltinAdapter={{
                    destinationIds: ['incumbent-right'],
                    defaultDestinationId: 'incumbent-right',
                    render: () => <div data-testid="incumbent-right" />,
                }}
                bottomPaneBuiltinAdapter={{
                    destinationIds: ['incumbent-bottom'],
                    defaultDestinationId: 'incumbent-bottom',
                    render: () => <div data-testid="incumbent-bottom" />,
                }}
            />,
        );

        const hosts = screen.root.findAllByType(ActualSurfaceHost);
        expect(hosts.find((host) => host.props.placement === rightPlacement)?.props).toEqual(expect.objectContaining({
            placement: rightPlacement,
            mountInstanceKey: 'instance-right',
        }));
        expect(hosts.find((host) => host.props.placement === bottomPlacement)?.props).toEqual(expect.objectContaining({
            placement: bottomPlacement,
            mountInstanceKey: 'instance-bottom',
        }));
    });

    it('uses the registered Session scope target and projection instead of treating every pane as app-scoped', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const sessionPlacement = createPlacement({
            descriptorId: 'session-side',
            container: 'rightPane',
            targetKind: 'session',
        });
        const sessionProjection = projectionWith(sessionPlacement);
        const scopedSession = createSessionFixture({ id: 'session-42', serverId: runtime.serverId });
        storage.getState().applySessions([scopedSession]);
        setPaneState({
            right: {
                kind: 'plugin',
                destination: sessionPlacement.binding.destination,
            },
        });

        const screen = await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                surfaceScope={{
                    targetKind: 'session',
                    sessionId: 'session-42',
                    pluginUiProjection: sessionProjection,
                    projectionPhase: 'current',
                    machineId: 'machine-1',
                    serverId: runtime.serverId,
                    platform: 'web',
                    interactionEnabled: true,
                }}
            />,
        );

        expect(screen.root.findByType(ActualSurfaceHost).props).toEqual(expect.objectContaining({
            placement: sessionPlacement,
            pluginUiProjection: sessionProjection,
            sessionId: 'session-42',
            machineId: 'machine-1',
            serverId: runtime.serverId,
        }));
    });

    it('keeps a retained pane projection visible but noninteractive even when a stale boolean remains true', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const rightPlacement = createPlacement({ descriptorId: 'retained-side', container: 'rightPane' });
        const projection = projectionWith(rightPlacement);
        setPaneState({
            right: { kind: 'plugin', destination: rightPlacement.binding.destination },
        });

        const screen = await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                surfaceScope={{
                    targetKind: 'session',
                    sessionId: 'session-1',
                    pluginUiProjection: projection,
                    projectionPhase: 'retainedOffline',
                    machineId: 'machine-1',
                    serverId: runtime.serverId,
                    platform: 'web',
                    interactionEnabled: true,
                }}
            />,
        );

        expect(screen.root.findByType(ActualSurfaceHost).props
            .projectionInteractionEnabled).toBe(false);
    });

    it('keeps an unavailable selected plugin destination as a tombstone instead of falling back', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const { PluginReactNativeUnavailable } = await import('@/components/plugins/reactNative/PluginReactNativeUnavailable');
        const projection = projectionWith();
        setPaneState({
            right: {
                kind: 'plugin',
                destination: { pluginId: 'acme.preview', localId: 'gone' },
            },
        });
        const incumbentRightPane = <div data-testid="incumbent-right" />;

        const screen = await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                surfaceScope={{
                    targetKind: 'session',
                    sessionId: 'session-1',
                    pluginUiProjection: projection,
                    projectionPhase: 'current',
                    machineId: 'machine-1',
                    serverId: runtime.serverId,
                    platform: 'web',
                    interactionEnabled: true,
                }}
                rightPaneBuiltinAdapter={{
                    destinationIds: ['incumbent-right'],
                    defaultDestinationId: 'incumbent-right',
                    render: () => incumbentRightPane,
                }}
            />,
        );

        expect(screen.findAllByType(PluginReactNativeUnavailable)).toHaveLength(1);
        expect(screen.findByType<typeof PluginReactNativeUnavailable>(PluginReactNativeUnavailable).props.diagnostics)
            .toEqual(['pane_destination_unavailable']);
        expect(screen.findByTestId('incumbent-right')).toBeNull();
        expect(screen.findAllByType(ActualSurfaceHost)).toHaveLength(0);
    });

    it('preserves an unavailable right-sidebar destination reason instead of treating it as a right-pane mismatch', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const { PluginReactNativeUnavailable } = await import('@/components/plugins/reactNative/PluginReactNativeUnavailable');
        const sidebarPlacement = {
            ...createPlacement({ descriptorId: 'sidebar-disabled', container: 'rightSidebarTab' }),
            availability: { state: 'fallback' as const, reason: 'feature_disabled', diagnostics: ['feature_disabled'] },
        } satisfies PluginUiSurfacePlacementProjection;
        const projection = projectionWith(sidebarPlacement);
        setPaneState({
            right: {
                kind: 'plugin',
                destination: sidebarPlacement.binding.destination,
            },
        });

        const screen = await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                surfaceScope={{
                    targetKind: 'session',
                    sessionId: 'session-1',
                    pluginUiProjection: projection,
                    projectionPhase: 'current',
                    machineId: 'machine-1',
                    serverId: runtime.serverId,
                    platform: 'web',
                    interactionEnabled: true,
                }}
                rightPaneBuiltinAdapter={{
                    destinationIds: ['incumbent-right'],
                    defaultDestinationId: 'incumbent-right',
                    render: () => <div data-testid="incumbent-right" />,
                }}
            />,
        );

        expect(screen.findAllByType(PluginReactNativeUnavailable)).toHaveLength(1);
        expect(screen.findByType<typeof PluginReactNativeUnavailable>(PluginReactNativeUnavailable).props.diagnostics)
            .toEqual(['feature_disabled']);
        expect(screen.findByTestId('incumbent-right')).toBeNull();
        expect(screen.findAllByType(ActualSurfaceHost)).toHaveLength(0);
    });

    it('renders only the exact selected built-in adapter', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const BuiltinPane = (props: Readonly<{ destinationId: string | null }>) => (
            React.createElement('BuiltinPane', props)
        );
        setPaneState({ right: { kind: 'builtin', id: 'git' } });

        const screen = await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                rightPaneBuiltinAdapter={{
                    destinationIds: ['git', 'files'],
                    render: ({ destinationId }) => <BuiltinPane destinationId={destinationId} />,
                }}
            />,
        );

        expect(screen.findAllByType(BuiltinPane)).toHaveLength(1);
        expect(screen.findByType<typeof BuiltinPane>(BuiltinPane).props).toEqual({ destinationId: 'git' });
        expect(screen.findAllByType(ActualSurfaceHost)).toHaveLength(0);
    });

    it('does not render a pane when no adapter owns the selected built-in id', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        setPaneState({ right: { kind: 'builtin', id: 'unknown-pane' } });

        await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                rightPaneBuiltinAdapter={{
                    destinationIds: ['git'],
                    render: () => <div data-testid="git-pane" />,
                }}
            />,
        );

        expect(readLastPaneProp('rightPane')).toBeNull();
    });
});
