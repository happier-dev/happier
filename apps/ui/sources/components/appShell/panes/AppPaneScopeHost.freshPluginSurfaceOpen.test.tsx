import * as React from 'react';
import { act } from 'react-test-renderer';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createEmptyPaneDetailsState } from './details/workspace/detailsWorkspaceReducer';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';
import { installAppPaneScopeHostCommonModuleMocks } from './appPaneScopeHostTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const paneHostState = vi.hoisted(() => ({
    scope: {
        right: { isOpen: false, activeTabId: null, selectedDestination: null as unknown, tabState: {} },
        // Each test installs the complete Details owner state before its first
        // render. Keep the hoisted module-mock state independent of imports.
        details: null as unknown,
        bottom: { isOpen: false, activeTabId: null, selectedDestination: null as unknown, tabState: {} },
    },
    dispatch: vi.fn(),
}));

installAppPaneScopeHostCommonModuleMocks({
    getLocalSetting: (key) => key === 'uiMultiPanePanelsEnabled' ? true : null,
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { text: { secondary: '#777' } } } }),
    StyleSheet: { create: () => ({}) },
}));

vi.mock('@/components/ui/panels/MultiPaneHostWithBottom', () => ({
    MultiPaneHostWithBottom: (props: Readonly<Record<string, unknown>>) => (
        React.createElement('MultiPaneHostStub', props)
    ),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

vi.mock('./AppPaneProvider', () => ({
    useAppPaneContext: () => ({
        dispatch: paneHostState.dispatch,
        state: { scopes: { scope1: paneHostState.scope } },
        getDriver: () => null,
        driverRegistryVersion: 1,
        overlayFocusReturnOwner: undefined,
    }),
}));

vi.mock('@/components/plugins/surfaces', () => ({
    PluginSurfacePlacementHost: () => React.createElement('PluginSurfacePlacementHostMock'),
}));

vi.mock('@/components/plugins/reactNative/PluginReactNativeUnavailable', () => ({
    PluginReactNativeUnavailable: () => React.createElement('PluginReactNativeUnavailableMock'),
}));

function createPlacement(input: Readonly<{
    descriptorId: string;
    container: 'rightPane' | 'bottomPane' | 'detailsTab' | 'detailsPane';
    instancePolicy?: 'singleton' | 'multiple';
    targetKind?: 'session' | 'project';
    pluginId?: string;
}>): PluginUiSurfacePlacementProjection {
    const targetKind = input.targetKind ?? 'session';
    const pluginId = input.pluginId ?? 'acme.preview';
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId,
        destinationId: input.descriptorId,
        rendererId: `${input.descriptorId}-renderer`,
        container: input.container,
        target: { kind: targetKind },
        ...(input.instancePolicy === undefined ? {} : { instancePolicy: input.instancePolicy }),
    });
    if (!binding) throw new Error('test fixture must use an admitted V2 binding');

    return {
        id: `surfacePlacement:${pluginId}:${input.descriptorId}`,
        pluginId,
        contributionKind: 'surfacePlacement',
        descriptorId: input.descriptorId,
        binding,
        target: { kind: targetKind },
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
                    pluginId,
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

describe('AppPaneScopeHost fresh plugin surface open', () => {
    it('hands a fresh current Project Companion bottom-pane request and peer Project panes to their existing owners', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const rightPlacement = createPlacement({
            descriptorId: 'project-right',
            container: 'rightPane',
            targetKind: 'project',
        });
        const projectCompanionBottomPlacement = createPlacement({
            descriptorId: 'project-companion-project-activity-log',
            container: 'bottomPane',
            targetKind: 'project',
            pluginId: 'examples.public-sdk-review-assistant',
        });
        const detailsTabPlacement = createPlacement({
            descriptorId: 'project-details-tab',
            container: 'detailsTab',
            targetKind: 'project',
        });
        const detailsPanePlacement = createPlacement({
            descriptorId: 'project-details-pane',
            container: 'detailsPane',
            targetKind: 'project',
        });
        let openSurface: PluginSurfaceOpenHandler | undefined;

        paneHostState.dispatch.mockClear();
        paneHostState.scope = {
            right: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
            details: createEmptyPaneDetailsState(),
            bottom: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
        };

        await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                surfaceScope={{
                    targetKind: 'project',
                    projectId: 'project-1',
                    pluginUiProjection: projectionWith(
                        rightPlacement,
                        projectCompanionBottomPlacement,
                        detailsTabPlacement,
                        detailsPanePlacement,
                    ),
                    projectionPhase: 'current',
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    platform: 'web',
                    interactionEnabled: true,
                }}
                onPluginSurfaceOpenChange={(next) => {
                    openSurface = next;
                }}
            />,
        );

        expect(openSurface).toBeTypeOf('function');
        const currentOpenSurface = openSurface;
        if (!currentOpenSurface) throw new Error('AppPane did not expose its fresh Project destination owner');
        paneHostState.dispatch.mockClear();

        await act(async () => {
            await expect(currentOpenSurface({
                destination: rightPlacement.binding.destination,
                input: { source: 'project-shell' },
            })).resolves.toEqual({ ok: true });
            await expect(currentOpenSurface({
                destination: projectCompanionBottomPlacement.binding.destination,
                input: { source: 'project-companion' },
            })).resolves.toEqual({ ok: true });
            await expect(currentOpenSurface({
                destination: detailsTabPlacement.binding.destination,
                input: { source: 'project-shell' },
            })).resolves.toEqual({ ok: true });
            await expect(currentOpenSurface({
                destination: detailsPanePlacement.binding.destination,
                input: { source: 'project-shell' },
            })).resolves.toEqual({ ok: true });
        });

        expect(paneHostState.dispatch).toHaveBeenCalledWith({
            type: 'selectRightDestination',
            scopeId: 'scope1',
            destination: { kind: 'plugin', destination: rightPlacement.binding.destination },
        });
        expect(paneHostState.dispatch).toHaveBeenCalledWith({
            type: 'selectBottomDestination',
            scopeId: 'scope1',
            destination: { kind: 'plugin', destination: projectCompanionBottomPlacement.binding.destination },
        });
        expect(paneHostState.dispatch).toHaveBeenCalledWith(expect.objectContaining({
            type: 'openDetailsTab',
            scopeId: 'scope1',
            tab: expect.objectContaining({
                kind: 'pluginDetailsDestination',
                resource: {
                    kind: 'pluginDetailsDestination',
                    destination: detailsTabPlacement.binding.destination,
                },
            }),
        }));
        expect(paneHostState.dispatch).toHaveBeenCalledWith({
            type: 'openDetailsOverlay',
            scopeId: 'scope1',
            destination: detailsPanePlacement.binding.destination,
        });
    });

    it('refuses a fresh Project Details request whose sub-path the Details owner cannot retain', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const detailsPlacement = createPlacement({
            descriptorId: 'project-details-tab',
            container: 'detailsTab',
            targetKind: 'project',
        });
        let openSurface: PluginSurfaceOpenHandler | undefined;

        paneHostState.dispatch.mockClear();
        paneHostState.scope = {
            right: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
            details: createEmptyPaneDetailsState(),
            bottom: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
        };

        await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                surfaceScope={{
                    targetKind: 'project',
                    projectId: 'project-1',
                    pluginUiProjection: projectionWith(detailsPlacement),
                    projectionPhase: 'current',
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    platform: 'web',
                    interactionEnabled: true,
                }}
                onPluginSurfaceOpenChange={(next) => {
                    openSurface = next;
                }}
            />,
        );

        expect(openSurface).toBeTypeOf('function');
        const currentOpenSurface = openSurface;
        if (!currentOpenSurface) throw new Error('AppPane did not expose its fresh Project destination owner');
        paneHostState.dispatch.mockClear();

        await expect(currentOpenSurface({
            destination: detailsPlacement.binding.destination,
            subPath: 'unretained-detail-location',
        })).resolves.toEqual({
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_open_sub_path_unsupported',
        });
        expect(paneHostState.dispatch).not.toHaveBeenCalled();
    });

    it('hands fresh current Session pane and Details destinations to their existing owners', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const rightPlacement = createPlacement({ descriptorId: 'right', container: 'rightPane' });
        const bottomPlacement = createPlacement({
            descriptorId: 'bottom',
            container: 'bottomPane',
            instancePolicy: 'multiple',
        });
        const detailsTabPlacement = createPlacement({ descriptorId: 'details-tab', container: 'detailsTab' });
        const detailsPanePlacement = createPlacement({ descriptorId: 'details-pane', container: 'detailsPane' });
        const projection = projectionWith(rightPlacement, bottomPlacement, detailsTabPlacement, detailsPanePlacement);
        let openSurface: PluginSurfaceOpenHandler | undefined;

        expect(rightPlacement.binding).toMatchObject({
            container: 'rightPane',
            targetKind: 'session',
            instancePolicy: 'singleton',
        });
        expect(bottomPlacement.binding).toMatchObject({
            container: 'bottomPane',
            targetKind: 'session',
            instancePolicy: 'multiple',
        });

        paneHostState.dispatch.mockClear();
        paneHostState.scope = {
            right: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
            details: createEmptyPaneDetailsState(),
            bottom: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
        };

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
                onPluginSurfaceOpenChange={(next) => {
                    openSurface = next;
                }}
            />,
        );

        expect(openSurface).toBeTypeOf('function');
        const currentOpenSurface = openSurface;
        if (!currentOpenSurface) throw new Error('AppPane did not expose its fresh destination owner');
        paneHostState.dispatch.mockClear();

        await act(async () => {
            const rightOutcome = await currentOpenSurface({
                destination: rightPlacement.binding.destination,
                input: { source: 'header' },
            });
            expect(rightOutcome).toEqual({ ok: true });
            const bottomOutcome = await currentOpenSurface({
                destination: bottomPlacement.binding.destination,
                instanceKey: 'activity-1',
                input: { source: 'header' },
            });
            expect(bottomOutcome).toEqual({ ok: true });
            const detailsTabOutcome = await currentOpenSurface({
                destination: detailsTabPlacement.binding.destination,
                input: { source: 'header' },
            });
            expect(detailsTabOutcome).toEqual({ ok: true });
            const detailsPaneOutcome = await currentOpenSurface({
                destination: detailsPanePlacement.binding.destination,
                input: { source: 'header' },
            });
            expect(detailsPaneOutcome).toEqual({ ok: true });
        });

        expect(paneHostState.dispatch).toHaveBeenCalledWith({
            type: 'selectRightDestination',
            scopeId: 'scope1',
            destination: {
                kind: 'plugin',
                destination: rightPlacement.binding.destination,
            },
        });
        expect(paneHostState.dispatch).toHaveBeenCalledWith({
            type: 'selectBottomDestination',
            scopeId: 'scope1',
            destination: {
                kind: 'plugin',
                destination: bottomPlacement.binding.destination,
                instanceKey: 'activity-1',
            },
        });
        expect(paneHostState.dispatch).toHaveBeenCalledWith(expect.objectContaining({
            type: 'openDetailsTab',
            scopeId: 'scope1',
            tab: expect.objectContaining({
                kind: 'pluginDetailsDestination',
                resource: {
                    kind: 'pluginDetailsDestination',
                    destination: detailsTabPlacement.binding.destination,
                },
            }),
        }));
        expect(paneHostState.dispatch).toHaveBeenCalledWith({
            type: 'openDetailsOverlay',
            scopeId: 'scope1',
            destination: detailsPanePlacement.binding.destination,
        });
    });

    it('refuses malformed fresh right and Details requests before any owner mutation', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const rightPlacement = createPlacement({
            descriptorId: 'right-multiple',
            container: 'rightPane',
            instancePolicy: 'multiple',
        });
        const detailsPlacement = createPlacement({ descriptorId: 'details-tab', container: 'detailsTab' });
        let openSurface: PluginSurfaceOpenHandler | undefined;

        paneHostState.dispatch.mockClear();
        paneHostState.scope = {
            right: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
            details: createEmptyPaneDetailsState(),
            bottom: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
        };

        await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                surfaceScope={{
                    targetKind: 'session',
                    sessionId: 'session-1',
                    pluginUiProjection: projectionWith(rightPlacement, detailsPlacement),
                    projectionPhase: 'current',
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    platform: 'web',
                    interactionEnabled: true,
                }}
                onPluginSurfaceOpenChange={(next) => {
                    openSurface = next;
                }}
            />,
        );

        expect(openSurface).toBeTypeOf('function');
        const currentOpenSurface = openSurface;
        if (!currentOpenSurface) throw new Error('AppPane did not expose its fresh destination owner');
        paneHostState.dispatch.mockClear();

        await act(async () => {
            await expect(currentOpenSurface({
                destination: rightPlacement.binding.destination,
            })).resolves.toEqual({
                ok: false,
                code: 'invalid_payload',
                reason: 'plugin_surface_open_instance_key_unsupported',
            });
            await expect(currentOpenSurface({
                destination: detailsPlacement.binding.destination,
                subPath: '/not-a-details-route',
            })).resolves.toEqual({
                ok: false,
                code: 'invalid_payload',
                reason: 'plugin_surface_open_sub_path_unsupported',
            });
        });

        expect(paneHostState.dispatch).not.toHaveBeenCalled();
    });

    it('retires a prior public handler when its direct scope is gone', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const bottomPlacement = createPlacement({
            descriptorId: 'project-bottom',
            container: 'bottomPane',
            targetKind: 'project',
        });
        let openSurface: PluginSurfaceOpenHandler | undefined;

        paneHostState.dispatch.mockClear();
        paneHostState.scope = {
            right: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
            details: createEmptyPaneDetailsState(),
            bottom: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
        };

        const screen = await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                surfaceScope={{
                    targetKind: 'project',
                    projectId: 'project-1',
                    pluginUiProjection: projectionWith(bottomPlacement),
                    projectionPhase: 'current',
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    platform: 'web',
                    interactionEnabled: true,
                }}
                onPluginSurfaceOpenChange={(next) => {
                    openSurface = next;
                }}
            />,
        );

        const retiredOpenSurface = openSurface;
        if (!retiredOpenSurface) throw new Error('AppPane did not expose its fresh Project destination owner');

        await act(async () => {
            await screen.update(
                <AppPaneScopeHost
                    scopeId="scope1"
                    main={<div />}
                    onPluginSurfaceOpenChange={(next) => {
                        openSurface = next;
                    }}
                />,
            );
        });

        expect(openSurface).toBeUndefined();
        paneHostState.dispatch.mockClear();

        await expect(retiredOpenSurface({
            destination: bottomPlacement.binding.destination,
            input: { source: 'stale-project-shell' },
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_surface_open_destination_owner_unavailable',
        });
        expect(paneHostState.dispatch).not.toHaveBeenCalled();
    });

    it('retires an older public handler before a new Project target can own the same destination', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const bottomPlacement = createPlacement({
            descriptorId: 'project-bottom',
            container: 'bottomPane',
            targetKind: 'project',
        });
        const projection = projectionWith(bottomPlacement);
        let openSurface: PluginSurfaceOpenHandler | undefined;
        const onPluginSurfaceOpenChange = (next: PluginSurfaceOpenHandler | undefined) => {
            openSurface = next;
        };

        paneHostState.dispatch.mockClear();
        paneHostState.scope = {
            right: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
            details: createEmptyPaneDetailsState(),
            bottom: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
        };

        const screen = await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
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
                onPluginSurfaceOpenChange={onPluginSurfaceOpenChange}
            />,
        );
        const retiredOpenSurface = openSurface;
        if (!retiredOpenSurface) throw new Error('AppPane did not expose its first Project destination owner');

        await act(async () => {
            await screen.update(
                <AppPaneScopeHost
                    scopeId="scope1"
                    main={<div />}
                    surfaceScope={{
                        targetKind: 'project',
                        projectId: 'project-2',
                        pluginUiProjection: projection,
                        projectionPhase: 'current',
                        machineId: 'machine-1',
                        serverId: 'server-1',
                        platform: 'web',
                        interactionEnabled: true,
                    }}
                    onPluginSurfaceOpenChange={onPluginSurfaceOpenChange}
                />,
            );
        });

        const currentOpenSurface = openSurface;
        if (!currentOpenSurface) throw new Error('AppPane did not expose its replacement Project destination owner');
        expect(currentOpenSurface).not.toBe(retiredOpenSurface);
        paneHostState.dispatch.mockClear();

        await expect(retiredOpenSurface({
            destination: bottomPlacement.binding.destination,
            input: { source: 'project-1' },
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_surface_open_destination_owner_unavailable',
        });
        await expect(currentOpenSurface({
            destination: bottomPlacement.binding.destination,
            input: { source: 'project-2' },
        })).resolves.toEqual({ ok: true });
        expect(paneHostState.dispatch).toHaveBeenCalledTimes(1);
        expect(paneHostState.dispatch).toHaveBeenCalledWith({
            type: 'selectBottomDestination',
            scopeId: 'scope1',
            destination: { kind: 'plugin', destination: bottomPlacement.binding.destination },
        });
    });

    it('retires a superseded semantic callback subscription without retiring the live Project owner', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const bottomPlacement = createPlacement({
            descriptorId: 'project-bottom',
            container: 'bottomPane',
            targetKind: 'project',
        });
        const projection = projectionWith(bottomPlacement);
        let firstSubscription: PluginSurfaceOpenHandler | undefined;
        let secondSubscription: PluginSurfaceOpenHandler | undefined;
        const firstOnPluginSurfaceOpenChange = (next: PluginSurfaceOpenHandler | undefined) => {
            firstSubscription = next;
        };
        const secondOnPluginSurfaceOpenChange = (next: PluginSurfaceOpenHandler | undefined) => {
            secondSubscription = next;
        };
        const surfaceScope = {
            targetKind: 'project' as const,
            projectId: 'project-1',
            pluginUiProjection: projection,
            projectionPhase: 'current' as const,
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'web' as const,
            interactionEnabled: true,
        };

        paneHostState.dispatch.mockClear();
        paneHostState.scope = {
            right: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
            details: createEmptyPaneDetailsState(),
            bottom: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
        };

        const screen = await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                surfaceScope={surfaceScope}
                onPluginSurfaceOpenChange={firstOnPluginSurfaceOpenChange}
            />,
        );
        const retiredSubscription = firstSubscription;
        if (!retiredSubscription) throw new Error('AppPane did not expose its first semantic callback subscription');

        await act(async () => {
            await screen.update(
                <AppPaneScopeHost
                    scopeId="scope1"
                    main={<div />}
                    surfaceScope={surfaceScope}
                    onPluginSurfaceOpenChange={secondOnPluginSurfaceOpenChange}
                />,
            );
        });

        const currentSubscription = secondSubscription;
        if (!currentSubscription) throw new Error('AppPane did not expose its replacement semantic callback subscription');
        expect(currentSubscription).not.toBe(retiredSubscription);
        paneHostState.dispatch.mockClear();

        await expect(retiredSubscription({
            destination: bottomPlacement.binding.destination,
            input: { source: 'retired-semantic-callback' },
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_surface_open_destination_owner_unavailable',
        });
        await expect(currentSubscription({
            destination: bottomPlacement.binding.destination,
            input: { source: 'live-semantic-callback' },
        })).resolves.toEqual({ ok: true });
        expect(paneHostState.dispatch).toHaveBeenCalledTimes(1);
    });

    it('keeps a restored Project bottom selection as its exact tombstone instead of falling back', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const restoredDestination = {
            pluginId: 'examples.public-sdk-review-assistant',
            localId: 'project-companion-project-activity-log',
        };
        const BuiltinBottomPane = () => React.createElement('BuiltinBottomPane');

        paneHostState.dispatch.mockClear();
        paneHostState.scope = {
            right: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
            details: createEmptyPaneDetailsState(),
            bottom: {
                isOpen: true,
                activeTabId: null,
                selectedDestination: { kind: 'plugin', destination: restoredDestination },
                tabState: {},
            },
        };

        const screen = await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                surfaceScope={{
                    targetKind: 'project',
                    projectId: 'project-1',
                    pluginUiProjection: projectionWith(),
                    projectionPhase: 'current',
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    platform: 'web',
                    interactionEnabled: true,
                }}
                bottomPaneBuiltinAdapter={{
                    destinationIds: ['terminal'],
                    defaultDestinationId: 'terminal',
                    render: () => <BuiltinBottomPane />,
                }}
            />,
        );

        const bottomPane = screen.tree.findByType('MultiPaneHostStub' as never).props.bottomPane;
        expect(bottomPane).toEqual(expect.objectContaining({
            props: expect.objectContaining({ diagnostics: ['pane_destination_unavailable'] }),
        }));
        expect(bottomPane.type).not.toBe(BuiltinBottomPane);
        expect(paneHostState.scope.bottom.selectedDestination).toEqual({
            kind: 'plugin',
            destination: restoredDestination,
        });
        expect(paneHostState.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'selectBottomDestination',
        }));
    });
});
