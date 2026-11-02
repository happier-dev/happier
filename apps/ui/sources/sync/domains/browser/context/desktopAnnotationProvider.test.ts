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
// The native WebView bridge is an OS boundary. Each case supplies its native capture outcome.
vi.mock('@/sync/domains/browser/adapters/desktopWebViewBridge', () => ({ captureDesktopBrowserSnapshot: vi.fn() }));

describe('desktop browser annotation capture provider', () => {
    it('returns the source privacy refusal without registering pixels as media', async () => {
        const provider = createDesktopBrowserAnnotationCaptureProvider({
            available: true,
            captureSnapshot: async () => ({ ok: false, availability: { available: true } as never,
                errorCode: 'sensitiveFieldsPresent' }),
        });
        expect(await provider.captureViewport!(request)).toMatchObject({ status: 'unavailable',
            reason: { reasonCode: 'browser_context_sensitive_fields_present', lifecycleState: 'sensitiveFieldsPresent' } });
    });
    it('captures one full viewport for authoring without requiring an original-image uploader', async () => {
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
                scaleFactor: 2,
                width: 1024,
                height: 768,
                sizeBytes: 65_536,
                bytesBase64: pngBase64,
            },
        }));
        const provider = createDesktopBrowserAnnotationCaptureProvider({ available: true, captureSnapshot });
        expect(provider.available).toBe(true);
        const result = await provider.captureViewport!(request);
        expect(result).toMatchObject({ status: 'captured', source: { uri: `data:image/png;base64,${pngBase64}`, width: 1024, height: 768, scale: 2 } });
        expect(captureSnapshot).toHaveBeenCalledTimes(1);
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
        });
        const result = await provider.captureViewport!(request);
        expect(result.status).toBe('unavailable');
        if (result.status !== 'unavailable') return;
        expect(result.reason?.lifecycleState).toBe('navigationStale');
    });

    it('is unavailable when the engine reports no capture support', async () => {
        const provider = createDesktopBrowserAnnotationCaptureProvider({ available: false });
        expect(provider.available).toBe(false);
        const result = await provider.captureViewport!(request);
        expect(result.status).toBe('unavailable');
    });
});
