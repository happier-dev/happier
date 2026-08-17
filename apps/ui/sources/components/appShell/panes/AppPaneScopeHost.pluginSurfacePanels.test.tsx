import * as React from 'react';
import { act } from 'react-test-renderer';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import { installAppPaneScopeHostCommonModuleMocks } from './appPaneScopeHostTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const paneHostState = vi.hoisted(() => ({
    scope: {
        right: { isOpen: true, activeTabId: null, selectedDestination: null as unknown, tabState: {} },
        details: { isOpen: false },
        bottom: { isOpen: true, activeTabId: null, selectedDestination: null as unknown, tabState: {} },
    },
    dispatch: vi.fn(),
}));
const pluginUnavailableSpy = vi.hoisted(() => vi.fn());
const deviceTypeState = vi.hoisted(() => ({
    value: 'tablet' as 'phone' | 'tablet',
}));

let lastProps: Readonly<Record<string, unknown>> | null = null;

function readLastPaneProp(key: 'rightPane' | 'detailsPane' | 'bottomPane'): unknown {
    return lastProps?.[key] ?? null;
}

installAppPaneScopeHostCommonModuleMocks({
    getLocalSetting: (key) => key === 'uiMultiPanePanelsEnabled' ? true : null,
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { text: { secondary: '#777' } } } }),
    StyleSheet: { create: () => ({}) },
}));

vi.mock('@/components/ui/panels/MultiPaneHostWithBottom', () => ({
    MultiPaneHostWithBottom: (props: Readonly<Record<string, unknown>>) => {
        lastProps = props;
        return React.createElement(
            'MultiPaneHostStub',
            props,
            props.rightPane as React.ReactNode,
            props.detailsPane as React.ReactNode,
            props.bottomPane as React.ReactNode,
        );
    },
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceTypeState.value,
}));

vi.mock('./AppPaneProvider', () => ({
    useAppPaneContext: () => ({
        dispatch: paneHostState.dispatch,
        state: { scopes: { scope1: paneHostState.scope } },
        getDriver: () => null,
        driverRegistryVersion: 1,
    }),
}));

vi.mock('@/components/plugins/surfaces', () => ({
    PluginSurfacePlacementHost: (props: Readonly<Record<string, unknown>>) => (
        React.createElement('PluginSurfacePlacementHostMock', props)
    ),
}));

vi.mock('@/components/plugins/reactNative/PluginReactNativeUnavailable', () => ({
    PluginReactNativeUnavailable: (props: Readonly<Record<string, unknown>>) => {
        pluginUnavailableSpy(props);
        return React.createElement('PluginReactNativeUnavailableMock', props);
    },
}));

beforeEach(() => {
    deviceTypeState.value = 'tablet';
});

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
            serverId: 'server-1',
            generation: 1,
            phase: 'current',
            interactionEnabled: true,
            executionOrigin: {
                serverIdentityId: 'srv_account_one',
                materializationRef: {
                    pluginId: 'acme.preview',
                    machineId: 'machine-1',
                    materializationId: `${input.descriptorId}-install-a`,
                },
            } satisfies PluginMachineExecutionOriginV1,
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

function setPaneState(input: Readonly<{
    right?: unknown;
    bottom?: unknown;
}> = {}): void {
    paneHostState.scope.right = {
        isOpen: true,
        activeTabId: null,
        selectedDestination: input.right ?? null,
        tabState: {},
    };
    paneHostState.scope.bottom = {
        isOpen: true,
        activeTabId: null,
        selectedDestination: input.bottom ?? null,
        tabState: {},
    };
}

