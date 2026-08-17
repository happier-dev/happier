import { describe, expect, it } from 'vitest';

import {
    resolveHostedWebRuntimeDiagnostics,
} from './hostedWebRuntime';

const hostedWeb = {
    id: 'hostedWeb:acme.preview:preview-web',
    pluginId: 'acme.preview',
    contributionKind: 'hostedWeb',
    contributionId: 'preview-web',
    service: { kind: 'staticAssets', assetRootId: 'hosted-web/preview-web' },
    bridge: { allowedMessages: ['ready'] },
    security: {},
    fallback: { kind: 'descriptor', descriptorId: 'preview-card' },
} as const;

describe('hosted-web UI runtime diagnostics', () => {
    it('reports a missing endpoint without inferring frame-adapter absence from static assets', () => {
        expect(resolveHostedWebRuntimeDiagnostics({
            hostedWeb,
            endpointUrl: null,
            nowMs: 1_000,
        })).toEqual({
            state: 'fallback',
            reason: 'preview_unavailable',
            diagnostics: ['hosted_web_preview_unavailable', 'hosted_web_fallback_rendering'],
        });
    });

    it('distinguishes preview expiry from a missing endpoint', () => {
        expect(resolveHostedWebRuntimeDiagnostics({
            hostedWeb,
            endpointUrl: 'https://preview.happier.test/plugin/acme/',
            expiresAt: 900,
            nowMs: 1_000,
        })).toEqual({
            state: 'fallback',
            reason: 'preview_expired',
            diagnostics: ['hosted_web_preview_expired', 'hosted_web_fallback_rendering'],
        });
    });

    it('keeps an exact projected preview endpoint renderable independently of packaged adapter availability', () => {
        expect(resolveHostedWebRuntimeDiagnostics({
            hostedWeb,
            endpointUrl: 'https://preview.happier.test/plugin/acme/',
            nowMs: 1_000,
        })).toEqual({
            state: 'ready',
            endpointUrl: 'https://preview.happier.test/plugin/acme/',
            diagnostics: [],
        });
    });

    it('reports absent bridge policy while still allowing a renderable endpoint', () => {
        expect(resolveHostedWebRuntimeDiagnostics({
            hostedWeb: {
                ...hostedWeb,
                bridge: { allowedMessages: [] },
            },
            endpointUrl: 'https://preview.happier.test/plugin/acme/',
            nowMs: 1_000,
        })).toEqual({
            state: 'ready',
            endpointUrl: 'https://preview.happier.test/plugin/acme/',
            diagnostics: ['hosted_web_bridge_policy_absent'],
        });
    });
});
