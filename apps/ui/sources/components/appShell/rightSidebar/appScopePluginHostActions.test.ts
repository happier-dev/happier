import { describe, expect, it, vi } from 'vitest';

import type {
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';

import { createAppScopePluginSurfaceHostApi } from './appScopePluginHostActions';

function createPlacement(pluginId = 'happier.inspector') {
    return {
        id: `surfacePlacement:${pluginId}:inspector-app`,
        pluginId,
        contributionKind: 'surfacePlacement',
        descriptorId: 'inspector-app',
        placement: 'app.rightSidebarTab',
        target: { kind: 'app' },
        renderer: { kind: 'hostedWeb', contributionId: 'inspector-app-web' },
        display: { label: 'Plugin Inspector' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        rightSidebar: { tabId: 'plugin-inspector', scope: 'app' },
    } as never;
}

function dispatchRequest(
    payload: PluginUiJsonValueV1,
): PluginUiHostApiRequestEnvelopeV1 {
    return {
        version: 1,
        requestId: 'request-1',
        surface: {
            pluginId: 'happier.inspector',
            contributionId: 'inspector-app',
            surfaceId: 'surfacePlacement:happier.inspector:inspector-app',
            placement: 'appSurface',
            platform: 'web',
            channel: 'internal',
            resourceScope: [],
            diagnostics: [],
        },
        method: 'dispatchAction',
        payload,
    };
}

describe('createAppScopePluginSurfaceHostApi', () => {
    it('routes inspector list/reload actions through the ActionExecutor front door on the UI surface', async () => {
        const executeAction = vi.fn(async () => ({ ok: true as const, result: { plugins: [] } }));
        const api = createAppScopePluginSurfaceHostApi({
            placement: createPlacement(),
            platform: 'web',
            executeAction,
            actionExecutorContext: { serverId: 'server-1' },
        });

        await expect(api.handleRequest(dispatchRequest({
            actionId: 'plugins.list',
            input: {},
        }))).resolves.toEqual({ plugins: [] });
        await expect(api.handleRequest(dispatchRequest({
            actionId: 'plugins.reload',
            input: { pluginId: 'happier.inspector' },
        }))).resolves.toEqual({ plugins: [] });

        expect(executeAction).toHaveBeenCalledTimes(2);
        expect(executeAction).toHaveBeenNthCalledWith(1, 'plugins.list', {}, {
            surface: 'ui',
            serverId: 'server-1',
        });
        expect(executeAction).toHaveBeenNthCalledWith(2, 'plugins.reload', { pluginId: 'happier.inspector' }, {
            surface: 'ui',
            serverId: 'server-1',
        });
    });

    it('routes the generated renderer public Host API action envelope', async () => {
        const executeAction = vi.fn(async () => ({ ok: true as const, result: { plugins: [] } }));
        const api = createAppScopePluginSurfaceHostApi({
            placement: createPlacement(),
            platform: 'web',
            executeAction,
            actionExecutorContext: { serverId: 'server-1' },
        });

        await expect(api.handleRequest(dispatchRequest({
            action: 'plugins.reload',
            input: { pluginId: 'happier.inspector' },
        }))).resolves.toEqual({ plugins: [] });

        expect(executeAction).toHaveBeenCalledWith('plugins.reload', { pluginId: 'happier.inspector' }, {
            surface: 'ui',
            serverId: 'server-1',
        });
    });

    it('fails closed for non-inspector app-scope action ids', async () => {
        const executeAction = vi.fn(async () => ({ ok: true as const, result: {} }));
        const api = createAppScopePluginSurfaceHostApi({
            placement: createPlacement(),
            platform: 'web',
            executeAction,
        });

        const result = await api.handleRequest(dispatchRequest({
            actionId: 'plugins.install',
            input: { path: '/tmp/plugin' },
        }));

        expect(executeAction).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            code: 'unavailable',
            diagnostics: expect.arrayContaining(['app_scope_host_action_not_allowed']),
        });
    });

    it('fails closed for inspector actions requested by a non-inspector app surface', async () => {
        const executeAction = vi.fn(async () => ({ ok: true as const, result: {} }));
        const api = createAppScopePluginSurfaceHostApi({
            placement: createPlacement('acme.other-app-surface'),
            platform: 'web',
            executeAction,
        });

        const result = await api.handleRequest(dispatchRequest({
            actionId: 'plugins.reload',
            input: { pluginId: 'happier.inspector' },
        }));

        expect(executeAction).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            code: 'unavailable',
            diagnostics: expect.arrayContaining(['app_scope_host_action_plugin_not_allowed']),
        });
    });
});
