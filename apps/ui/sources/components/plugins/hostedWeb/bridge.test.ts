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

function nestedPayload(depth: number): unknown {
    let value: unknown = null;
    for (let index = 0; index < depth; index += 1) {
        value = [value];
    }
    return value;
}

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

    it('accepts a sessionless initial ready but still requires the bound Session afterwards', () => {
        const { sessionId: _sessionId, ...sessionlessReady } = message;

        expect(validatePluginHostedWebBridgeMessage({
            message: sessionlessReady,
            origin: 'https://preview.example.test',
            expectedOrigin: 'https://preview.example.test',
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'preview-web',
            expectedSurfaceId: 'sessionSurface:acme.preview:preview-pane',
            expectedNonce: 'nonce-1',
            expectedSessionId: 'session-1',
            allowedMessageKinds: new Set(['ready']),
        })).toEqual({ ok: true, envelope: sessionlessReady });

        expect(validatePluginHostedWebBridgeMessage({
            message: {
                ...sessionlessReady,
                kind: 'hostApi',
                payload: { kind: 'negotiate' },
            },
            origin: 'https://preview.example.test',
            expectedOrigin: 'https://preview.example.test',
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'preview-web',
            expectedSurfaceId: 'sessionSurface:acme.preview:preview-pane',
            expectedNonce: 'nonce-1',
            expectedSessionId: 'session-1',
            allowedMessageKinds: new Set(['ready', 'hostApi']),
        })).toEqual({ ok: false, code: 'session_mismatch' });
    });

    it('accepts deeply nested strict JSON before enforcing nonce identity', () => {
        let result: ReturnType<typeof validatePluginHostedWebBridgeMessage> | undefined;
        expect(() => {
            result = validatePluginHostedWebBridgeMessage({
                message: { ...message, nonce: 'wrong', payload: nestedPayload(12_000) },
                origin: 'https://preview.example.test',
                expectedOrigin: 'https://preview.example.test',
                expectedPluginId: 'acme.preview',
                expectedContributionId: 'preview-web',
                expectedSurfaceId: 'sessionSurface:acme.preview:preview-pane',
                expectedNonce: 'nonce-1',
                allowedMessageKinds: new Set(['ready']),
            });
        }).not.toThrow();

        expect(result).toEqual({ ok: false, code: 'nonce_mismatch' });
    });
});
