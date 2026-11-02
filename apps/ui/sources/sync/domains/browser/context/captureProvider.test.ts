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
    it('acquires one full viewport source before authoring without uploading the original pixels', async () => {
        const captureScreenshot = vi.fn((_request: BrowserAnnotationCaptureRequest) => ({ ok: true as const, snapshot: {
            bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' as const,
            width: 1200, height: 800, sizeBytes: 4,
        } }));
        const provider = createBrowserAnnotationCaptureProvider({ captureScreenshot });
        const result = await provider.captureViewport!(request);
        expect(result).toMatchObject({ status: 'captured', source: {
            uri: 'data:image/png;base64,iVBORw==', width: 1200, height: 800, scale: 1,
        }, pageUrl: request.currentUrl, pageTitle: request.title });
        expect(captureScreenshot).toHaveBeenCalledTimes(1);
    });
    it('is unavailable (button disabled) when no producer exists', async () => {
        const provider = createBrowserAnnotationCaptureProvider({
            captureScreenshot: () => ({ ok: false, reasonCode: 'capture_unavailable' }),
            available: false,
        });
        expect(provider.available).toBe(false);
        const result = await provider.captureViewport!(request);
        expect(result.status).toBe('unavailable');
    });

    it('reports a typed failure when the engine capture fails', async () => {
        const provider = createBrowserAnnotationCaptureProvider({
            captureScreenshot: () => ({ ok: false, reasonCode: 'capture_failed' }),
        });
        const result = await provider.captureViewport!(request);
        expect(result).toMatchObject({
            status: 'unavailable',
            reason: { reasonCode: 'browser_context_annotation_capture_failed' },
        });
    });

});
