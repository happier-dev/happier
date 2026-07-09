import { describe, expect, it, vi } from 'vitest';

import { resolveHostedWebRuntimeEndpoint } from './hostedWeb';

describe('hosted-web runtime context resolution', () => {
    it('uses only LSV preview access URLs for installed static assets instead of exposing raw loopback URLs', async () => {
        await expect(resolveHostedWebRuntimeEndpoint({
            runtimeMode: {
                kind: 'installedStaticAssets',
                artifactId: 'preview-web-static',
                assetRootId: 'hosted-web/preview-web',
            },
            preview: {
                accessUrl: 'https://preview.happier.test/plugin/acme/',
                expiresAt: 2_000,
            },
            nowMs: () => 1_000,
        })).resolves.toEqual({
            state: 'ready',
            endpointUrl: 'https://preview.happier.test/plugin/acme/',
            expiresAt: 2_000,
            diagnostics: [],
        });

        await expect(resolveHostedWebRuntimeEndpoint({
            runtimeMode: {
                kind: 'installedStaticAssets',
                artifactId: 'preview-web-static',
                assetRootId: 'hosted-web/preview-web',
            },
            nowMs: () => 1_000,
        })).resolves.toEqual({
            state: 'fallback',
            reason: 'static_asset_unavailable',
            diagnostics: ['static_asset_preview_access_url_unavailable'],
        });
    });

    it('starts managed services only through localServices and reports unavailable substrate diagnostics', async () => {
        const start = vi.fn(async () => ({
            snapshot: () => ({
                id: 'preview-dev-server',
                phase: 'failed' as const,
                diagnostics: [{
                    code: 'PLUGIN_LOCAL_SERVICE_SUBSTRATE_UNAVAILABLE',
                    severity: 'warning' as const,
                }],
            }),
            stop: async () => {},
        }));
        const localServices = {
            declare: vi.fn(async () => {}),
            start,
            get: vi.fn(async () => null),
        };

        await expect(resolveHostedWebRuntimeEndpoint({
            runtimeMode: {
                kind: 'managedLocalService',
                localServiceId: 'preview-dev-server',
            },
            localServices,
            nowMs: () => 1_000,
        })).resolves.toEqual({
            state: 'fallback',
            reason: 'managed_service_unavailable',
            diagnostics: ['PLUGIN_LOCAL_SERVICE_SUBSTRATE_UNAVAILABLE'],
        });

        expect(start).toHaveBeenCalledWith('preview-dev-server');
    });

    it('uses managed local-service access URLs after daemon preview correlation', async () => {
        const start = vi.fn(async () => ({
            snapshot: () => ({
                id: 'preview-dev-server',
                phase: 'running' as const,
                inventoryId: 'machine-a:tcp:loopback:127.0.0.1:5173:pid-400',
                port: 5173,
                url: 'https://preview.happier.test/v1/local-services/preview/plugin-web/',
                diagnostics: [],
            }),
            stop: async () => {},
        }));

        await expect(resolveHostedWebRuntimeEndpoint({
            runtimeMode: {
                kind: 'managedLocalService',
                localServiceId: 'preview-dev-server',
            },
            localServices: {
                declare: vi.fn(async () => {}),
                start,
                get: vi.fn(async () => null),
            },
            nowMs: () => 1_000,
        })).resolves.toEqual({
            state: 'ready',
            endpointUrl: 'https://preview.happier.test/v1/local-services/preview/plugin-web/',
            expiresAt: null,
            diagnostics: [],
        });
    });

    it('resolves registered session endpoints through the preview endpoint owner', async () => {
        const resolve = vi.fn(async (endpointIdPath: string) => {
            expect(endpointIdPath).toBe('/preview/id');
            return {
                accessUrl: 'https://preview.happier.test/plugin/acme/',
                expiresAt: 2_000,
            };
        });

        await expect(resolveHostedWebRuntimeEndpoint({
            runtimeMode: {
                kind: 'registeredSessionEndpoint',
                endpointIdPath: '/preview/id',
            },
            registeredEndpointPreview: { resolve },
            nowMs: () => 1_000,
        })).resolves.toEqual({
            state: 'ready',
            endpointUrl: 'https://preview.happier.test/plugin/acme/',
            expiresAt: 2_000,
            diagnostics: [],
        });

        expect(resolve).toHaveBeenCalledOnce();
    });

    it('classifies expired registered endpoint previews separately from unavailable endpoints', async () => {
        await expect(resolveHostedWebRuntimeEndpoint({
            runtimeMode: {
                kind: 'registeredSessionEndpoint',
                endpointIdPath: '/preview/id',
            },
            preview: {
                accessUrl: 'https://preview.happier.test/plugin/acme/',
                expiresAt: 900,
            },
            nowMs: () => 1_000,
        })).resolves.toEqual({
            state: 'fallback',
            reason: 'preview_expired',
            diagnostics: ['hosted_web_preview_expired'],
        });
    });
});
