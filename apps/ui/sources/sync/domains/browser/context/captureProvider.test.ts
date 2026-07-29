import { describe, expect, it, vi } from 'vitest';

import { createBrowserAnnotationCaptureProvider } from './captureProvider';
import type { BrowserAnnotationCaptureRequest } from './types';

const request: BrowserAnnotationCaptureRequest = {
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    navigationGeneration: 3,
    capturedAtMs: 1_000,
    adapterKind: 'externalUrl',
    browserTarget: { kind: 'externalUrl', url: 'https://example.test', targetId: 'target_1' },
    currentUrl: 'https://example.test/page',
    title: 'Example',
    securityOrigin: 'https://example.test',
};

describe('browser annotation capture provider', () => {
    it('captures a region draft from the engine snapshot and host-registered media', async () => {
        const registerMedia = vi.fn(async () => ({
            mediaId: 'media_annotation_capture_1',
            mediaKind: 'image' as const,
            width: 1280,
            height: 720,
            sizeBytes: 240_000,
        }));
        const provider = createBrowserAnnotationCaptureProvider({
            captureScreenshot: async () => ({
                ok: true,
                snapshot: {
                    bytes: new Uint8Array([1, 2, 3, 4]),
                    mimeType: 'image/png',
                    width: 1280,
                    height: 720,
                    sizeBytes: 240_000,
                },
            }),
            registerMedia,
        });

        expect(provider.available).toBe(true);
        const result = await provider.captureAnnotation(request);
        expect(result).toMatchObject({
            status: 'captured',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 3,
            media: { mediaId: 'media_annotation_capture_1' },
            target: { kind: 'region', rect: { x: 0, y: 0, width: 1280, height: 720 } },
            pageUrl: 'https://example.test/page',
            pageTitle: 'Example',
        });
        expect(registerMedia).toHaveBeenCalledWith(expect.objectContaining({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 3,
        }));
    });

    it('is unavailable (button disabled) when no producer exists', async () => {
        const provider = createBrowserAnnotationCaptureProvider({
            captureScreenshot: () => ({ ok: false, reasonCode: 'capture_unavailable' }),
            registerMedia: () => null,
            available: false,
        });
        expect(provider.available).toBe(false);
        const result = await provider.captureAnnotation(request);
        expect(result.status).toBe('unavailable');
    });

    it('reports a typed failure when the engine capture fails', async () => {
        const provider = createBrowserAnnotationCaptureProvider({
            captureScreenshot: () => ({ ok: false, reasonCode: 'capture_failed' }),
            registerMedia: () => null,
        });
        const result = await provider.captureAnnotation(request);
        expect(result).toMatchObject({
            status: 'unavailable',
            reason: { reasonCode: 'browser_context_annotation_capture_failed' },
        });
    });

    it('fails closed when captured bytes cannot be registered as media', async () => {
        const provider = createBrowserAnnotationCaptureProvider({
            captureScreenshot: async () => ({
                ok: true,
                snapshot: { bytes: new Uint8Array([9]), mimeType: 'image/png', width: 10, height: 10, sizeBytes: 1 },
            }),
            registerMedia: () => null,
        });
        const result = await provider.captureAnnotation(request);
        expect(result).toMatchObject({
            status: 'unavailable',
            reason: { reasonCode: 'browser_context_annotation_capture_failed' },
        });
    });
});
