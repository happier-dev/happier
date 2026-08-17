import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    PluginUiDestinationBindingV1,
} from '@happier-dev/protocol/plugins/ui';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { renderScreen } from '@/dev/testkit';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';

const placementHostSpy = vi.hoisted(() => vi.fn((props: unknown) => (
    React.createElement('PluginSurfacePlacementHostMock', { props, testID: 'plugin-surface-placement-host-mock' })
)));
const deviceTypeState = vi.hoisted(() => ({
    value: 'tablet' as 'phone' | 'tablet',
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('./PluginSurfaceHost', () => ({
    PluginSurfacePlacementHost: (props: unknown) => placementHostSpy(props),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceTypeState.value,
}));

function binding(destinationId: string): PluginUiDestinationBindingV1 {
    const normalized = normalizePluginUiDestinationBindingV1({
        pluginId: 'acme.preview',
        destinationId,
        rendererId: destinationId,
        container: 'detailsTab',
        target: Object.freeze({ kind: 'session', sessionIdPath: '/sessionId' }),
    });
    if (!normalized) throw new Error('test fixture must use an admitted destination binding');
    return normalized;
}

function placement(input: Readonly<{
    id: string;
    destinationId: string;
    label: string;
    order: number;
    available?: boolean;
}>): PluginUiSurfacePlacementProjection {
    return Object.freeze({
        id: input.id,
        pluginId: 'acme.preview',
        contributionKind: 'surfacePlacement' as const,
        descriptorId: input.destinationId,
        binding: binding(input.destinationId),
        target: Object.freeze({ kind: 'session', sessionIdPath: '/sessionId' }),
        renderer: Object.freeze({ kind: 'hostedWeb', contributionId: input.destinationId }),
        display: Object.freeze({ label: input.label }),
        availability: Object.freeze(input.available === false
            ? { state: 'blocked' as const, reason: 'feature_disabled', diagnostics: ['feature_disabled'] }
            : { state: 'available' as const, reason: 'available', diagnostics: [] }),
        headerActions: Object.freeze([]),
        order: input.order,
    });
}

const pluginUiProjection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    surfacePlacementsById: {
        'surfacePlacement:acme.preview:late': placement({
            id: 'surfacePlacement:acme.preview:late', destinationId: 'late', label: 'Late', order: 20,
        }),
        'surfacePlacement:acme.preview:early': placement({
            id: 'surfacePlacement:acme.preview:early', destinationId: 'early', label: 'Early', order: 10,
        }),
        'surfacePlacement:acme.preview:blocked': placement({
            id: 'surfacePlacement:acme.preview:blocked', destinationId: 'blocked', label: 'Blocked', order: 0, available: false,
        }),
        'surfacePlacement:acme.preview:web-only': placement({
            id: 'surfacePlacement:acme.preview:web-only', destinationId: 'web-only', label: 'Web only', order: 30,
        }),
    },
};

describe('PluginSurfacePlacementStack', () => {
    beforeEach(() => {
        deviceTypeState.value = 'tablet';
    });

    it('selects only the binding-owned container and target in deterministic order', async () => {
        const { PluginSurfacePlacementStack } = await import('./PluginSurfacePlacementStack');
        placementHostSpy.mockClear();

        const screen = await renderScreen(
            <PluginSurfacePlacementStack
                container="detailsTab"
                targetKind="session"
                pluginUiProjection={pluginUiProjection}
                machineId="machine-1"
                serverId="server-1"
                platform="web"
                testID="session-plugin-placements"
            />,
        );

        expect(screen.findByTestId('session-plugin-placements')).toBeTruthy();
        expect(placementHostSpy).toHaveBeenCalledTimes(3);
        expect(placementHostSpy.mock.calls.map((call) => (
            (call[0] as { placement: { id: string } }).placement.id
        ))).toEqual([
            'surfacePlacement:acme.preview:early',
            'surfacePlacement:acme.preview:late',
            'surfacePlacement:acme.preview:web-only',
        ]);
        expect(placementHostSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'web',
            pluginUiProjection,
        }));
    });

    it('keeps desktop/tablet-only candidates out of phone launchers while retaining native tablets', async () => {
        const { PluginSurfacePlacementStack } = await import('./PluginSurfacePlacementStack');
        placementHostSpy.mockClear();

        const phone = await renderScreen(
            <PluginSurfacePlacementStack
                container="detailsTab"
                targetKind="session"
                pluginUiProjection={pluginUiProjection}
                platform="ios"
                formFactor="phone"
                testID="phone-plugin-placements"
            />,
        );

        // `renderScreen` retains the composite testID in its React tree even
        // when the component returns null, so the mount-host assertion is the
        // stable observable launcher contract here.
        expect(placementHostSpy).not.toHaveBeenCalled();

        const tablet = await renderScreen(
            <PluginSurfacePlacementStack
                container="detailsTab"
                targetKind="session"
                pluginUiProjection={pluginUiProjection}
                platform="ios"
                formFactor="tablet"
                testID="tablet-plugin-placements"
            />,
        );

        expect(tablet.findByTestId('tablet-plugin-placements')).toBeTruthy();
        expect(placementHostSpy).toHaveBeenCalledTimes(3);
        expect(placementHostSpy).toHaveBeenCalledWith(expect.objectContaining({
            formFactor: 'tablet',
            platform: 'ios',
        }));
    });

    it('uses the observed phone form factor for default web admission', async () => {
        const { PluginSurfacePlacementStack } = await import('./PluginSurfacePlacementStack');
        placementHostSpy.mockClear();
        deviceTypeState.value = 'phone';

        await renderScreen(
            <PluginSurfacePlacementStack
                container="detailsTab"
                targetKind="session"
                pluginUiProjection={pluginUiProjection}
                platform="web"
                testID="phone-web-plugin-placements"
            />,
        );

        expect(placementHostSpy).not.toHaveBeenCalled();

        deviceTypeState.value = 'tablet';
        const tablet = await renderScreen(
            <PluginSurfacePlacementStack
                container="detailsTab"
                targetKind="session"
                pluginUiProjection={pluginUiProjection}
                platform="web"
                testID="tablet-web-plugin-placements"
            />,
        );

        expect(tablet.findByTestId('tablet-web-plugin-placements')).toBeTruthy();
        expect(placementHostSpy).toHaveBeenCalledTimes(3);
        expect(placementHostSpy).toHaveBeenCalledWith(expect.objectContaining({
            formFactor: 'tablet',
            platform: 'web',
        }));
    });
});
