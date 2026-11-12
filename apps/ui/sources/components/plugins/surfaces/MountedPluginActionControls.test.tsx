import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { PluginUiActionControlPresentationV1, PluginUiHostApiRequestEnvelopeV1, PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { renderScreen } from '@/dev/testkit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createPluginSurfaceActionControls } from './pluginSurfaceActionControls';
import { MountedPluginActionControls } from './MountedPluginActionControls';

function fixture() {
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({}));
    const controls = createPluginSurfaceActionControls({ pluginId: 'acme.comments', surfaceId: 'comments',
        hostAction: { execute: executor.execute }, signal: new AbortController().signal,
        isCurrent: () => true, captureCurrentBinding: () => () => true });
    const request = (payload: PluginUiJsonValueV1): PluginUiHostApiRequestEnvelopeV1 => ({
        version: 1, requestId: 'presentation', method: 'actionControl', payload,
        surface: { pluginId: 'acme.comments', contributionId: 'comments', surfaceId: 'comments',
            placement: 'appSurface', platform: 'web', channel: 'development', resourceScope: [], diagnostics: [] },
    });
    return { controls,
        bind: (presentation: PluginUiActionControlPresentationV1) => controls.handleRequest(request({
            kind: 'bind', subscriptionId: 'resolve', action: 'projects.compute.exec', presentation,
        }), { actionControlSubscription: { retain() {}, publish() {} } }),
        update: (presentation: PluginUiActionControlPresentationV1) => controls.handleRequest(request({
            kind: 'update', subscriptionId: 'resolve', presentation,
        })),
    };
}

describe('mounted Action control accessibility', () => {
    it('renders a short visible title and a distinct accessible identity on the host button', async () => {
        const f = fixture();
        await f.bind({ title: 'Resolve', accessibilityLabel: 'Resolve comment #123' });
        const screen = await renderScreen(<MountedPluginActionControls controls={f.controls} />);
        try {
            const button = screen.findByTestId('plugin-surface-action-control:resolve');
            expect(button?.props.accessibilityLabel).toBe('Resolve comment #123');
            expect(screen.root.findAll(node => node.props.children === 'Resolve')).not.toHaveLength(0);
        } finally { await screen.unmount(); f.controls.dispose(); }
    });
    it('publishes accessible-label-only changes and removal without changing the visible title', async () => {
        const f = fixture();
        await f.bind({ title: 'Resolve' });
        const screen = await renderScreen(<MountedPluginActionControls controls={f.controls} />);
        try {
            await act(async () => { await f.update({ title: 'Resolve', accessibilityLabel: 'Resolve comment #123' }); });
            expect(f.controls.getSnapshot()[0]?.presentation.accessibilityLabel).toBe('Resolve comment #123');
            expect(screen.findByTestId('plugin-surface-action-control:resolve')?.props.accessibilityLabel).toBe('Resolve comment #123');
            await act(async () => { await f.update({ title: 'Resolve' }); });
            expect(f.controls.getSnapshot()[0]?.presentation.accessibilityLabel).toBeUndefined();
            expect(screen.findByTestId('plugin-surface-action-control:resolve')?.props.accessibilityLabel).toBeUndefined();
        } finally { await screen.unmount(); f.controls.dispose(); }
    });
});
