import {
    captureDesktopBrowserSnapshot,
    type DesktopBrowserCaptureSnapshotResult,
} from '@/sync/domains/browser/adapters/desktopWebViewBridge';

import { createBrowserAnnotationCaptureProvider, type BrowserAnnotationMediaRegistrar } from './captureProvider';
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
 * `desktop_browser_capture_snapshot` command and registers its PNG through the Session attachment
 * owner. Availability requires both native capture and a persistence registrar. Managed CDP has
 * its separate capture adapter; iframe/RN native snapshot capture remains unsupported.
 */
export function createDesktopBrowserAnnotationCaptureProvider(input: Readonly<{
    available: boolean;
    captureSnapshot?: typeof captureDesktopBrowserSnapshot;
    registerMedia?: BrowserAnnotationMediaRegistrar;
}>): BrowserAnnotationCaptureProvider {
    const captureSnapshot = input.captureSnapshot ?? captureDesktopBrowserSnapshot;
    return createBrowserAnnotationCaptureProvider({
        available: input.available && Boolean(input.registerMedia),
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
                    sizeBytes: result.snapshot.sizeBytes,
                },
            };
        },
        registerMedia: input.registerMedia ?? (() => null),
    });
}
