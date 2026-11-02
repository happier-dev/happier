import { PluginUiJsonValueV1Schema } from '@happier-dev/protocol/plugins/ui';
import type {
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it, vi } from 'vitest';

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
    it('holds a pending installed-plugin call until connection settlement, without polling or repeating its effect', async () => {
        let connecting = true;
        let available = false;
        const read = vi.fn(() => ({ status: 'ready', content: 'external plugin content' }));
        const hostApi = createPluginSurfaceHostApi({ surfaceContext,
            handlers: { statOpenableContent: read },
            isMethodAvailable: method => method === 'context' || available,
            isConnectionPending: () => connecting,
        });
        const invocation = request('statOpenableContent');
        let settled = false;
        const result = settlePluginSurfaceHostApiRequest(invocation, () => hostApi.handleRequest(invocation))
            .then(value => { settled = true; return value; });
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(read).not.toHaveBeenCalled();
        hostApi.notifyConnectionSettled?.();
        expect(read).not.toHaveBeenCalled();
        connecting = false;
        available = true;
        hostApi.notifyConnectionSettled?.();
        await expect(result).resolves.toMatchObject({ kind: 'result', payload: { status: 'ready' } });
        hostApi.notifyConnectionSettled?.();
        expect(read).toHaveBeenCalledTimes(1);
        hostApi.dispose?.();
    });

    it.each(['abort', 'abortAfterConnect', 'retire', 'failed'] as const)('settles a pending host call on %s without invoking its effect', async outcome => {
        let connecting = true;
        let current = true;
        const effect = vi.fn(() => null);
        const hostApi = createPluginSurfaceHostApi({ surfaceContext,
            handlers: { readStoredImage: effect },
            isMethodAvailable: () => outcome === 'abortAfterConnect' && !connecting,
            isCurrent: () => current,
            isConnectionPending: () => connecting,
        });
        const cancellation = new AbortController();
        const invocation = request('readStoredImage');
        const result = settlePluginSurfaceHostApiRequest(invocation,
            () => hostApi.handleRequest(invocation, { signal: cancellation.signal }));
        if (outcome === 'abort') cancellation.abort();
        else if (outcome === 'abortAfterConnect') { connecting = false; hostApi.notifyConnectionSettled?.(); cancellation.abort(); }
        else if (outcome === 'retire') { current = false; hostApi.dispose?.(); }
        else { connecting = false; hostApi.notifyConnectionSettled?.(); }
        await expect(result).resolves.toMatchObject({ kind: 'error', payload: {
            code: outcome === 'retire' ? 'stale_surface' : 'unavailable',
            diagnostics: [outcome === 'abort' || outcome === 'abortAfterConnect' ? 'plugin_ui_invocation_aborted'
                : outcome === 'retire' ? 'plugin_surface_retired' : 'host_api_method_unavailable:readStoredImage'],
        } });
        expect(effect).not.toHaveBeenCalled();
        hostApi.dispose?.();
    });

    it('advertises and serves only the current mounted handler contract without replacing the facade', async () => {
        let handlers: import('./createPluginSurfaceHostApi').PluginSurfaceHostApiHandlers = { readComposer: () => null };
        const hostApi = createPluginSurfaceHostApi({ surfaceContext, readHandlers: () => handlers });
        expect(hostApi.installedMethods).toContain('readComposer');
        expect(hostApi.admissionMethods).not.toContain('focusComposer');
        handlers = { focusComposer: () => ({ focused: true }) };
        expect(hostApi.installedMethods).not.toContain('readComposer');
        expect(hostApi.admissionMethods).toContain('focusComposer');
        expect(await hostApi.handleRequest(request('readComposer'))).toMatchObject({ code: 'unsupported_method' });
        expect(await hostApi.handleRequest(request('focusComposer'))).toEqual({ focused: true });
    });

    it('adds trusted unavailable context without interpreting a matching domain result as an error', async () => {
        const invocation = request('executeAction');
        const domainResult = { code: 'unavailable', diagnostics: ['plugin_surface_contributed_action_unavailable'] };
        for (const [value, expectedKind] of [
            [createPluginSurfaceHostApiError('unavailable', domainResult.diagnostics), 'error'],
            [domainResult, 'result'],
        ] as const) {
            const hostApi = createPluginSurfaceHostApi({ surfaceContext,
                resolveUnavailableError: error => ({ ...error, message: 'Studio Mac is unavailable' }),
                handlers: { executeAction: async () => value },
            });
            const result = await settlePluginSurfaceHostApiRequest(invocation, () => hostApi.handleRequest(invocation));
            expect(result.kind).toBe(expectedKind);
            if (result.kind === 'error') expect(result.payload).toMatchObject({ ...domainResult, message: 'Studio Mac is unavailable' });
            else expect(result.payload).toEqual(domainResult);
        }
    });

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
            retryable: false,
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

    it('settles a native invocation cancellation through the canonical aborted failure', async () => {
        const controller = new AbortController();
        const invocation = request('executeAction');
        const hostApi = createPluginSurfaceHostApi({
            surfaceContext,
            handlers: {
                executeAction: async (_request, options) => {
                    const signal = options?.signal;
                    if (!signal) throw new Error('Cancellation signal missing');
                    await new Promise<void>((resolve) => {
                        signal.addEventListener('abort', () => resolve(), { once: true });
                    });
                    signal.throwIfAborted();
                    return null;
                },
            },
        });
        const settlement = settlePluginSurfaceHostApiRequest(invocation,
            () => hostApi.handleRequest(invocation, { signal: controller.signal }));

        controller.abort();

        await expect(settlement).resolves.toMatchObject({
            requestId: invocation.requestId,
            kind: 'error',
            payload: { code: 'unavailable', diagnostics: ['plugin_ui_invocation_aborted'] },
        });
    });

    it.each([
        new Error('AbortError'),
        new DOMException('The operation timed out', 'TimeoutError'),
    ])('keeps unexpected handler failures internal: %s', async (error) => {
        const invocation = request('executeAction');
        const hostApi = createPluginSurfaceHostApi({
            surfaceContext,
            handlers: { executeAction: async () => { throw error; } },
        });

        await expect(settlePluginSurfaceHostApiRequest(invocation,
            () => hostApi.handleRequest(invocation))).resolves.toMatchObject({
            kind: 'error',
            payload: { code: 'internal_error', diagnostics: ['host_api_handler_failed'] },
        });
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

    it('keeps structural renderer admission separate from transient method availability', async () => {
        let available = false;
        let current = true;
        const methodReads: string[] = [];
        const hostApi = createPluginSurfaceHostApi({
            surfaceContext,
            handlers: { readResource: async () => ({}) },
            isCurrent: () => current,
            isMethodAvailable: (method) => {
                methodReads.push(method);
                return method === 'context' || available;
            },
        });

        expect(hostApi.installedMethods).toEqual(['context']);
        expect(hostApi.admissionMethods).toEqual(['context', 'readResource']);
        methodReads.length = 0;
        expect(hostApi.handleRequest(request('context'))).toMatchObject({ pluginId: surfaceContext.pluginId });
        expect(methodReads).toEqual(['context']);
        methodReads.length = 0;
        expect(hostApi.handleRequest(request('readResource'))).toMatchObject({ code: 'unavailable' });
        expect(methodReads).toEqual(['readResource']);
        available = true;
        await expect(hostApi.handleRequest(request('readResource'))).resolves.toEqual({});

        current = false;
        methodReads.length = 0;
        expect(hostApi.admissionMethods).toEqual([]);
        expect(hostApi.installedMethods).toEqual([]);
        expect(hostApi.handleRequest(request('context'))).toMatchObject({ code: 'stale_surface' });
        expect(methodReads).toEqual([]);
    });

    it('keeps a narrowed method structurally supported without guessing replay safety', async () => {
        let daemonReachable = false;
        const hostApi = createPluginSurfaceHostApi({
            surfaceContext,
            handlers: {
                readResource: async () => ({ ok: true }),
                watchResource: async () => ({ ok: true }),
            },
            isMethodAvailable: (method) => method === 'context' || daemonReachable,
            resolveUnavailableError: error => ({ ...error, message: 'Studio Mac is unavailable' }),
        });

        // Structurally installed, momentarily unreachable. Reporting it as
        // `unsupported_method` would tell the caller the mount can NEVER serve
        // the method, which a reconnect immediately contradicts.
        expect(hostApi.handleRequest(request('watchResource'))).toEqual({
            code: 'unavailable',
            diagnostics: ['host_api_method_unavailable:watchResource'],
            message: 'Studio Mac is unavailable',
        });
        expect(createPluginSurfaceHostApiPluginErrorData('unavailable').retryable).toBe(false);
        expect(createPluginSurfaceHostApiPluginErrorData('unavailable', [], undefined, { retryable: true }).retryable).toBe(true);

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
