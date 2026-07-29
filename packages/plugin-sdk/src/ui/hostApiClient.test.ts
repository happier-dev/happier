import type {
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiHostApiResponseEnvelopeV1,
    PluginUiResourceSubscriptionEventV1,
    PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    PluginUiHostApiClientError,
    createPluginUiHostApiClient,
} from './hostApiClient';

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

describe('plugin UI host API SDK client', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('correlates exactly one host response to the pending request', async () => {
        const sent: PluginUiHostApiRequestEnvelopeV1[] = [];
        const client = createPluginUiHostApiClient({
            surface,
            createRequestId: () => 'req-1',
            transport: {
                send: (request) => {
                    sent.push(request);
                },
            },
        });

        const promise = client.request('requestSessionResource', {
            resource: { kind: 'session' },
        });

        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
            requestId: 'req-1',
            method: 'requestSessionResource',
            surface,
        });

        client.handleMessage({
            version: 1,
            requestId: 'other-request',
            surface,
            method: 'requestSessionResource',
            kind: 'error',
            payload: { code: 'denied', diagnostics: [] },
        } satisfies PluginUiHostApiResponseEnvelopeV1);

        client.handleMessage({
            version: 1,
            requestId: 'req-1',
            surface,
            method: 'requestSessionResource',
            kind: 'result',
            payload: { state: 'available', title: 'Preview' },
        } satisfies PluginUiHostApiResponseEnvelopeV1);

        client.handleMessage({
            version: 1,
            requestId: 'req-1',
            surface,
            method: 'requestSessionResource',
            kind: 'error',
            payload: { code: 'internal_error', diagnostics: [] },
        } satisfies PluginUiHostApiResponseEnvelopeV1);

        await expect(promise).resolves.toEqual({
            state: 'available',
            title: 'Preview',
        });
    });

    it('rejects pending requests with a typed timeout error', async () => {
        vi.useFakeTimers();
        const client = createPluginUiHostApiClient({
            surface,
            timeoutMs: 25,
            createRequestId: () => 'req-timeout',
            transport: {
                send: () => undefined,
            },
        });

        const promise = client.request('requestSessionResource', {
            resource: { kind: 'session' },
        });
        const observedError = promise.catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(25);

        const error = await observedError;
        expect(error).toBeInstanceOf(PluginUiHostApiClientError);
        expect(error).toMatchObject({
            code: 'timeout',
            requestId: 'req-timeout',
            method: 'requestSessionResource',
        });
    });

    it('dispatches subscription events until the subscription is closed', () => {
        const events: PluginUiResourceSubscriptionEventV1[] = [];
        const sent: PluginUiHostApiRequestEnvelopeV1[] = [];
        const client = createPluginUiHostApiClient({
            surface,
            createRequestId: (() => {
                const ids = ['req-subscribe', 'req-unsubscribe'];
                return () => ids.shift() ?? 'req-extra';
            })(),
            createSubscriptionId: () => 'sub-1',
            transport: {
                send: (request) => {
                    sent.push(request);
                },
            },
        });

        const subscription = client.subscribeResource(
            { kind: 'localService', idPath: '/services/0/id' },
            (event) => events.push(event),
        );

        client.handleMessage({
            version: 1,
            subscriptionId: 'sub-1',
            kind: 'snapshot',
            snapshot: {
                resource: { kind: 'localService', idPath: '/services/0/id' },
                state: 'available',
                capturedAtMs: 1,
                payload: { status: 'ready' },
                diagnostics: [],
            },
        } satisfies PluginUiResourceSubscriptionEventV1);
        subscription.unsubscribe();
        client.handleMessage({
            version: 1,
            subscriptionId: 'sub-1',
            kind: 'complete',
            diagnostics: [],
        } satisfies PluginUiResourceSubscriptionEventV1);

        expect(events).toHaveLength(1);
        expect(events[0]?.kind).toBe('snapshot');
        expect(sent.map((request) => request.method)).toEqual([
            'subscribeResource',
            'unsubscribeResource',
        ]);
        expect(sent[1]?.payload).toEqual({ subscriptionId: 'sub-1' });
    });
});
