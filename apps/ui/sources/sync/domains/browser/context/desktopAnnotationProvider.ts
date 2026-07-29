import type { BrowserScreenshotMediaReferenceV1 } from '@happier-dev/protocol';

import {
    captureDesktopBrowserSnapshot,
    type DesktopBrowserCaptureSnapshotResult,
} from '@/sync/domains/browser/adapters/desktopWebViewBridge';

import { createBrowserAnnotationCaptureProvider } from './captureProvider';
import type { BrowserAnnotationCaptureProvider } from './types';

function decodeBase64ToBytes(base64: string): Uint8Array | null {
    try {
        if (typeof atob === 'function') {
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) {
                bytes[i] = binary.charCodeAt(i);
            }
            return bytes;
        }
        const globalBuffer = (globalThis as { Buffer?: { from(data: string, encoding: string): Uint8Array } }).Buffer;
        if (globalBuffer) {
            return new Uint8Array(globalBuffer.from(base64, 'base64'));
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Stable content-addressed media id from the captured bytes. The annotation `media` is a reference
 * (like `captureScreenshotReference`), not inline bytes; a deterministic id keyed off the capture
 * request + size keeps it dedupe-stable without embedding the pixels in the context payload.
 */
function buildMediaId(input: Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    capturedAtMs: number;
    sizeBytes: number;
}>): string {
    const segment = (value: string): string => value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 48);
    return [
        'browser_annotation_media',
        segment(input.browserSessionId),
        segment(input.viewId),
        input.navigationGeneration,
        input.capturedAtMs,
        input.sizeBytes,
    ].join('_');
}

/**
 * Production annotation capture provider for the desktop (Tauri/Wry) engine. Uses the native
 * `desktop_browser_capture_snapshot` command — the only first-party in-app screenshot producer
 * today — and registers the PNG bytes as a content-addressed media reference. `available` follows
 * the engine's `supports.capture` flag so the BrowserShell capture button is enabled exactly when a
 * real producer exists (honest fail-closed elsewhere; iframe/RN capture is out of scope — 12.20B).
 */
export function createDesktopBrowserAnnotationCaptureProvider(input: Readonly<{
    available: boolean;
    captureSnapshot?: typeof captureDesktopBrowserSnapshot;
}>): BrowserAnnotationCaptureProvider {
    const captureSnapshot = input.captureSnapshot ?? captureDesktopBrowserSnapshot;
    return createBrowserAnnotationCaptureProvider({
        available: input.available,
        captureScreenshot: async (request) => {
            const clip = request.cropClip?.devicePageRect ?? request.cropRect;
            const result: DesktopBrowserCaptureSnapshotResult = await captureSnapshot({
                browserSessionId: request.browserSessionId,
                viewId: request.viewId,
                navigationGeneration: request.navigationGeneration,
                captureRequestId: `annotation_capture:${request.browserSessionId}:${request.viewId}:${request.capturedAtMs}`,
                // ANNO-3: forward the union-of-targets crop so native returns the cropped media (not
                // the full page). Absent ⇒ full-frame capture.
                ...(clip ? { clip } : {}),
            });
            if (!result.ok || !result.snapshot) {
                const stale = result.errorCode === 'staleNavigation';
                return {
                    ok: false,
                    reasonCode: stale
                        ? 'navigation_stale'
                        : result.errorCode === 'captureFailed'
                            ? 'capture_failed'
                            : 'capture_unavailable',
                };
            }
            const bytes = decodeBase64ToBytes(result.snapshot.bytesBase64);
            if (!bytes) {
                return { ok: false, reasonCode: 'capture_failed' };
            }
            return {
                ok: true,
                snapshot: {
                    bytes,
                    mimeType: 'image/png',
                    width: result.snapshot.width,
                    height: result.snapshot.height,
                    sizeBytes: result.snapshot.sizeBytes,
                },
            };
        },
        registerMedia: ({ snapshot, browserSessionId, viewId, navigationGeneration, capturedAtMs }): BrowserScreenshotMediaReferenceV1 => ({
            mediaId: buildMediaId({ browserSessionId, viewId, navigationGeneration, capturedAtMs, sizeBytes: snapshot.sizeBytes }),
            mediaKind: 'image',
            width: snapshot.width,
            height: snapshot.height,
            sizeBytes: snapshot.sizeBytes,
        }),
    });
}
