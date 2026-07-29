import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PluginUiHostApiWireEnvelopeV1 } from '@happier-dev/protocol/plugins/ui';

import {
    PluginUiHostApiClientError,
    createPluginUiHostApiClientFromTransport,
} from './clientTransport.js';
import type { PluginUiSurfaceContext } from './hostApi.js';

const surface: PluginUiSurfaceContext = {
    placement: 'session.preview',
    platform: 'web',
    locale: 'en-GB',
    direction: 'ltr',
    colorScheme: 'dark',
    contrast: 'normal',
    textScale: 1,
    reducedMotion: false,
    screenReaderEnabled: false,
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    session: { id: 'session-1', agentId: 'codex' },
};

const identity = {
    pluginId: 'com.acme.fixture',
    pluginVersion: '1.0.0',
    viewId: 'review',
    generation: 'generation-2',
    sessionId: 'session-1',
} as const;

describe('plugin UI domain client transport adapter', () => {
    afterEach(() => vi.useRealTimers());

    it('negotiates once and exposes the same typed domain API used by injected RN contexts', async () => {
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        let receive: ((message: unknown) => void) | undefined;
        const clientPromise = createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['context', 'executeAction', 'readResource', 'watchContext', 'watchResource', 'openSurface', 'diagnostic', 'readClipboard', 'writeClipboard', 'openExternalLink'],
                            surface,
                        });
                    }
                },
                subscribe(listener) {
                    receive = listener;
                    return { dispose: () => { receive = undefined; } };
                },
            },
        });

        const api = await clientPromise;
        expect(api.version()).toEqual({
            apiVersion: '1.0.0',
            wireVersion: 1,
            methods: expect.arrayContaining(['executeAction', 'watchContext']),
        });
        await expect(api.context()).resolves.toEqual(surface);
        expect(sent[0]).toMatchObject({ kind: 'negotiate', identity });
    });

    it('rejects stale-generation results and makes every operation unavailable after disconnect', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        let transportDisposals = 0;
        const apiPromise = createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'request-1',
            transport: {
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['context', 'executeAction'],
                            surface,
                        });
                    }
                },
                subscribe(listener) {
                    receive = listener;
                    return { dispose: () => { transportDisposals += 1; } };
                },
            },
        });
        const api = await apiPromise;
        const action = api.executeAction('summarize', { selection: 'all' });
        receive?.({
            wireVersion: 1,
            kind: 'result',
            identity: { ...identity, generation: 'generation-1' },
            requestId: 'request-1',
            method: 'executeAction',
            result: null,
        });
        receive?.({ wireVersion: 1, kind: 'disconnected', identity, reason: 'daemon_offline' });

        await expect(action).rejects.toMatchObject({ code: 'daemon_offline' });
        await expect(api.context()).rejects.toBeInstanceOf(PluginUiHostApiClientError);
        expect(transportDisposals).toBe(1);
    });

    it('binds subscription events to identity and disposes host subscriptions exactly once', async () => {
        let receive: ((message: unknown) => void) | undefined;
        let nextId = 0;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => `request-${++nextId}`,
            createSubscriptionId: () => 'subscription-1',
            transport: {
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['context', 'watchContext'],
                            surface,
                        });
                    }
                },
                subscribe(listener) {
                    receive = listener;
                    return { dispose: () => undefined };
                },
            },
        });
        const contexts: PluginUiSurfaceContext[] = [];
        const subscription = api.watchContext((context) => contexts.push(context));
        receive?.({
            wireVersion: 1,
            kind: 'subscription',
            identity,
            subscriptionId: 'subscription-1',
            event: surface,
        });
        receive?.({
            wireVersion: 1,
            kind: 'subscription',
            identity: { ...identity, generation: 'old' },
            subscriptionId: 'subscription-1',
            event: { ...surface, locale: 'fr' },
        });
        subscription.dispose();
        subscription.dispose();

        expect(contexts).toEqual([surface]);
        expect(sent.filter((message) => message.kind === 'unsubscribe')).toHaveLength(1);
    });

    it('fails boundedly when the host never completes negotiation', async () => {
        vi.useFakeTimers();
        const pending = createPluginUiHostApiClientFromTransport({
            identity,
            timeoutMs: 25,
            transport: {
                send: () => undefined,
                subscribe: () => ({ dispose: () => undefined }),
            },
        });
        const error = pending.catch((cause: unknown) => cause);
        await vi.advanceTimersByTimeAsync(25);
        await expect(error).resolves.toMatchObject({ code: 'negotiation_timeout' });
    });

    it('handles a sticky disconnect replayed during transport subscription', async () => {
        await expect(createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                send: () => undefined,
                subscribe(listener) {
                    listener({ wireVersion: 1, kind: 'disconnected', identity, reason: 'already_offline' });
                    return { dispose: () => undefined };
                },
            },
        })).rejects.toMatchObject({ code: 'already_offline' });
    });

    it('fails closed when an injected request-id generator repeats an in-flight id', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'repeated',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['executeAction'], surface,
                    });
                },
            },
        });
        const first = api.executeAction('first', null);
        const second = api.executeAction('second', null);
        await expect(second).rejects.toMatchObject({ code: 'duplicate_request_id' });
        expect(sent.filter((message) => message.kind === 'request')).toHaveLength(1);
        receive?.({ wireVersion: 1, kind: 'result', identity, requestId: 'repeated', method: 'executeAction', result: null });
        await expect(first).resolves.toBeNull();
    });

    it('never reuses a settled request id that a late response could target', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'settled-id',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['executeAction'], surface,
                    });
                },
            },
        });
        const first = api.executeAction('first', null);
        receive?.({ wireVersion: 1, kind: 'result', identity, requestId: 'settled-id', method: 'executeAction', result: null });
        await expect(first).resolves.toBeNull();
        await expect(api.executeAction('second', null)).rejects.toMatchObject({ code: 'duplicate_request_id' });
        expect(sent.filter((message) => message.kind === 'request')).toHaveLength(1);
    });

    it('rejects unknown and malformed optional surface context fields during negotiation', async () => {
        let transportDisposals = 0;
        await expect(createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                subscribe(listener) {
                    queueMicrotask(() => listener({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['context'],
                        surface: { ...surface, session: { id: 42 }, ambientCredential: 'secret' },
                    }));
                    return { dispose: () => { transportDisposals += 1; } };
                },
                send: () => undefined,
            },
        })).rejects.toMatchObject({ code: 'invalid_payload' });
        expect(transportDisposals).toBe(1);
    });

    it('cancels timed-out host work and does not claim that an unknown side effect is retryable', async () => {
        vi.useFakeTimers();
        let receive: ((message: unknown) => void) | undefined;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            timeoutMs: 25,
            createRequestId: () => 'timed-out-request',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['executeAction'], surface,
                    });
                },
            },
        });
        const operation = api.executeAction('side-effecting-action', null).catch((cause: unknown) => cause);
        await vi.advanceTimersByTimeAsync(25);

        await expect(operation).resolves.toMatchObject({ code: 'timeout', retryable: false });
        expect(sent.map((message) => message.kind)).toEqual(['negotiate', 'request', 'cancel']);
    });

    it('forwards cancellation for an in-flight domain operation before rejecting locally', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const controller = new AbortController();
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'cancelled-request',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['executeAction'], surface,
                    });
                },
            },
        });
        const operation = api.executeAction('slow-action', null, { signal: controller.signal });
        controller.abort();
        await expect(operation).rejects.toMatchObject({ code: 'aborted' });
        expect(sent.map((message) => message.kind)).toEqual(['negotiate', 'request', 'cancel']);
    });

    it('preserves shared PluginError details, remediation, and diagnostics from the wire', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'error-request',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['executeAction'], surface,
                    });
                },
            },
        });
        const operation = api.executeAction('restricted-action', null);
        receive?.({
            wireVersion: 1,
            kind: 'error',
            identity,
            requestId: 'error-request',
            method: 'executeAction',
            error: {
                name: 'PluginError',
                code: 'permission_denied',
                retryable: false,
                details: { permission: 'clipboard' },
                remediation: { kind: 'openSettings', path: 'plugins.permissions' },
                diagnostics: [{ code: 'permission_denied', severity: 'warning', message: 'Permission is required.' }],
            },
        });

        await expect(operation).rejects.toMatchObject({
            code: 'permission_denied',
            retryable: false,
            details: { permission: 'clipboard' },
            remediation: { kind: 'openSettings', path: 'plugins.permissions' },
            diagnostics: [{ code: 'permission_denied', severity: 'warning' }],
        });
    });

    it('does not correlate an error response to a request for a different method', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'mismatched-error-request',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['executeAction', 'readClipboard'], surface,
                    });
                },
            },
        });
        const operation = api.executeAction('action', null);
        receive?.({
            wireVersion: 1,
            kind: 'error',
            identity,
            requestId: 'mismatched-error-request',
            method: 'readClipboard',
            error: { name: 'PluginError', code: 'clipboard_denied' },
        });

        await expect(operation).rejects.toMatchObject({ code: 'invalid_response_method' });
    });

    it('throws typed unavailability for subscriptions instead of returning a silent no-op', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['context'], surface,
                    });
                },
            },
        });
        expect(() => api.watchContext(() => undefined)).toThrow(expect.objectContaining({ code: 'unsupported_method' }));
        receive?.({ wireVersion: 1, kind: 'disconnected', identity, reason: 'daemon_offline' });
        expect(() => api.watchContext(() => undefined)).toThrow(expect.objectContaining({ code: 'ui_host_unavailable' }));
    });

    it('does not expose the negotiated surface snapshot as an unadvertised context method', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0', methods: [], surface,
                    });
                },
            },
        });

        await expect(api.context()).rejects.toMatchObject({ code: 'unsupported_method' });
    });

    it('rejects a negotiated domain API major that the client cannot implement', async () => {
        await expect(createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                subscribe(listener) {
                    queueMicrotask(() => listener({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '2.0.0',
                        methods: ['context'], surface,
                    }));
                    return { dispose: () => undefined };
                },
                send: () => undefined,
            },
        })).rejects.toMatchObject({ code: 'incompatible_api_version' });
    });

    it('fails closed when a transport tries to renegotiate the same generation', async () => {
        await expect(createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                subscribe(listener) {
                    queueMicrotask(() => {
                        listener({ wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0', methods: ['context'], surface });
                        listener({ wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0', methods: ['context'], surface: { ...surface, locale: 'fr' } });
                    });
                    return { dispose: () => undefined };
                },
                send: () => undefined,
            },
        })).rejects.toMatchObject({ code: 'invalid_negotiation' });
    });

    it('rejects malformed resource bytes instead of silently decoding corrupted base64', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'resource-request',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['readResource'], surface,
                    });
                },
            },
        });
        const resource = api.readResource('logo');
        receive?.({
            wireVersion: 1, kind: 'result', identity, requestId: 'resource-request', method: 'readResource',
            result: { contentType: 'image/png', digest: `sha256:${'a'.repeat(64)}`, bytesBase64: '***' },
        });
        await expect(resource).rejects.toMatchObject({ code: 'invalid_payload' });
    });

    it('rejects unknown resource result and event fields at the domain boundary', async () => {
        let receive: ((message: unknown) => void) | undefined;
        let nextId = 0;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => `strict-resource-${++nextId}`,
            createSubscriptionId: () => 'strict-resource-subscription',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['readResource', 'watchResource'], surface,
                    });
                },
            },
        });
        const resource = api.readResource('logo');
        receive?.({
            wireVersion: 1, kind: 'result', identity, requestId: 'strict-resource-1', method: 'readResource',
            result: { contentType: 'image/png', digest: `sha256:${'a'.repeat(64)}`, bytesBase64: '', ambientCredential: 'secret' },
        });
        await expect(resource).rejects.toMatchObject({ code: 'invalid_payload' });

        let listenerCalls = 0;
        api.watchResource('logo', () => { listenerCalls += 1; });
        expect(() => receive?.({
            wireVersion: 1, kind: 'subscription', identity, subscriptionId: 'strict-resource-subscription',
            event: { digest: `sha256:${'a'.repeat(64)}`, unexpected: true },
        })).toThrow(expect.objectContaining({ code: 'invalid_payload' }));
        expect(listenerCalls).toBe(0);
    });

    it('fails closed when an injected subscription-id generator repeats an active id', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        let requestNumber = 0;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => `subscription-request-${++requestNumber}`,
            createSubscriptionId: () => 'repeated-subscription',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['watchContext'], surface,
                    });
                },
            },
        });
        api.watchContext(() => undefined);
        expect(() => api.watchContext(() => undefined)).toThrow(expect.objectContaining({ code: 'duplicate_subscription_id' }));
        expect(sent.filter((message) => message.kind === 'subscribe')).toHaveLength(1);
    });
});
