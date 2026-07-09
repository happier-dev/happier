import type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebBridgeResponseEnvelopeV1,
    PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it } from 'vitest';

import { createHostedWebPluginUiHostApiClient } from './bridgeClient';

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

describe('hosted web plugin UI bridge client', () => {
    it('sends host API requests over hosted-web bridge envelopes and correlates bridge responses', async () => {
        const sent: PluginHostedWebBridgeEnvelopeV1[] = [];
        const client = createHostedWebPluginUiHostApiClient({
            surface,
            nonce: 'nonce-1',
            createSequence: () => 4,
            transport: {
                postMessage: (message) => {
                    sent.push(message);
                },
            },
        });

        const promise = client.request('requestSessionResource', {
            resource: { kind: 'session' },
        });

        expect(sent).toEqual([
            expect.objectContaining({
                version: 1,
                pluginId: 'acme.preview',
                contributionId: 'preview-web',
                surfaceId: 'sessionSurface:acme.preview:preview-pane',
                sessionId: 'session-1',
                nonce: 'nonce-1',
                sequence: 4,
                kind: 'requestSessionResource',
                payload: { resource: { kind: 'session' } },
            }),
        ]);

        client.handleBridgeResponse({
            version: 1,
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            surfaceId: 'sessionSurface:acme.preview:preview-pane',
            sessionId: 'session-1',
            nonce: 'nonce-1',
            sequence: 4,
            requestSequence: 4,
            kind: 'result',
            payload: { state: 'available', title: 'Preview' },
        } satisfies PluginHostedWebBridgeResponseEnvelopeV1);

        await expect(promise).resolves.toEqual({
            state: 'available',
            title: 'Preview',
        });
    });

    it('ignores bridge responses that are not bound to the current nonce and surface', async () => {
        const sent: PluginHostedWebBridgeEnvelopeV1[] = [];
        const client = createHostedWebPluginUiHostApiClient({
            surface,
            nonce: 'nonce-1',
            timeoutMs: 10,
            createSequence: () => 9,
            transport: {
                postMessage: (message) => {
                    sent.push(message);
                },
            },
        });

        const promise = client.request('requestSessionResource', {
            resource: { kind: 'session' },
        });
        client.handleBridgeResponse({
            version: 1,
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            surfaceId: 'sessionSurface:acme.preview:preview-pane',
            sessionId: 'session-1',
            nonce: 'wrong',
            sequence: 9,
            requestSequence: 9,
            kind: 'result',
            payload: { state: 'available' },
        } satisfies PluginHostedWebBridgeResponseEnvelopeV1);

        await expect(promise).rejects.toMatchObject({ code: 'timeout' });
        expect(sent).toHaveLength(1);
    });

    it('maps openExternal through the hosted-web bridge instead of falling back to raw navigation', async () => {
        const sent: PluginHostedWebBridgeEnvelopeV1[] = [];
        const client = createHostedWebPluginUiHostApiClient({
            surface,
            nonce: 'nonce-1',
            createSequence: () => 12,
            transport: {
                postMessage: (message) => {
                    sent.push(message);
                },
            },
        });

        const promise = client.request('openExternal', {
            url: 'https://docs.example.test/plugin',
            policyId: 'docs',
        });
        void promise.catch(() => undefined);

        expect(sent).toEqual([
            expect.objectContaining({
                sequence: 12,
                kind: 'openExternal',
                payload: {
                    url: 'https://docs.example.test/plugin',
                    policyId: 'docs',
                },
            }),
        ]);

        client.handleBridgeResponse({
            version: 1,
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            surfaceId: 'sessionSurface:acme.preview:preview-pane',
            sessionId: 'session-1',
            nonce: 'nonce-1',
            sequence: 12,
            requestSequence: 12,
            kind: 'result',
            payload: { accepted: true },
        } satisfies PluginHostedWebBridgeResponseEnvelopeV1);

        await expect(promise).resolves.toEqual({ accepted: true });
    });

    it('sends hosted-web unsubscribeResource requests during local subscription cleanup', () => {
        const sent: PluginHostedWebBridgeEnvelopeV1[] = [];
        let nextSequence = 20;
        const client = createHostedWebPluginUiHostApiClient({
            surface,
            nonce: 'nonce-1',
            createSequence: () => nextSequence++,
            transport: {
                postMessage: (message) => {
                    sent.push(message);
                },
            },
        });

        const subscription = client.subscribeResource(
            { kind: 'localService', idPath: '/services/0/id' },
            () => undefined,
        );
        subscription.unsubscribe();

        expect(sent.map((message) => message.kind)).toEqual([
            'subscribeResource',
            'unsubscribeResource',
        ]);
        expect(sent[1]).toEqual(expect.objectContaining({
            sequence: 21,
            kind: 'unsubscribeResource',
            payload: { subscriptionId: subscription.subscriptionId },
        }));
    });
});
