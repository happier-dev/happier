import { describe, expect, it } from 'vitest';

import { resolveBrowserAnnotationCaptureCapability } from './annotationCaptureCapability';

describe('resolveBrowserAnnotationCaptureCapability (ANNO-6 engine matrix)', () => {
    it('desktop Wry webview with capture support is full', () => {
        const cap = resolveBrowserAnnotationCaptureCapability({
            adapterKind: 'localPreview',
            primaryEngine: 'desktopWebView',
            desktopCaptureSupported: true,
        });
        expect(cap).toEqual({ available: true, fidelity: 'nativeCallback' });
    });

    it('desktop Wry webview WITHOUT capture support is disabled with a reason', () => {
        const cap = resolveBrowserAnnotationCaptureCapability({
            adapterKind: 'localPreview',
            primaryEngine: 'desktopWebView',
            desktopCaptureSupported: false,
        });
        expect(cap.available).toBe(false);
        expect(cap.available === false && cap.disabledReason).toBe('browser_context_annotation_capture_unavailable');
    });

    it('managed Chromium sidecar is gated: available only when the managed-capture gate is on', () => {
        const gatedOff = resolveBrowserAnnotationCaptureCapability({
            adapterKind: 'chromiumSidecar',
            primaryEngine: 'unavailable',
            managedCaptureGateEnabled: false,
        });
        expect(gatedOff.available).toBe(false);
        expect(gatedOff.available === false && gatedOff.disabledReason).toBe('browser_context_annotation_capture_unavailable');

        const gatedOn = resolveBrowserAnnotationCaptureCapability({
            adapterKind: 'chromiumSidecar',
            primaryEngine: 'unavailable',
            managedCaptureGateEnabled: true,
        });
        expect(gatedOn).toEqual({ available: true, fidelity: 'cdp' });
    });

    it('web iframe engine is disabled with an explicit reason (not silently hidden)', () => {
        const cap = resolveBrowserAnnotationCaptureCapability({
            adapterKind: 'externalUrl',
            primaryEngine: 'webIframe',
        });
        expect(cap.available).toBe(false);
        expect(cap.available === false && cap.disabledReason).toBe('browser_context_annotation_capture_unavailable');
    });

    it('react-native native webview engine is disabled with an explicit reason', () => {
        const cap = resolveBrowserAnnotationCaptureCapability({
            adapterKind: 'localPreview',
            primaryEngine: 'nativeWebView',
        });
        expect(cap.available).toBe(false);
        expect(cap.available === false && cap.disabledReason).toBe('browser_context_annotation_capture_unavailable');
    });

    it('simulator/streamed surfaces are disabled with an explicit reason', () => {
        for (const primaryEngine of ['streamedSurface', 'unavailable'] as const) {
            const cap = resolveBrowserAnnotationCaptureCapability({
                adapterKind: 'simulatorPreview',
                primaryEngine,
            });
            expect(cap.available).toBe(false);
        }
    });
});
