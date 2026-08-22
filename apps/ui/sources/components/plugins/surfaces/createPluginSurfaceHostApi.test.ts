import { PluginUiJsonValueV1Schema } from '@happier-dev/protocol/plugins/ui';
import type {
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it } from 'vitest';

import {
    createPluginSurfaceHostApi,
    createPluginSurfaceHostApiError,
    createPluginSurfaceHostApiPluginErrorData,
    settlePluginSurfaceHostApiRequest,
} from './createPluginSurfaceHostApi';

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
    it('keeps canonical failures as strict JSON while transport settlement retains their provenance', async () => {
        const failure = createPluginSurfaceHostApiError('timeout', ['host_timeout']);
        const actionResult = { code: 'timeout', outcome: 'domain-success' } as const;

        expect(PluginUiJsonValueV1Schema.parse(failure)).toEqual({
            code: 'timeout',
            diagnostics: ['host_timeout'],
        });
        expect(createPluginSurfaceHostApiPluginErrorData('timeout', ['host_timeout'])).toEqual({
            name: 'PluginError',
            code: 'timeout',
            retryable: true,
            diagnostics: [{ code: 'host_timeout', severity: 'error' }],
        });
        expect(createPluginSurfaceHostApiPluginErrorData('denied')).toEqual({
            name: 'PluginError',
            code: 'denied',
            retryable: false,
        });
        await expect(settlePluginSurfaceHostApiRequest(
            request('executeAction'),
            () => failure,
        )).resolves.toMatchObject({
            kind: 'error',
            payload: { code: 'timeout', diagnostics: ['host_timeout'] },
        });
        await expect(settlePluginSurfaceHostApiRequest(
            request('executeAction'),
            () => actionResult,
        )).resolves.toMatchObject({
            kind: 'result',
            payload: actionResult,
        });
    });

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

    it('answers a transiently narrowed method as retryably unavailable, not unsupported', async () => {
        let daemonReachable = false;
        const hostApi = createPluginSurfaceHostApi({
            surfaceContext,
            handlers: {
                readResource: async () => ({ ok: true }),
                watchResource: async () => ({ ok: true }),
            },
            isMethodAvailable: (method) => method === 'context' || daemonReachable,
        });

        // Structurally installed, momentarily unreachable. Reporting it as
        // `unsupported_method` would tell the caller the mount can NEVER serve
        // the method, which a reconnect immediately contradicts.
        expect(hostApi.handleRequest(request('watchResource'))).toEqual({
            code: 'unavailable',
            diagnostics: ['host_api_method_unavailable:watchResource'],
        });
        expect(createPluginSurfaceHostApiPluginErrorData('unavailable').retryable).toBe(true);

        // A method with no installed handler stays permanently unsupported.
        expect(hostApi.handleRequest(request('openSurface'))).toEqual({
            code: 'unsupported_method',
            diagnostics: ['host_api_method_not_installed:openSurface'],
        });

        daemonReachable = true;
        await expect(hostApi.handleRequest(request('watchResource'))).resolves.toEqual({ ok: true });
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
