import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecuteFailureError, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { PluginUiActionControlEventV1, PluginUiActionControlPresentationV1, PluginUiHostApiRequestEnvelopeV1, PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { renderScreen } from '@/dev/testkit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createPluginSurfaceActionControls } from './pluginSurfaceActionControls';
import type { PluginSurfaceHostActionBinding } from './pluginSurfaceActionDispatch';
import { MountedPluginActionControls } from './MountedPluginActionControls';

function fixture(execute?: PluginSurfaceHostActionBinding['execute']) {
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({}));
    const controls = createPluginSurfaceActionControls({ pluginId: 'acme.comments', surfaceId: 'comments',
        hostAction: { execute: execute ?? executor.execute }, signal: new AbortController().signal,
        isCurrent: () => true, captureCurrentBinding: () => () => true });
    const request = (payload: PluginUiJsonValueV1): PluginUiHostApiRequestEnvelopeV1 => ({
        version: 1, requestId: 'presentation', method: 'actionControl', payload,
        surface: { pluginId: 'acme.comments', contributionId: 'comments', surfaceId: 'comments',
            placement: 'appSurface', platform: 'web', channel: 'development', resourceScope: [], diagnostics: [] },
    });
    return { controls, request,
        bind: (presentation: PluginUiActionControlPresentationV1) => controls.handleRequest(request({
            kind: 'bind', subscriptionId: 'resolve', action: 'projects.compute.exec', presentation,
        }), { actionControlSubscription: { retain() {}, publish() {} } }),
        update: (presentation: PluginUiActionControlPresentationV1) => controls.handleRequest(request({
            kind: 'update', subscriptionId: 'resolve', presentation,
        })),
    };
}

describe('mounted Action control accessibility', () => {
    it('preserves a typed refusal from the first mounted dispatch before readiness', async () => {
        const refusal = { ok: false, errorCode: 'daemon_unavailable', error: 'Machine is connecting',
            requestId: 'cold-daemon-request', effectAttempted: false,
            details: { layer: 'transport', phase: 'preparation' } } as const satisfies ActionExecuteFailure;
        const f = fixture(async () => { throw createActionExecuteFailureError(refusal); });
        const events: PluginUiActionControlEventV1[] = [];
        try {
            await f.controls.handleRequest(f.request({
                kind: 'bind', subscriptionId: 'resolve', action: 'projects.compute.exec', presentation: { title: 'Run' },
            }), { actionControlSubscription: { retain() {}, publish(event) {
                events.push(event);
                if (event.kind === 'prepare') void f.controls.handleRequest(f.request({
                    kind: 'prepared', subscriptionId: 'resolve', requestId: event.requestId, preparation: { input: {} },
                }));
            } } });
            await f.controls.press('resolve');
            expect(events.at(-1)).toMatchObject({ kind: 'settled', execution: refusal });
        } finally { f.controls.dispose(); }
    });
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
