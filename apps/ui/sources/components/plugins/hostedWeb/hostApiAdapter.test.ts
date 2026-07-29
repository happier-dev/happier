import type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it, vi } from 'vitest';

import { createPluginHostedWebHostApiBridgeHandler } from '@/components/plugins/hostApi/hostedWebAdapter';

const surface: PluginUiSurfaceContextV1 = {
    pluginId: 'acme.preview',
    contributionId: 'preview-web',
    surfaceId: 'sessionSurface:acme.preview:preview-pane',
    sessionId: 'session-1',
    placement: 'sessionPane',
    platform: 'web',
    channel: 'internal',
    resourceScope: [],
    diagnostics: [],
};

function createEnvelope(
    kind: PluginHostedWebBridgeEnvelopeV1['kind'],
    payload: PluginHostedWebBridgeEnvelopeV1['payload'],
): PluginHostedWebBridgeEnvelopeV1 {
    return {
        version: 1,
        pluginId: 'acme.preview',
        contributionId: 'preview-web',
        surfaceId: 'sessionSurface:acme.preview:preview-pane',
        sessionId: 'session-1',
        nonce: 'nonce-1',
        sequence: 7,
        kind,
        payload,
    };
}

describe('hosted web plugin host API adapter', () => {
    it('acks ready bridge messages with the resolved surface context', async () => {
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            handleRequest: vi.fn(),
        });

        await expect(handler(createEnvelope('ready', { ready: true }))).resolves.toMatchObject({
            kind: 'ack',
            requestSequence: 7,
            payload: {
                accepted: true,
                surface,
            },
        });
    });

    it('types duplicate ready bridge messages without recording a new ready transition', async () => {
        const readyStates: string[] = [];
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            handleRequest: vi.fn(),
            onReadyStateChange: (state: { state: string }) => readyStates.push(state.state),
        } as any);

        await expect(handler(createEnvelope('ready', { ready: true }))).resolves.toMatchObject({
            kind: 'ack',
            payload: {
                readyState: 'recorded',
            },
        });
        await expect(handler(createEnvelope('ready', { ready: true }))).resolves.toMatchObject({
            kind: 'ack',
            payload: {
                readyState: 'duplicate',
            },
        });
        expect(readyStates).toEqual(['ready']);
    });

    it('returns a typed stale-surface error for ready messages bound to an old surface context', async () => {
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            handleRequest: vi.fn(),
        });

        await expect(handler({
            ...createEnvelope('ready', { ready: true }),
            sessionId: 'stale-session',
        })).resolves.toMatchObject({
            kind: 'error',
            requestSequence: 7,
            payload: {
                code: 'stale_surface',
            },
        });
    });

    it('acks passive lifecycle bridge messages without dispatching host API requests', async () => {
        const handleRequest = vi.fn();
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            handleRequest,
        });

        await expect(handler(createEnvelope('heightChanged', { height: 320 }))).resolves.toMatchObject({
            kind: 'ack',
            requestSequence: 7,
            payload: { accepted: true },
        });
        expect(handleRequest).not.toHaveBeenCalled();
    });

    it('maps allowed bridge requests into shared host API request envelopes', async () => {
        const seenRequests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            handleRequest: async (request) => {
                seenRequests.push(request);
                return { state: 'available', title: 'Preview' };
            },
        });

        await expect(handler(createEnvelope('requestSessionResource', {
            resource: { kind: 'session' },
        }))).resolves.toMatchObject({
            kind: 'result',
            requestSequence: 7,
            payload: { state: 'available', title: 'Preview' },
        });

        expect(seenRequests).toHaveLength(1);
        expect(seenRequests[0]).toMatchObject({
            version: 1,
            requestId: 'hosted-web:7',
            surface,
            method: 'requestSessionResource',
            payload: { resource: { kind: 'session' } },
        });
    });

    it('acks logDiagnostic after routing it through the shared host API request envelope', async () => {
        const seenRequests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            handleRequest: async (request) => {
                seenRequests.push(request);
                return { stored: true };
            },
        });

        await expect(handler(createEnvelope('logDiagnostic', {
            level: 'info',
            message: 'plugin initialized',
        }))).resolves.toMatchObject({
            kind: 'ack',
            requestSequence: 7,
            payload: { accepted: true },
        });

        expect(seenRequests).toHaveLength(1);
        expect(seenRequests[0]).toMatchObject({
            version: 1,
            requestId: 'hosted-web:7',
            surface,
            method: 'logDiagnostic',
            payload: {
                level: 'info',
                message: 'plugin initialized',
            },
        });
    });

    it('maps openExternal and unsubscribeResource bridge messages into host API requests', async () => {
        const seenRequests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            handleRequest: async (request) => {
                seenRequests.push(request);
                return { accepted: true };
            },
        });

        await expect(handler(createEnvelope('openExternal', {
            urlPath: '/links/docs',
            policyId: 'docs',
        }))).resolves.toMatchObject({
            kind: 'result',
            requestSequence: 7,
            payload: { accepted: true },
        });
        await expect(handler(createEnvelope('unsubscribeResource', {
            subscriptionId: 'sub-1',
        }))).resolves.toMatchObject({
            kind: 'result',
            requestSequence: 7,
            payload: { accepted: true },
        });

        expect(seenRequests.map((request) => request.method)).toEqual([
            'openExternal',
            'unsubscribeResource',
        ]);
    });

    it('fails closed with typed bridge errors when a request has no host handler', async () => {
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
        });

        await expect(handler(createEnvelope('copy', { text: 'secret' }))).resolves.toMatchObject({
            kind: 'error',
            requestSequence: 7,
            payload: {
                code: 'unavailable',
            },
        });
    });

    it('makes a retired bridge handler unavailable before a stale frame listener can dispatch', async () => {
        const handleRequest = vi.fn(async () => ({ accepted: true }));
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            handleRequest,
        });

        handler.dispose();

        await expect(handler(createEnvelope('requestSessionResource', {
            resource: { kind: 'session' },
        }))).resolves.toMatchObject({
            kind: 'error',
            requestSequence: 7,
            payload: {
                code: 'unavailable',
            },
        });
        expect(handleRequest).not.toHaveBeenCalled();
    });

    it('disposes host-side subscriptions and suppresses events after unsubscribe', async () => {
        const deliveredEvents: unknown[] = [];
        const auditEvents: unknown[] = [];
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            handleRequest: async () => ({ accepted: true }),
            deliverSubscriptionEvent: (event: unknown) => {
                deliveredEvents.push(event);
            },
            audit: (event: unknown) => {
                auditEvents.push(event);
            },
        } as any);

        await handler(createEnvelope('subscribeResource', {
            subscriptionId: 'sub-1',
            resource: { kind: 'localService', idPath: '/services/0/id' },
        }));
        (handler as any).publishSubscriptionEvent({
            version: 1,
            subscriptionId: 'sub-1',
            kind: 'snapshot',
            snapshot: {
                resource: { kind: 'localService', idPath: '/services/0/id' },
                state: 'available',
                capturedAtMs: 1,
                payload: { status: 'ready' },
            },
        });

        await expect(handler(createEnvelope('unsubscribeResource', {
            subscriptionId: 'sub-1',
        }))).resolves.toMatchObject({
            kind: 'result',
            payload: {
                accepted: true,
                subscriptionId: 'sub-1',
            },
        });
        (handler as any).publishSubscriptionEvent({
            version: 1,
            subscriptionId: 'sub-1',
            kind: 'complete',
        });

        expect(deliveredEvents).toHaveLength(1);
        expect(auditEvents).toContainEqual(expect.objectContaining({
            type: 'subscriptionDisposed',
            subscriptionId: 'sub-1',
        }));
        expect(auditEvents).toContainEqual(expect.objectContaining({
            type: 'subscriptionEventSuppressed',
            subscriptionId: 'sub-1',
        }));
    });

    it('retires a subscription that settles after the bridge surface is disposed', async () => {
        const seenRequests: PluginUiHostApiRequestEnvelopeV1[] = [];
        let settleSubscribe: (() => void) | undefined;
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            handleRequest: async (request) => {
                seenRequests.push(request);
                if (request.method === 'subscribeResource') {
                    await new Promise<void>((resolve) => {
                        settleSubscribe = resolve;
                    });
                }
                return { accepted: true };
            },
        });

        const subscription = handler(createEnvelope('subscribeResource', {
            subscriptionId: 'sub-racing-retirement',
            resource: { kind: 'localService', idPath: '/services/0/id' },
        }));
        await vi.waitFor(() => {
            expect(seenRequests.map((request) => request.method)).toEqual(['subscribeResource']);
        });

        handler.dispose();
        settleSubscribe?.();

        await expect(subscription).resolves.toMatchObject({
            kind: 'error',
            payload: {
                code: 'unavailable',
            },
        });
        await vi.waitFor(() => {
            expect(seenRequests.map((request) => request.method)).toEqual([
                'subscribeResource',
                'unsubscribeResource',
            ]);
        });
    });

    it('retires settled host subscriptions when the bridge surface is disposed', async () => {
        const seenRequests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            handleRequest: async (request) => {
                seenRequests.push(request);
                return { accepted: true };
            },
        });

        await handler(createEnvelope('subscribeResource', {
            subscriptionId: 'sub-active-at-retirement',
            resource: { kind: 'localService', idPath: '/services/0/id' },
        }));
        handler.dispose();

        await vi.waitFor(() => {
            expect(seenRequests.map((request) => request.method)).toEqual([
                'subscribeResource',
                'unsubscribeResource',
            ]);
        });
    });
});
