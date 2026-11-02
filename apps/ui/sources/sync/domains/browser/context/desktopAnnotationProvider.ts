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
 * Production annotation capture provider for the desktop (Tauri/Wry) engine. Uses the native
 * `desktop_browser_capture_snapshot` command without uploading the original pixels. Availability
 * follows native capture. Managed CDP has its own source adapter; iframe/RN snapshot capture remains unsupported.
 */
export function createDesktopBrowserAnnotationCaptureProvider(input: Readonly<{
    available: boolean;
    captureSnapshot?: typeof captureDesktopBrowserSnapshot;
}>): BrowserAnnotationCaptureProvider {
    const captureSnapshot = input.captureSnapshot ?? captureDesktopBrowserSnapshot;
    return createBrowserAnnotationCaptureProvider({
        available: input.available,
        captureScreenshot: async (request) => {
            const result: DesktopBrowserCaptureSnapshotResult = await captureSnapshot({
                browserSessionId: request.browserSessionId,
                viewId: request.viewId,
                navigationGeneration: request.navigationGeneration,
                captureRequestId: `annotation_capture:${request.browserSessionId}:${request.viewId}:${request.capturedAtMs}`,
            });
            if (!result.ok || !result.snapshot) {
                const stale = result.errorCode === 'staleNavigation';
                return {
                    ok: false,
                    reasonCode: result.errorCode === 'sensitiveFieldsPresent'
                        ? 'sensitive_fields_present'
                        : stale
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
                    scale: result.snapshot.scaleFactor,
                    sizeBytes: result.snapshot.sizeBytes,
                },
            };
        },
    });
}
