import { describe, expect, it } from 'vitest';

import { defineHostedWebBridgeMessage } from './hostedWeb';

describe('hosted web UI SDK helpers', () => {
    it('defines bridge envelopes without exposing raw host internals', () => {
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

        expect(message.kind).toBe('ready');
    });
});
