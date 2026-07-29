import type { PluginUiActionDescriptorV1 } from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it, vi } from 'vitest';

import { executePluginUiAction } from './executePluginUiAction';

const data = {
    context: { value: 'copied-text', url: 'https://example.test/page', payload: { a: 1 }, resourceId: 'res-9' },
};

describe('executePluginUiAction', () => {
    it('routes executeAction through the canonical ActionExecutor front door', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: { done: true } }));
        const action: PluginUiActionDescriptorV1 = {
            kind: 'executeAction',
            id: 'a1',
            labelKey: 'l',
            target: { actionId: 'session.open', payloadPath: '/context/payload', resourceIdPath: '/context/resourceId' },
        };
        const result = await executePluginUiAction({
            action,
            data,
            executor: { execute },
            context: { surface: 'ui' },
        });
        expect(result).toEqual({ ok: true, kind: 'executeAction', result: { done: true } });
        expect(execute).toHaveBeenCalledWith(
            'session.open',
            { payload: { a: 1 }, resourceId: 'res-9' },
            { surface: 'ui' },
        );
    });

    it('propagates an executeAction failure', async () => {
        const execute = vi.fn(async () => ({ ok: false as const, errorCode: 'denied', error: 'denied' }));
        const result = await executePluginUiAction({
            action: { kind: 'executeAction', id: 'a', labelKey: 'l', target: { actionId: 'session.open' } },
            executor: { execute },
        });
        expect(result).toEqual({ ok: false, kind: 'executeAction', errorCode: 'denied', error: 'denied' });
    });

    it('fails closed when no executor is supplied for executeAction', async () => {
        const result = await executePluginUiAction({
            action: { kind: 'executeAction', id: 'a', labelKey: 'l', target: { actionId: 'session.open' } },
        });
        expect(result.ok).toBe(false);
        expect(result).toMatchObject({ errorCode: 'plugin_ui_action_executor_unavailable' });
    });

    it('routes copy to the host clipboard handler with the resolved value', async () => {
        const copy = vi.fn();
        const result = await executePluginUiAction({
            action: { kind: 'copy', id: 'c', labelKey: 'l', target: { valuePath: '/context/value' } },
            data,
            host: { copy },
        });
        expect(result).toEqual({ ok: true, kind: 'copy' });
        expect(copy).toHaveBeenCalledWith('copied-text');
    });

    it('fails closed when the copy value cannot be resolved', async () => {
        const result = await executePluginUiAction({
            action: { kind: 'copy', id: 'c', labelKey: 'l', target: { valuePath: '/context/missing' } },
            data,
            host: { copy: vi.fn() },
        });
        expect(result).toMatchObject({ ok: false, errorCode: 'plugin_ui_action_copy_value_unresolved' });
    });

    it('routes openExternal to the host with url + policyId', async () => {
        const openExternal = vi.fn();
        const result = await executePluginUiAction({
            action: {
                kind: 'openExternal',
                id: 'o',
                labelKey: 'l',
                target: { urlPath: '/context/url', policyId: 'safe-links' },
            },
            data,
            host: { openExternal },
        });
        expect(result).toEqual({ ok: true, kind: 'openExternal' });
        expect(openExternal).toHaveBeenCalledWith('https://example.test/page', 'safe-links');
    });

    it('routes openSurface to the host with the surface id', async () => {
        const openSurface = vi.fn();
        const result = await executePluginUiAction({
            action: { kind: 'openSurface', id: 'o', labelKey: 'l', target: { surfaceId: 'surface.preview' } },
            host: { openSurface },
        });
        expect(result).toEqual({ ok: true, kind: 'openSurface' });
        expect(openSurface).toHaveBeenCalledWith('surface.preview');
    });

    it('routes refresh and retry to the host refresh handler', async () => {
        const refresh = vi.fn();
        const refreshResult = await executePluginUiAction({
            action: {
                kind: 'refresh',
                id: 'r',
                labelKey: 'l',
                target: { resourceKind: 'preview', resourceIdPath: '/context/resourceId', surfaceId: 'surface.x' },
            },
            data,
            host: { refresh },
        });
        expect(refreshResult).toEqual({ ok: true, kind: 'refresh' });
        expect(refresh).toHaveBeenCalledWith({ resourceKind: 'preview', resourceId: 'res-9', surfaceId: 'surface.x' });

        const retryResult = await executePluginUiAction({
            action: { kind: 'retry', id: 'r2', labelKey: 'l', target: {} },
            host: { refresh },
        });
        expect(retryResult).toEqual({ ok: true, kind: 'retry' });
    });

    it('fails closed when a host affordance handler is unavailable', async () => {
        const result = await executePluginUiAction({
            action: { kind: 'openSurface', id: 'o', labelKey: 'l', target: { surfaceId: 'surface.x' } },
        });
        expect(result).toMatchObject({ ok: false, errorCode: 'plugin_ui_action_open_surface_handler_unavailable' });
    });
});
