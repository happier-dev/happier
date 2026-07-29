import { describe, expect, it } from 'vitest';

import { resolveHostedWebRuntimeDiagnostics } from './hostedWebRuntime';

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
    it('distinguishes static asset unavailability from preview expiry', () => {
        expect(resolveHostedWebRuntimeDiagnostics({
            hostedWeb,
            endpointUrl: null,
            nowMs: 1_000,
        })).toEqual({
            state: 'fallback',
            reason: 'static_asset_unavailable',
            diagnostics: ['hosted_web_static_asset_unavailable', 'hosted_web_fallback_rendering'],
        });

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

    it('distinguishes managed service startup and unhealthy phases', () => {
        expect(resolveHostedWebRuntimeDiagnostics({
            hostedWeb: {
                ...hostedWeb,
                service: { kind: 'managedService', serviceId: 'preview-dev-server' },
            },
            localService: {
                id: 'preview-dev-server',
                phase: 'starting',
                diagnostics: [],
            },
            nowMs: 1_000,
        })).toEqual({
            state: 'fallback',
            reason: 'managed_service_starting',
            diagnostics: ['hosted_web_managed_service_starting', 'hosted_web_fallback_rendering'],
        });

        expect(resolveHostedWebRuntimeDiagnostics({
            hostedWeb: {
                ...hostedWeb,
                service: { kind: 'managedService', serviceId: 'preview-dev-server' },
            },
            localService: {
                id: 'preview-dev-server',
                phase: 'unhealthy',
                diagnostics: [{ code: 'http_health_check_failed' }],
            },
            nowMs: 1_000,
        })).toEqual({
            state: 'fallback',
            reason: 'managed_service_unhealthy',
            diagnostics: [
                'hosted_web_managed_service_unhealthy',
                'http_health_check_failed',
                'hosted_web_fallback_rendering',
            ],
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
