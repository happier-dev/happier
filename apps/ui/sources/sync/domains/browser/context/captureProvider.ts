import type { BrowserScreenshotMediaReferenceV1 } from '@happier-dev/protocol';

import type {
    BrowserAnnotationCaptureProvider,
    BrowserAnnotationCaptureProviderResult,
    BrowserAnnotationCaptureRequest,
} from './types';

/**
 * A captured screenshot snapshot from an engine-native producer (desktop Wry capture today; a CDP
 * screencast producer later). Holds the raw PNG bytes + dimensions — NOT a context item; the
 * provider converts it into a media reference by handing the bytes to the host media registrar.
 */
export type BrowserAnnotationScreenshotSnapshot = Readonly<{
    bytes: Uint8Array;
    mimeType: 'image/png';
    width: number;
    height: number;
    sizeBytes: number;
}>;

export type BrowserAnnotationScreenshotSource =
    | Readonly<{ ok: true; snapshot: BrowserAnnotationScreenshotSnapshot }>
    | Readonly<{ ok: false; reasonCode: 'capture_unavailable' | 'capture_failed' | 'navigation_stale' }>;

/**
 * Host-supplied media registrar. Registers the captured PNG bytes as an attachable media artifact
 * (the composer attachment-upload pipeline) and returns the reference metadata the annotation item
 * carries. The registrar owns the bytes→`mediaId` mapping so the provider stays media-transport
 * agnostic and the context domain does not depend on the composer attachment manager directly.
 */
export type BrowserAnnotationMediaRegistrar = (
    input: Readonly<{
        snapshot: BrowserAnnotationScreenshotSnapshot;
        browserSessionId: string;
        viewId: string;
        navigationGeneration: number;
        capturedAtMs: number;
    }>,
) => Promise<BrowserScreenshotMediaReferenceV1 | null> | BrowserScreenshotMediaReferenceV1 | null;

/**
 * Builds the in-app annotation capture provider from an engine screenshot source + a host media
 * registrar. `available` is true only when both are present (a real producer exists); otherwise the
 * BrowserShell capture button stays disabled (honest fail-closed — no fabricated media). On capture,
 * it snapshots the active view, registers the bytes as media, and returns a region-target draft
 * bound to the current navigation generation (stale guards live in the attach owner).
 */
export function createBrowserAnnotationCaptureProvider(input: Readonly<{
    captureScreenshot: (
        request: BrowserAnnotationCaptureRequest,
    ) => Promise<BrowserAnnotationScreenshotSource> | BrowserAnnotationScreenshotSource;
    registerMedia: BrowserAnnotationMediaRegistrar;
    available?: boolean;
}>): BrowserAnnotationCaptureProvider {
    const available = input.available ?? true;

    return {
        available,
        async captureAnnotation(
            request: BrowserAnnotationCaptureRequest,
        ): Promise<BrowserAnnotationCaptureProviderResult> {
            if (!available) {
                return {
                    status: 'unavailable',
                    reason: {
                        reasonCode: 'browser_context_annotation_capture_unavailable',
                        lifecycleState: 'adapterUnavailable',
                        message: 'Browser annotation capture is unavailable for this view.',
                    },
                };
            }

            const captured = await input.captureScreenshot(request);
            if (!captured.ok) {
                const failed = captured.reasonCode === 'capture_failed';
                return {
                    status: 'unavailable',
                    reason: {
                        reasonCode: failed
                            ? 'browser_context_annotation_capture_failed'
                            : 'browser_context_annotation_capture_unavailable',
                        lifecycleState: captured.reasonCode === 'navigation_stale' ? 'navigationStale' : (failed ? 'captureFailed' : 'adapterUnavailable'),
                        message: failed
                            ? 'Browser annotation capture failed.'
                            : 'Browser annotation capture is unavailable for this view.',
                    },
                };
            }

            const media = await input.registerMedia({
                snapshot: captured.snapshot,
                browserSessionId: request.browserSessionId,
                viewId: request.viewId,
                navigationGeneration: request.navigationGeneration,
                capturedAtMs: request.capturedAtMs,
            });
            if (!media) {
                return {
                    status: 'unavailable',
                    reason: {
                        reasonCode: 'browser_context_annotation_capture_failed',
                        lifecycleState: 'captureFailed',
                        message: 'Browser annotation capture could not be stored as media.',
                    },
                };
            }

            return {
                status: 'captured',
                browserSessionId: request.browserSessionId,
                viewId: request.viewId,
                navigationGeneration: request.navigationGeneration,
                capturedAtMs: request.capturedAtMs,
                media,
                target: {
                    kind: 'region',
                    rect: { x: 0, y: 0, width: captured.snapshot.width, height: captured.snapshot.height },
                },
                ...(request.currentUrl ? { pageUrl: request.currentUrl } : {}),
                ...(request.title ? { pageTitle: request.title } : {}),
            };
        },
    };
}
