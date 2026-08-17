import type {
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it } from 'vitest';

import { createPluginSurfaceHostApi } from './createPluginSurfaceHostApi';

const surfaceContext: PluginUiSurfaceContextV1 = {
    pluginId: 'acme.preview',
    contributionId: 'preview-web',
    surfaceId: 'surface-1',
    placement: 'sessionPane',
    platform: 'web',
    channel: 'internal',
    resourceScope: [{ kind: 'session', idPath: '/context/sessionId' }],
    diagnostics: [],
};

function request(
    method: PluginUiHostApiRequestEnvelopeV1['method'],
    payload?: unknown,
): PluginUiHostApiRequestEnvelopeV1 {
    return {
        version: 1,
        requestId: `req:${method}`,
        surface: surfaceContext,
        method,
        payload: payload as PluginUiHostApiRequestEnvelopeV1['payload'],
    };
}

describe('createPluginSurfaceHostApi', () => {
    it('answers context locally and routes injected handlers', async () => {
        const hostApi = createPluginSurfaceHostApi({
            surfaceContext,
            handlers: { writeClipboard: async () => ({ copied: true }) },
        });

        expect(hostApi.handleRequest(request('context'))).toMatchObject({
            pluginId: 'acme.preview',
            surfaceId: 'surface-1',
        });
        await expect(hostApi.handleRequest(request('writeClipboard'))).resolves.toEqual({ copied: true });
    });

    it('returns the canonical unsupported-method refusal for an uninstalled method', () => {
        const hostApi = createPluginSurfaceHostApi({
            surfaceContext,
        });

        expect(hostApi.handleRequest(request('executeAction'))).toMatchObject({
            code: 'unsupported_method',
            diagnostics: ['host_api_method_not_installed:executeAction'],
        });
    });

    it('installs a real handler from the factual handler set, not a static destination ceiling', async () => {
        const hostApi = createPluginSurfaceHostApi({
            surfaceContext,
            handlers: { writeClipboard: async () => ({ copied: true }) },
        });

        expect(hostApi.installedMethods).toEqual(['context', 'writeClipboard']);
        await expect(hostApi.handleRequest(request('writeClipboard'))).resolves.toEqual({ copied: true });
    });

    it('keeps structural renderer admission separate from transient method availability', () => {
        let available = false;
        let current = true;
        const hostApi = createPluginSurfaceHostApi({
            surfaceContext,
            handlers: { readResource: async () => ({}) },
            isCurrent: () => current,
            isMethodAvailable: (method) => method === 'context' || available,
        });

        expect(hostApi.installedMethods).toEqual(['context']);
        expect(hostApi.admissionMethods).toEqual(['context', 'readResource']);

        current = false;
        expect(hostApi.admissionMethods).toEqual([]);
    });

    it('returns a disabled host adapter for a malformed context', () => {
        const malformed = { pluginId: 'acme.preview' } as unknown as PluginUiSurfaceContextV1;
        const hostApi = createPluginSurfaceHostApi({
            surfaceContext: malformed,
            handlers: { writeClipboard: async () => ({ copied: true }) },
        });

        expect(hostApi.platform).toBe('web');
        expect(hostApi.channel).toBe('store');
        expect(hostApi.handleRequest(request('writeClipboard'))).toMatchObject({
            code: 'invalid_payload',
        });
    });

    it('withdraws its factual methods and does not answer context after the mounted controller retires', () => {
        let current = true;
        const hostApi = createPluginSurfaceHostApi({
            surfaceContext,
            isCurrent: () => current,
        });

        current = false;
        expect(hostApi.installedMethods).toEqual([]);
        expect(hostApi.handleRequest(request('context'))).toEqual({
            code: 'stale_surface',
            diagnostics: ['plugin_surface_retired'],
        });
    });
});
