import { describe, expect, it, vi } from 'vitest';

import type {
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiJsonValueV1,
    PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';

import { createPluginSurfaceOpenSurfaceHandler } from './openPluginSurface';

const surface: PluginUiSurfaceContextV1 = {
    pluginId: 'acme.source',
    contributionId: 'source-pane',
    surfaceId: 'surface:source',
    placement: 'rightSidebarSurface',
    platform: 'web',
    channel: 'internal',
    resourceScope: [],
    diagnostics: [],
};

function request(payload: unknown): PluginUiHostApiRequestEnvelopeV1 {
    return {
        version: 1,
        requestId: 'request:open-surface',
        surface,
        method: 'openSurface',
        payload: payload as PluginUiJsonValueV1,
    };
}

describe('createPluginSurfaceOpenSurfaceHandler', () => {
    it('parses the single Protocol-owned qualified destination request before dispatch', async () => {
        const open = vi.fn(async () => ({ ok: true as const }));
        const handler = createPluginSurfaceOpenSurfaceHandler(open);

        await expect(handler(request({
            destination: { pluginId: 'acme.target', localId: 'review' },
            input: { source: 'sidebar' },
            subPath: '/open//changes/',
            instanceKey: 'review:open',
        }))).resolves.toBeNull();

        expect(open).toHaveBeenCalledWith({
            destination: { pluginId: 'acme.target', localId: 'review' },
            input: { source: 'sidebar' },
            subPath: 'open/changes',
            instanceKey: 'review:open',
        });
    });

    it('rejects the retired bare view shape instead of treating it as a caller-scoped destination', async () => {
        const open = vi.fn(async () => ({ ok: true as const }));
        const handler = createPluginSurfaceOpenSurfaceHandler(open);

        await expect(handler(request({ view: 'review' }))).resolves.toMatchObject({
            code: 'invalid_payload',
        });
        expect(open).not.toHaveBeenCalled();
    });
});
