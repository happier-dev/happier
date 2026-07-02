import { describe, expect, it } from 'vitest';

import { defineHostedWebUi, defineHostedWebBridgeMessage } from './hostedWeb';

describe('hosted web UI SDK helpers', () => {
    it('defines hosted web UI descriptors and bridge envelopes without exposing raw host internals', () => {
        const descriptor = defineHostedWebUi({
            id: 'preview-web',
            service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
            entry: { routeMode: 'hostOrigin', path: '/' },
            bridge: { allowedMessages: ['ready'] },
            sandbox: { scripts: true },
            fallback: { kind: 'unavailable' },
            display: { titleKey: 'preview.title' },
        });

        const message = defineHostedWebBridgeMessage({
            version: 1,
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            surfaceId: 'sessionSurface:acme.preview:preview-pane',
            nonce: 'nonce-1',
            sequence: 1,
            kind: 'ready',
            payload: { ready: true },
        });

        expect(descriptor.service.kind).toBe('sessionEndpoint');
        expect(message.kind).toBe('ready');
    });
});
