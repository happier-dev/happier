import { resolveBrowserContextPrivacyDenial } from '@happier-dev/protocol/browser/context/privacy';
import type { BrowserScreenshotMediaReferenceV1 } from '@happier-dev/protocol/browser/context/v1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { ImageAnnotationSource } from '@/components/ui/media/annotation/types';

import type {
    BrowserAnnotationCaptureProvider,
    BrowserAnnotationCaptureRequest,
    BrowserContextUnavailableReason,
} from './types';

export type BrowserAnnotationViewportCaptureResult =
    | Readonly<{ status: 'captured'; source: ImageAnnotationSource;
        capture: BrowserAnnotationScreenshotSnapshot | BrowserScreenshotMediaReferenceV1;
        pageUrl?: string; pageTitle?: string; dispose?: () => void | Promise<void> }>
    | Readonly<{ status: 'unavailable'; reason: BrowserContextUnavailableReason }>;

/**
 * Process-local source bytes from an engine-native producer. They are never published as an
 * attachment: Attach hands only the flattened PNG to the ordinary image upload owner.
 */
export type BrowserAnnotationScreenshotSnapshot = Readonly<{
    bytes: Uint8Array;
    mimeType: 'image/png';
    width: number;
    height: number;
    scale?: number;
    sizeBytes: number;
}>;

export type BrowserAnnotationScreenshotSource =
    | Readonly<{ ok: true; snapshot: BrowserAnnotationScreenshotSnapshot }>
    | Readonly<{ ok: false; reasonCode: 'capture_unavailable' | 'capture_failed' | 'navigation_stale' | 'sensitive_fields_present' }>;

/**
 * Acquires the full viewport once, exposing a canvas-safe source from bytes already read.
 */
export function createBrowserAnnotationCaptureProvider(input: Readonly<{
    captureScreenshot: (
        request: BrowserAnnotationCaptureRequest,
    ) => Promise<BrowserAnnotationScreenshotSource> | BrowserAnnotationScreenshotSource;
    available?: boolean;
}>): BrowserAnnotationCaptureProvider {
    const available = input.available ?? true;

    return {
        available,
        async captureViewport(request): Promise<BrowserAnnotationViewportCaptureResult> {
            if (!available) return { status: 'unavailable', reason: {
                reasonCode: 'browser_context_annotation_capture_unavailable', lifecycleState: 'adapterUnavailable',
                message: 'Browser annotation capture is unavailable for this view.',
            } };
            const captured = await input.captureScreenshot(request);
            if (!captured.ok) return { status: 'unavailable', reason: captured.reasonCode === 'sensitive_fields_present'
                ? { ...resolveBrowserContextPrivacyDenial('sensitiveFieldsPresent')!, message: 'Browser context is unavailable while sensitive fields are present.' }
                : { reasonCode: captured.reasonCode === 'capture_failed' ? 'browser_context_annotation_capture_failed' : 'browser_context_annotation_capture_unavailable',
                    lifecycleState: captured.reasonCode === 'navigation_stale' ? 'navigationStale' : captured.reasonCode === 'capture_failed' ? 'captureFailed' : 'adapterUnavailable',
                    message: 'Browser annotation capture is unavailable for this view.' } };
            const snapshot = captured.snapshot;
            return { status: 'captured', capture: snapshot,
                source: { uri: `data:image/png;base64,${encodeBase64(snapshot.bytes)}`, width: snapshot.width, height: snapshot.height, scale: snapshot.scale ?? 1 },
                ...(request.currentUrl ? { pageUrl: request.currentUrl } : {}), ...(request.title ? { pageTitle: request.title } : {}) };
        },
    };
}