describe('AppPaneScopeHost plugin destinations', () => {
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
        lastProps = null;
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
                    serverId: 'server-1',
                    platform: 'web',
                    interactionEnabled: true,
                }}
            />,
        );

        expect(readLastPaneProp('rightPane')).toEqual(expect.objectContaining({
            type: PluginReactNativeUnavailable,
            props: expect.objectContaining({ diagnostics: ['pane_destination_platform_unavailable'] }),
        }));
        expect(phoneScreen.root.findAllByType('PluginSurfacePlacementHostMock' as never)).toHaveLength(0);

        lastProps = null;
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
                    serverId: 'server-1',
                    platform: 'web',
                    interactionEnabled: true,
                }}
            />,
        );

        expect(tabletScreen.root.findByType('PluginSurfacePlacementHostMock' as never).props).toEqual(expect.objectContaining({
            placement: rightPlacement,
            formFactor: 'tablet',
        }));
    });

    it('stages a Session details-pane open through the existing Details workspace owner', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const rightPlacement = createPlacement({ descriptorId: 'side', container: 'rightPane' });
        const detailsPlacement = createPlacement({ descriptorId: 'details', container: 'detailsPane' });
        const projection = projectionWith(rightPlacement, detailsPlacement);
        lastProps = null;
        paneHostState.dispatch.mockClear();
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
                    serverId: 'server-1',
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

        const rightHost = readLastPaneProp('rightPane') as React.ReactElement<Readonly<{
            binding?: Readonly<{
                openSurface?: (request: Readonly<{
                    destination: { pluginId: string; localId: string };
                    input?: unknown;
                }>) => Promise<unknown> | unknown;
            }>;
        }>> | null;
        const openSurface = rightHost?.props.binding?.openSurface;
        expect(openSurface).toBeTypeOf('function');
        if (!openSurface) throw new Error('AppPane did not supply its destination handler');

        await act(async () => {
            await expect(openSurface({
                destination: detailsPlacement.binding.destination,
                input: { activity: 'run-1' },
            })).resolves.toEqual({ ok: true });
        });

        expect(paneHostState.dispatch).toHaveBeenCalledWith({
            type: 'openDetailsOverlay',
            scopeId: 'scope1',
            destination: detailsPlacement.binding.destination,
        });
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
        lastProps = null;
        paneHostState.dispatch.mockClear();
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
                    serverId: 'server-1',
                    platform: 'web',
                    interactionEnabled: true,
                }}
            />,
        );

        const rightHost = readLastPaneProp('rightPane') as React.ReactElement<Readonly<{
            binding?: Readonly<{
                openSurface?: (request: Readonly<{
                    destination: { pluginId: string; localId: string };
                    input?: unknown;
                }>) => Promise<unknown> | unknown;
            }>;
        }>> | null;
        const openSurface = rightHost?.props.binding?.openSurface;
        expect(openSurface).toBeTypeOf('function');
        if (!openSurface) throw new Error('AppPane did not supply its destination handler');

        await act(async () => {
            await expect(openSurface({
                destination: detailsPlacement.binding.destination,
                input: { activity: 'project-run-1' },
            })).resolves.toEqual({ ok: true });
        });

        expect(paneHostState.dispatch).toHaveBeenCalledWith({
            type: 'openDetailsOverlay',
            scopeId: 'scope1',
            destination: detailsPlacement.binding.destination,
        });
    });

    it('hands an admitted right-pane open to the AppPane bottom selection owner without persisting input', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const rightPlacement = createPlacement({ descriptorId: 'side', container: 'rightPane' });
        const bottomPlacement = createPlacement({ descriptorId: 'bottom', container: 'bottomPane' });
        const projection = projectionWith(rightPlacement, bottomPlacement);
        lastProps = null;
        paneHostState.dispatch.mockClear();
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
                    serverId: 'server-1',
                    platform: 'web',
                    interactionEnabled: true,
                }}
            />,
        );

        const rightHost = readLastPaneProp('rightPane') as React.ReactElement<Readonly<{
            binding?: Readonly<{
                openSurface?: (request: Readonly<{
                    destination: { pluginId: string; localId: string };
                    input?: unknown;
                }>) => Promise<unknown> | unknown;
            }>;
        }>> | null;
        const openSurface = rightHost?.props.binding?.openSurface;
        expect(openSurface).toBeTypeOf('function');
        if (!openSurface) throw new Error('AppPane did not supply its destination handler');

        await act(async () => {
            await expect(openSurface({
                destination: bottomPlacement.binding.destination,
                input: { activity: 'run-1' },
            })).resolves.toEqual({ ok: true });
        });

        expect(paneHostState.dispatch).toHaveBeenCalledWith({
            type: 'selectBottomDestination',
            scopeId: 'scope1',
            destination: {
                kind: 'plugin',
                destination: bottomPlacement.binding.destination,
            },
        });
    });

    it('uses a typed default when no pane is selected and otherwise renders no pane', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        lastProps = null;
        setPaneState();

        await renderScreen(<AppPaneScopeHost scopeId="scope1" main={<div />} />);

        expect(readLastPaneProp('rightPane')).toBeNull();
        expect(readLastPaneProp('bottomPane')).toBeNull();

        const DefaultPane = () => React.createElement('DefaultPane');
        await renderScreen(
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

        expect(readLastPaneProp('rightPane')).toEqual(expect.objectContaining({ type: DefaultPane }));
    });

    it('keeps a selected plugin destination unresolved when no scope adapter stamps its target', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const { PaneLoadingFallback } = await import('@/components/ui/panels/PaneLoadingFallback');
        const placement = createPlacement({ descriptorId: 'side', container: 'rightPane' });
        lastProps = null;
        setPaneState({
            right: {
                kind: 'plugin',
                destination: placement.binding.destination,
            },
        });

        await renderScreen(<AppPaneScopeHost scopeId="scope1" main={<div />} />);

        expect(readLastPaneProp('rightPane')).toEqual(expect.objectContaining({
            type: PaneLoadingFallback,
        }));
    });

    it('mounts the exact selected plugin bindings ahead of typed built-in adapters', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const rightPlacement = createPlacement({ descriptorId: 'side', container: 'rightPane', instancePolicy: 'multiple' });
        const bottomPlacement = createPlacement({ descriptorId: 'bottom', container: 'bottomPane', instancePolicy: 'multiple' });
        const projection = projectionWith(rightPlacement, bottomPlacement);
        lastProps = null;
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
                    serverId: 'server-1',
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

        const hosts = screen.root.findAllByType('PluginSurfacePlacementHostMock' as never);
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
        lastProps = null;
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
                    machineId: 'machine-session',
                    serverId: 'server-session',
                    platform: 'web',
                    interactionEnabled: true,
                }}
            />,
        );

        expect(screen.root.findByType('PluginSurfacePlacementHostMock' as never).props).toEqual(expect.objectContaining({
            placement: sessionPlacement,
            pluginUiProjection: sessionProjection,
            sessionId: 'session-42',
            machineId: 'machine-session',
            serverId: 'server-session',
        }));
    });

    it('keeps a retained pane projection visible but noninteractive even when a stale boolean remains true', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const rightPlacement = createPlacement({ descriptorId: 'retained-side', container: 'rightPane' });
        const projection = projectionWith(rightPlacement);
        lastProps = null;
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
                    serverId: 'server-1',
                    platform: 'web',
                    interactionEnabled: true,
                }}
            />,
        );

        expect(screen.root.findByType('PluginSurfacePlacementHostMock' as never).props
            .projectionInteractionEnabled).toBe(false);
    });

    it('keeps an unavailable selected plugin destination as a tombstone instead of falling back', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const { PluginReactNativeUnavailable } = await import('@/components/plugins/reactNative/PluginReactNativeUnavailable');
        lastProps = null;
        pluginUnavailableSpy.mockClear();
        const projection = projectionWith();
        setPaneState({
            right: {
                kind: 'plugin',
                destination: { pluginId: 'acme.preview', localId: 'gone' },
            },
        });
        const incumbentRightPane = <div data-testid="incumbent-right" />;

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
                    serverId: 'server-1',
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

        expect(readLastPaneProp('rightPane')).toEqual(expect.objectContaining({
            type: PluginReactNativeUnavailable,
            props: expect.objectContaining({ diagnostics: ['pane_destination_unavailable'] }),
        }));
        expect(readLastPaneProp('rightPane')).not.toBe(incumbentRightPane);
    });

    it('preserves an unavailable right-sidebar destination reason instead of treating it as a right-pane mismatch', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const { PluginReactNativeUnavailable } = await import('@/components/plugins/reactNative/PluginReactNativeUnavailable');
        const sidebarPlacement = {
            ...createPlacement({ descriptorId: 'sidebar-disabled', container: 'rightSidebarTab' }),
            availability: { state: 'fallback' as const, reason: 'feature_disabled', diagnostics: ['feature_disabled'] },
        } satisfies PluginUiSurfacePlacementProjection;
        const projection = projectionWith(sidebarPlacement);
        lastProps = null;
        setPaneState({
            right: {
                kind: 'plugin',
                destination: sidebarPlacement.binding.destination,
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
                    serverId: 'server-1',
                    platform: 'web',
                    interactionEnabled: true,
                }}
                rightPaneBuiltinAdapter={{
                    destinationIds: ['incumbent-right'],
                    defaultDestinationId: 'incumbent-right',
                    render: () => <div />,
                }}
            />,
        );

        expect(readLastPaneProp('rightPane')).toEqual(expect.objectContaining({
            type: PluginReactNativeUnavailable,
            props: expect.objectContaining({ diagnostics: ['feature_disabled'] }),
        }));
    });

    it('renders only the exact selected built-in adapter', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const BuiltinPane = (props: Readonly<{ destinationId: string | null }>) => (
            React.createElement('BuiltinPane', props)
        );
        lastProps = null;
        setPaneState({ right: { kind: 'builtin', id: 'git' } });

        await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                rightPaneBuiltinAdapter={{
                    destinationIds: ['git'],
                    render: ({ destinationId }) => <BuiltinPane destinationId={destinationId} />,
                }}
            />,
        );

        expect(readLastPaneProp('rightPane')).toEqual(expect.objectContaining({
            type: BuiltinPane,
            props: { destinationId: 'git' },
        }));
    });

    it('does not render a pane when no adapter owns the selected built-in id', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        lastProps = null;
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
