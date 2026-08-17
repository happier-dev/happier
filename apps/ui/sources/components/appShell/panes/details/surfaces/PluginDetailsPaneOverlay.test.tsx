import * as React from 'react';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';

vi.mock('@/components/plugins/surfaces', () => ({
    PluginSurfacePlacementHost: (props: Readonly<Record<string, unknown>>) => (
        React.createElement('PluginSurfacePlacementHostStub', props)
    ),
}));

vi.mock('@/components/plugins/reactNative/PluginReactNativeUnavailable', () => ({
    PluginReactNativeUnavailable: (props: Readonly<Record<string, unknown>>) => (
        React.createElement('PluginReactNativeUnavailableStub', props)
    ),
}));

vi.mock('@/components/ui/panels/PaneLoadingFallback', () => ({
    PaneLoadingFallback: (props: Readonly<Record<string, unknown>>) => (
        React.createElement('PaneLoadingFallbackStub', props)
    ),
}));

function createPlacement(): PluginUiSurfacePlacementProjection {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: 'com.example.viewer',
        destinationId: 'activity-log',
        rendererId: 'activity-log-renderer',
        container: 'detailsPane',
        instancePolicy: 'multiple',
        target: { kind: 'session', sessionIdPath: '/session/id' },
    });
    if (!binding) throw new Error('fixture must be admitted by the normalized registry');
    return {
        id: 'surfacePlacement:com.example.viewer:activity-log',
        pluginId: 'com.example.viewer',
        contributionKind: 'surfacePlacement',
        descriptorId: 'activity-log',
        binding,
        target: binding.target,
        renderer: { kind: 'hostedWeb', contributionId: 'activity-log-renderer' },
        display: { developerFallback: 'Activity log' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
    };
}

function projectionWith(placement: PluginUiSurfacePlacementProjection): PluginUiProjectionModel {
    return {
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: 4,
        surfacePlacementsById: { [placement.id]: placement },
    };
}

const overlay = {
    destination: { pluginId: 'com.example.viewer', localId: 'activity-log' },
    instanceKey: 'activity:run-1',
    returnFocusedGroupId: 'group:1',
    returnMaximizedGroupId: null,
    returnIsOpen: true,
} as const;

describe('PluginDetailsPaneOverlay', () => {
    it('mounts only the exact current detailsPane destination under the current details scope', async () => {
        const { PluginDetailsPaneOverlay } = await import('./PluginDetailsPaneOverlay');
        const placement = createPlacement();
        const projection = projectionWith(placement);

        const screen = await renderScreen(
            <PluginDetailsPaneOverlay
                targetKind="session"
                projection={projection}
                overlay={overlay}
                mount={{
                    sessionId: 'session-1',
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    platform: 'web',
                    projectionPhase: 'current',
                    projectionInteractionEnabled: true,
                }}
            />,
        );

        expect(screen.root.findByType('PluginSurfacePlacementHostStub' as never).props).toMatchObject({
            placement,
            pluginUiProjection: projection,
            sessionId: 'session-1',
            machineId: 'machine-1',
            serverId: 'server-1',
            mountInstanceKey: 'activity:run-1',
        });
    });

    it('keeps a restored unavailable detailsPane selection as a host tombstone', async () => {
        const { PluginDetailsPaneOverlay } = await import('./PluginDetailsPaneOverlay');

        const screen = await renderScreen(
            <PluginDetailsPaneOverlay
                targetKind="session"
                projection={{ ...EMPTY_PLUGIN_UI_PROJECTION, generation: 4 }}
                overlay={overlay}
                mount={{
                    sessionId: 'session-1',
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    platform: 'web',
                    projectionPhase: 'current',
                    projectionInteractionEnabled: true,
                }}
            />,
        );

        expect(screen.root.findByType('PluginReactNativeUnavailableStub' as never).props).toMatchObject({
            diagnostics: ['pane_destination_unavailable'],
        });
        expect(screen.root.findAllByType('PluginSurfacePlacementHostStub' as never)).toHaveLength(0);
    });

    it('keeps a retained Details overlay visible but noninteractive despite a stale boolean', async () => {
        const { PluginDetailsPaneOverlay } = await import('./PluginDetailsPaneOverlay');
        const placement = createPlacement();

        const screen = await renderScreen(
            <PluginDetailsPaneOverlay
                targetKind="session"
                projection={projectionWith(placement)}
                overlay={overlay}
                mount={{
                    sessionId: 'session-1',
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    platform: 'web',
                    projectionPhase: 'retainedOffline',
                    projectionInteractionEnabled: true,
                }}
            />,
        );

        expect(screen.root.findByType('PluginSurfacePlacementHostStub' as never).props
            .projectionInteractionEnabled).toBe(false);
    });
});
