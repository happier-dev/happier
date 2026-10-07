import { describe, expect, it, vi } from 'vitest';

import { createDesktopBrowserAnnotationCaptureProvider } from './desktopAnnotationProvider';
import type { BrowserAnnotationCaptureRequest } from './types';

const request: BrowserAnnotationCaptureRequest = {
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    navigationGeneration: 2,
    capturedAtMs: 1_000,
    adapterKind: 'externalUrl',
    browserTarget: { kind: 'externalUrl', url: 'https://example.test', targetId: 'target_1' },
    currentUrl: 'https://example.test/page',
    title: 'Example',
    securityOrigin: 'https://example.test',
};

const pngBase64 = Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47])).toString('base64');
const storedSnapshotMedia = ({ snapshot }: { snapshot: { width: number; height: number; sizeBytes: number } }) => ({
    mediaId: 'stored-snapshot', mediaKind: 'image' as const, width: snapshot.width, height: snapshot.height, sizeBytes: snapshot.sizeBytes,
});

// The native WebView bridge is an OS boundary. Each case supplies its native capture outcome.
vi.mock('@/sync/domains/browser/adapters/desktopWebViewBridge', () => ({ captureDesktopBrowserSnapshot: vi.fn() }));

describe('desktop browser annotation capture provider', () => {
    it('returns the source privacy refusal without registering pixels as media', async () => {
        const registerMedia = vi.fn(storedSnapshotMedia);
        const provider = createDesktopBrowserAnnotationCaptureProvider({
            available: true,
            captureSnapshot: async () => ({ ok: false, availability: { available: true } as never,
                errorCode: 'sensitiveFieldsPresent' }),
            registerMedia,
        });
        expect(await provider.captureAnnotation(request)).toMatchObject({ status: 'unavailable',
            reason: { reasonCode: 'browser_context_sensitive_fields_present', lifecycleState: 'sensitiveFieldsPresent' } });
        expect(registerMedia).not.toHaveBeenCalled();
    });
    it('captures the native snapshot and returns only the persisted media reference', async () => {
        const captureSnapshot = vi.fn(async () => ({
            ok: true as const,
            availability: { available: true } as never,
            snapshot: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 2,
                captureRequestId: 'req_1',
                capturedAtMs: 1_000,
                mimeType: 'image/png' as const,
                width: 1024,
                height: 768,
                sizeBytes: 65_536,
                bytesBase64: pngBase64,
            },
        }));
        // The registrar is the attachment transfer boundary, not a second media-id owner.
        const storedMedia = { mediaId: 'persisted-media', mediaKind: 'image' as const, width: 1024, height: 768, sizeBytes: 65_536 };
        const registerMedia = vi.fn(async () => storedMedia);
        const provider = createDesktopBrowserAnnotationCaptureProvider({ available: true, captureSnapshot, registerMedia });
        expect(provider.available).toBe(true);

        const result = await provider.captureAnnotation(request);
        expect(result).toMatchObject({
            status: 'captured',
            media: { mediaKind: 'image', width: 1024, height: 768, sizeBytes: 65_536 },
            target: { kind: 'region', rect: { x: 0, y: 0, width: 1024, height: 768 } },
            pageUrl: 'https://example.test/page',
            pageTitle: 'Example',
        });
        if (result.status !== 'captured') return;
        expect(result.media).toEqual(storedMedia);
        expect(registerMedia).toHaveBeenCalledWith(expect.objectContaining({
            snapshot: expect.objectContaining({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }),
        }));
        expect(captureSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 2,
        }));
    });

    it('refuses successful capture when the bytes cannot be persisted', async () => {
        const provider = createDesktopBrowserAnnotationCaptureProvider({
            available: true,
            captureSnapshot: async () => ({
                ok: true,
                availability: { available: true } as never,
                snapshot: { browserSessionId: request.browserSessionId, viewId: request.viewId,
                    navigationGeneration: 2, captureRequestId: 'req', capturedAtMs: 1000,
                    mimeType: 'image/png', width: 10, height: 10, sizeBytes: 4, bytesBase64: pngBase64 },
            }),
            registerMedia: async () => null,
        });
        expect(await provider.captureAnnotation(request)).toMatchObject({ status: 'unavailable', reason: { lifecycleState: 'captureFailed' } });
    });

    it('forwards the union-of-targets crop clip and returns cropped media (ANNO-3)', async () => {
        // Native crops to the device clip → snapshot dims are the crop, not the full page.
        const captureSnapshot = vi.fn(async () => ({
            ok: true as const,
            availability: { available: true } as never,
            snapshot: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 2,
                captureRequestId: 'req_1',
                capturedAtMs: 1_000,
                mimeType: 'image/png' as const,
                width: 120,
                height: 100,
                sizeBytes: 4_096,
                bytesBase64: pngBase64,
            },
        }));
        const provider = createDesktopBrowserAnnotationCaptureProvider({ available: true, captureSnapshot, registerMedia: storedSnapshotMedia });

        const result = await provider.captureAnnotation({
            ...request,
            cropRect: { x: 20, y: 20, width: 120, height: 100 },
        });

        // The crop rect is forwarded to the native command as the capture clip.
        expect(captureSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            clip: { x: 20, y: 20, width: 120, height: 100 },
        }));
        // The captured media + region target cover the crop, not the full page.
        expect(result).toMatchObject({
            status: 'captured',
            media: { mediaKind: 'image', width: 120, height: 100 },
            target: { kind: 'region', rect: { x: 0, y: 0, width: 120, height: 100 } },
        });
    });

    it('captures full-frame (no clip) when no crop rect is supplied', async () => {
        const captureSnapshot = vi.fn(async () => ({
            ok: true as const,
            availability: { available: true } as never,
            snapshot: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 2,
                captureRequestId: 'req_1',
                capturedAtMs: 1_000,
                mimeType: 'image/png' as const,
                width: 1024,
                height: 768,
                sizeBytes: 65_536,
                bytesBase64: pngBase64,
            },
        }));
        const provider = createDesktopBrowserAnnotationCaptureProvider({ available: true, captureSnapshot, registerMedia: storedSnapshotMedia });
        await provider.captureAnnotation(request);
        // No crop rect supplied ⇒ the native command is invoked without a clip (full-frame capture).
        expect(captureSnapshot).toHaveBeenCalledWith(expect.not.objectContaining({ clip: expect.anything() }));
    });

    it('maps a stale-navigation snapshot result to a navigation-stale reason', async () => {
        const provider = createDesktopBrowserAnnotationCaptureProvider({
            available: true,
            captureSnapshot: async () => ({
                ok: false as const,
                availability: { available: true } as never,
                errorCode: 'staleNavigation' as const,
            }),
            registerMedia: storedSnapshotMedia,
        });
        const result = await provider.captureAnnotation(request);
        expect(result.status).toBe('unavailable');
        if (result.status !== 'unavailable') return;
        expect(result.reason?.lifecycleState).toBe('navigationStale');
    });

    it('is unavailable when the engine reports no capture support', async () => {
        const provider = createDesktopBrowserAnnotationCaptureProvider({ available: false });
        expect(provider.available).toBe(false);
        const result = await provider.captureAnnotation(request);
        expect(result.status).toBe('unavailable');
    });
});
