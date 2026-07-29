import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

const placementHostSpy = vi.hoisted(() => vi.fn((props: unknown) => (
    React.createElement('PluginSurfacePlacementHostMock', { props, testID: 'plugin-surface-placement-host-mock' })
)));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('./PluginSurfaceHost', () => ({
    PluginSurfacePlacementHost: (props: unknown) => placementHostSpy(props),
}));

const pluginUiProjection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    surfacePlacementsById: {
        'surfacePlacement:acme.preview:late': {
            id: 'surfacePlacement:acme.preview:late',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
            descriptorId: 'late',
            placement: 'workspace.details',
            target: { kind: 'workspace' },
            renderer: { kind: 'hostedWeb', contributionId: 'late' },
            display: { label: 'Late' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
            order: 20,
        },
        'surfacePlacement:acme.preview:early': {
            id: 'surfacePlacement:acme.preview:early',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
            descriptorId: 'early',
            placement: 'workspace.details',
            target: { kind: 'workspace' },
            renderer: { kind: 'hostedWeb', contributionId: 'early' },
            display: { label: 'Early' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
            order: 10,
        },
        'surfacePlacement:acme.preview:blocked': {
            id: 'surfacePlacement:acme.preview:blocked',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
            descriptorId: 'blocked',
            placement: 'workspace.details',
            target: { kind: 'workspace' },
            renderer: { kind: 'hostedWeb', contributionId: 'blocked' },
            display: { label: 'Blocked' },
            availability: { state: 'blocked', reason: 'feature_disabled', diagnostics: ['feature_disabled'] },
            order: 0,
        },
        'surfacePlacement:acme.preview:project': {
            id: 'surfacePlacement:acme.preview:project',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
            descriptorId: 'project',
            placement: 'project.details',
            target: { kind: 'project' },
            renderer: { kind: 'hostedWeb', contributionId: 'project' },
            display: { label: 'Project' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
            order: 0,
        },
        'surfacePlacement:acme.preview:web-only': {
            id: 'surfacePlacement:acme.preview:web-only',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
            descriptorId: 'web-only',
            placement: 'workspace.details',
            target: { kind: 'workspace' },
            renderer: { kind: 'hostedWeb', contributionId: 'web-only' },
            display: { label: 'Web only' },
            compatibility: { platforms: ['web'] },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
            order: 30,
        },
    },
    surfacePlacementsByPlacement: {
        'workspace.details': [
            {
                id: 'surfacePlacement:acme.preview:late',
                pluginId: 'acme.preview',
                contributionKind: 'surfacePlacement',
                descriptorId: 'late',
                placement: 'workspace.details',
                target: { kind: 'workspace' },
                renderer: { kind: 'hostedWeb', contributionId: 'late' },
                display: { label: 'Late' },
                availability: { state: 'available', reason: 'available', diagnostics: [] },
                order: 20,
            },
            {
                id: 'surfacePlacement:acme.preview:early',
                pluginId: 'acme.preview',
                contributionKind: 'surfacePlacement',
                descriptorId: 'early',
                placement: 'workspace.details',
                target: { kind: 'workspace' },
                renderer: { kind: 'hostedWeb', contributionId: 'early' },
                display: { label: 'Early' },
                availability: { state: 'available', reason: 'available', diagnostics: [] },
                order: 10,
            },
            {
                id: 'surfacePlacement:acme.preview:blocked',
                pluginId: 'acme.preview',
                contributionKind: 'surfacePlacement',
                descriptorId: 'blocked',
                placement: 'workspace.details',
                target: { kind: 'workspace' },
                renderer: { kind: 'hostedWeb', contributionId: 'blocked' },
                display: { label: 'Blocked' },
                availability: { state: 'blocked', reason: 'feature_disabled', diagnostics: ['feature_disabled'] },
                order: 0,
            },
            {
                id: 'surfacePlacement:acme.preview:web-only',
                pluginId: 'acme.preview',
                contributionKind: 'surfacePlacement',
                descriptorId: 'web-only',
                placement: 'workspace.details',
                target: { kind: 'workspace' },
                renderer: { kind: 'hostedWeb', contributionId: 'web-only' },
                display: { label: 'Web only' },
                compatibility: { platforms: ['web'] },
                availability: { state: 'available', reason: 'available', diagnostics: [] },
                order: 30,
            },
        ],
        'project.details': [{
            id: 'surfacePlacement:acme.preview:project',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
            descriptorId: 'project',
            placement: 'project.details',
            target: { kind: 'project' },
            renderer: { kind: 'hostedWeb', contributionId: 'project' },
            display: { label: 'Project' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
            order: 0,
        }],
    },
};

describe('PluginSurfacePlacementStack', () => {
    it('renders available placements for one placement family in deterministic order', async () => {
        const { PluginSurfacePlacementStack } = await import('./PluginSurfacePlacementStack');
        placementHostSpy.mockClear();

        const screen = await renderScreen(
            <PluginSurfacePlacementStack
                placement="workspace.details"
                pluginUiProjection={pluginUiProjection}
                machineId="machine-1"
                serverId="server-1"
                platform="web"
                testID="workspace-plugin-placements"
            />,
        );

        expect(screen.findByTestId('workspace-plugin-placements')).toBeTruthy();
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
});
