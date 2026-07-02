import { describe, expect, it } from 'vitest';

import { validatePluginHostedWebBridgeMessage } from './bridge';

const message = {
    version: 1,
    pluginId: 'acme.preview',
    contributionId: 'preview-web',
    surfaceId: 'sessionSurface:acme.preview:preview-pane',
    sessionId: 'session-1',
    nonce: 'nonce-1',
    sequence: 1,
    kind: 'ready',
    payload: { ready: true },
} as const;

describe('plugin hosted web bridge validation', () => {
    it('accepts messages only when origin, nonce, and descriptor binding match', () => {
        expect(validatePluginHostedWebBridgeMessage({
            message,
            origin: 'https://preview.example.test',
            expectedOrigin: 'https://preview.example.test',
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'preview-web',
            expectedSurfaceId: 'sessionSurface:acme.preview:preview-pane',
            expectedNonce: 'nonce-1',
            allowedMessageKinds: new Set(['ready']),
        })).toEqual({ ok: true, envelope: message });
    });

    it('fails closed for wrong origin, nonce, or bridge message kind', () => {
        expect(validatePluginHostedWebBridgeMessage({
            message: { ...message, nonce: 'wrong' },
            origin: 'https://preview.example.test',
            expectedOrigin: 'https://preview.example.test',
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'preview-web',
            expectedSurfaceId: 'sessionSurface:acme.preview:preview-pane',
            expectedNonce: 'nonce-1',
            allowedMessageKinds: new Set(['ready']),
        })).toEqual({ ok: false, code: 'nonce_mismatch' });

        expect(validatePluginHostedWebBridgeMessage({
            message,
            origin: 'https://evil.example.test',
            expectedOrigin: 'https://preview.example.test',
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'preview-web',
            expectedSurfaceId: 'sessionSurface:acme.preview:preview-pane',
            expectedNonce: 'nonce-1',
            allowedMessageKinds: new Set(['ready']),
        })).toEqual({ ok: false, code: 'origin_mismatch' });

        expect(validatePluginHostedWebBridgeMessage({
            message,
            origin: 'https://preview.example.test',
            expectedOrigin: 'https://preview.example.test',
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'preview-web',
            expectedSurfaceId: 'sessionSurface:acme.preview:preview-pane',
            expectedNonce: 'nonce-1',
            allowedMessageKinds: new Set(['requestHostAction']),
        })).toEqual({ ok: false, code: 'message_kind_denied' });
    });
});
