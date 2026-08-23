import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveAnnotationCropClip } from '@/sync/domains/browser/context/annotationCropGeometry';

const invokeDesktopHostMock = vi.hoisted(() => vi.fn());
const isDesktopHostMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/platform/desktopHost', () => ({
    invokeDesktopHost: (command: string, args?: Record<string, unknown>) => invokeDesktopHostMock(command, args),
    isDesktopHost: () => isDesktopHostMock(),
}));

describe('desktop WebView native bridge', () => {
    beforeEach(() => {
        invokeDesktopHostMock.mockReset();
        isDesktopHostMock.mockReset();
    });

    it('fails closed without invoking native commands outside Tauri desktop', async () => {
        isDesktopHostMock.mockReturnValue(false);
        const mod = await import('./desktopWebViewBridge');

        await expect(mod.readDesktopWebViewNativeAvailability()).resolves.toEqual({
            available: false,
            platform: 'unsupported',
            primitive: 'disabled',
            renderEngine: 'unavailable',
            producer: 'none',
            privilegedIpc: false,
            supports: {
                navigation: false,
                goBackForward: false,
                reload: false,
                stop: false,
                pageInfoDiagnostics: false,
                nativeDevtools: false,
                capture: false,
                recording: false,
                automation: false,
            },
            disabledReasons: ['tauri_host_unavailable'],
        });
        expect(invokeDesktopHostMock).not.toHaveBeenCalled();
    });

    it('returns the typed native availability payload from the Tauri browser command', async () => {
        isDesktopHostMock.mockReturnValue(true);
        invokeDesktopHostMock.mockResolvedValue({
            available: false,
            platform: 'linuxWayland',
            primitive: 'linuxWaylandGtkEmbedding',
            renderEngine: 'unavailable',
            producer: 'none',
            privilegedIpc: false,
            supports: {
                navigation: false,
                goBackForward: false,
                reload: false,
                stop: false,
                pageInfoDiagnostics: false,
                nativeDevtools: false,
                capture: false,
                recording: false,
                automation: false,
            },
            disabledReasons: ['desktop_webview_wayland_gtk_unimplemented'],
        });
        const mod = await import('./desktopWebViewBridge');

        await expect(mod.readDesktopWebViewNativeAvailability()).resolves.toMatchObject({
            available: false,
            platform: 'linuxWayland',
            primitive: 'linuxWaylandGtkEmbedding',
            disabledReasons: ['desktop_webview_wayland_gtk_unimplemented'],
        });
        expect(invokeDesktopHostMock).toHaveBeenCalledWith('desktop_browser_get_availability', undefined);
    });

    it('downgrades malformed native available payloads instead of advertising desktop browsing', async () => {
        isDesktopHostMock.mockReturnValue(true);
        invokeDesktopHostMock.mockResolvedValue({
            available: true,
            platform: 'macos',
            primitive: 'macosNsViewWebKit',
            renderEngine: 'desktopWebView',
            producer: 'none',
            privilegedIpc: true,
            supports: {
                navigation: true,
                goBackForward: true,
                reload: true,
                stop: true,
                pageInfoDiagnostics: true,
                nativeDevtools: true,
                capture: true,
                recording: true,
                automation: true,
            },
            disabledReasons: [],
        });
        const mod = await import('./desktopWebViewBridge');

        await expect(mod.readDesktopWebViewNativeAvailability()).resolves.toMatchObject({
            available: false,
            renderEngine: 'unavailable',
            producer: 'none',
            privilegedIpc: false,
            disabledReasons: ['desktop_webview_native_contract_invalid'],
        });
    });

    it('rejects native availability payloads that advertise capture on unsupported desktop platforms', async () => {
        isDesktopHostMock.mockReturnValue(true);
        invokeDesktopHostMock.mockResolvedValue({
            available: true,
            platform: 'windows',
            primitive: 'windowsHwndWebView2',
            renderEngine: 'desktopWebView',
            producer: 'tauriWryNativeChildView',
            privilegedIpc: false,
            supports: {
                navigation: true,
                goBackForward: false,
                reload: false,
                stop: false,
                pageInfoDiagnostics: true,
                nativeDevtools: false,
                capture: true,
                recording: false,
                automation: false,
            },
            disabledReasons: [],
        });
        const mod = await import('./desktopWebViewBridge');

        await expect(mod.readDesktopWebViewNativeAvailability()).resolves.toMatchObject({
            available: false,
            platform: 'windows',
            primitive: 'windowsHwndWebView2',
            renderEngine: 'unavailable',
            producer: 'none',
            privilegedIpc: false,
            supports: {
                capture: false,
                recording: false,
                automation: false,
            },
            disabledReasons: ['desktop_webview_native_contract_invalid'],
        });
    });

    it('accepts injected reload/stop support on a backed desktop WebView (capability-truth flip ready)', async () => {
        // The §5-gated Wry-injection verification can flip the native reload/stop bits true; the
        // TS contract must accept that shape (recording/automation still false) and preserve the bits.
        isDesktopHostMock.mockReturnValue(true);
        invokeDesktopHostMock.mockResolvedValue({
            available: true,
            platform: 'macos',
            primitive: 'macosNsViewWebKit',
            renderEngine: 'desktopWebView',
            producer: 'tauriWryNativeChildView',
            privilegedIpc: false,
            supports: {
                navigation: true,
                goBackForward: false,
                reload: true,
                stop: true,
                pageInfoDiagnostics: true,
                nativeDevtools: false,
                capture: false,
                recording: false,
                automation: false,
            },
            disabledReasons: [],
        });
        const mod = await import('./desktopWebViewBridge');

        await expect(mod.readDesktopWebViewNativeAvailability()).resolves.toMatchObject({
            available: true,
            renderEngine: 'desktopWebView',
            producer: 'tauriWryNativeChildView',
            supports: {
                navigation: true,
                reload: true,
                stop: true,
                recording: false,
                automation: false,
            },
            disabledReasons: [],
        });
    });

    it('fails browser view commands closed outside Tauri desktop without invoking native IPC', async () => {
        isDesktopHostMock.mockReturnValue(false);
        const mod = await import('./desktopWebViewBridge');

        await expect(mod.openDesktopBrowserView({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            profileId: 'profile_1',
            url: 'https://example.com/',
        })).resolves.toMatchObject({
            ok: false,
            availability: {
                available: false,
                disabledReasons: ['tauri_host_unavailable'],
            },
        });
        await expect(mod.navigateDesktopBrowserView({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            url: 'https://example.com/docs',
        })).resolves.toMatchObject({
            ok: false,
            availability: {
                available: false,
                disabledReasons: ['tauri_host_unavailable'],
            },
        });
        await expect(mod.setDesktopBrowserViewBounds({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            visible: true,
            rect: {
                x: 1,
                y: 2,
                width: 800,
                height: 600,
                scaleFactor: 2,
            },
        })).resolves.toMatchObject({
            ok: false,
            availability: {
                available: false,
                disabledReasons: ['tauri_host_unavailable'],
            },
        });
        await expect(mod.setDesktopBrowserPointerPassthrough({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            ignore: true,
        })).resolves.toMatchObject({
            ok: false,
            availability: {
                available: false,
                disabledReasons: ['tauri_host_unavailable'],
            },
        });
        await expect(mod.closeDesktopBrowserView({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        })).resolves.toMatchObject({
            ok: false,
            availability: {
                available: false,
                disabledReasons: ['tauri_host_unavailable'],
            },
        });
        await expect(mod.openDesktopBrowserDevtools({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        })).resolves.toMatchObject({
            ok: false,
            availability: {
                available: false,
                disabledReasons: ['tauri_host_unavailable'],
            },
        });

        expect(invokeDesktopHostMock).not.toHaveBeenCalled();
    });

    it('fails desktop WebView snapshot capture closed outside Tauri desktop without invoking native IPC', async () => {
        isDesktopHostMock.mockReturnValue(false);
        const mod = await import('./desktopWebViewBridge');

        await expect(mod.captureDesktopBrowserSnapshot({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 7,
            captureRequestId: 'capture_request_1',
        })).resolves.toMatchObject({
            ok: false,
            errorCode: 'captureUnsupported',
            availability: {
                available: false,
                disabledReasons: ['tauri_host_unavailable'],
            },
        });
        expect(invokeDesktopHostMock).not.toHaveBeenCalled();
    });

    it('invokes shaped Tauri browser view commands and preserves native unavailability diagnostics', async () => {
        isDesktopHostMock.mockReturnValue(true);
        const unavailableResult = {
            ok: false,
            availability: {
                available: false,
                platform: 'macos',
                primitive: 'macosNsViewWebKit',
                renderEngine: 'unavailable',
                producer: 'none',
                privilegedIpc: false,
                supports: {
                    navigation: false,
                    goBackForward: false,
                    reload: false,
                    stop: false,
                    pageInfoDiagnostics: false,
                    nativeDevtools: false,
                    capture: false,
                    recording: false,
                    automation: false,
                },
                disabledReasons: ['desktop_webview_child_view_unverified'],
            },
        };
        invokeDesktopHostMock.mockResolvedValue(unavailableResult);
        const mod = await import('./desktopWebViewBridge');

        await expect(mod.openDesktopBrowserView({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            profileId: 'profile_1',
            url: 'https://example.com/',
        })).resolves.toEqual(unavailableResult);
        await expect(mod.navigateDesktopBrowserView({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            url: 'https://example.com/docs',
        })).resolves.toEqual(unavailableResult);
        await expect(mod.setDesktopBrowserViewBounds({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            visible: true,
            rect: {
                x: 1,
                y: 2,
                width: 800,
                height: 600,
                scaleFactor: 2,
            },
        })).resolves.toEqual(unavailableResult);
        await expect(mod.setDesktopBrowserPointerPassthrough({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            ignore: true,
        })).resolves.toEqual(unavailableResult);
        await expect(mod.closeDesktopBrowserView({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        })).resolves.toEqual(unavailableResult);
        await expect(mod.openDesktopBrowserDevtools({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        })).resolves.toEqual(unavailableResult);

        expect(invokeDesktopHostMock.mock.calls).toEqual([
            [
                'desktop_browser_open_view',
                {
                    request: {
                        browserSessionId: 'browser_session_1',
                        viewId: 'view_1',
                        profileId: 'profile_1',
                        url: 'https://example.com/',
                    },
                },
            ],
            [
                'desktop_browser_navigate',
                {
                    request: {
                        browserSessionId: 'browser_session_1',
                        viewId: 'view_1',
                        url: 'https://example.com/docs',
                    },
                },
            ],
            [
                'desktop_browser_set_bounds',
                {
                    request: {
                        browserSessionId: 'browser_session_1',
                        viewId: 'view_1',
                        visible: true,
                        rect: {
                            x: 1,
                            y: 2,
                            width: 800,
                            height: 600,
                            scaleFactor: 2,
                        },
                    },
                },
            ],
            [
                'desktop_browser_set_pointer_passthrough',
                {
                    request: {
                        browserSessionId: 'browser_session_1',
                        viewId: 'view_1',
                        ignore: true,
                    },
                },
            ],
            [
                'desktop_browser_close_view',
                {
                    request: {
                        browserSessionId: 'browser_session_1',
                        viewId: 'view_1',
                    },
                },
            ],
            [
                'desktop_browser_open_devtools',
                {
                    request: {
                        browserSessionId: 'browser_session_1',
                        viewId: 'view_1',
                    },
                },
            ],
        ]);
    });

    it('reads typed native page-info diagnostics without exposing other diagnostics families', async () => {
        isDesktopHostMock.mockReturnValue(true);
        invokeDesktopHostMock.mockResolvedValue({
            ok: true,
            availability: {
                available: true,
                platform: 'windows',
                primitive: 'windowsHwndWebView2',
                renderEngine: 'desktopWebView',
                producer: 'tauriWryNativeChildView',
                privilegedIpc: false,
                supports: {
                    navigation: true,
                    goBackForward: false,
                    reload: false,
                    stop: false,
                    pageInfoDiagnostics: true,
                    nativeDevtools: false,
                    capture: false,
                    recording: false,
                    automation: false,
                },
                disabledReasons: [],
            },
            pageInfo: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                requestedUrl: 'https://example.com/next',
                currentUrl: 'https://example.com/next',
                title: 'Example',
                loadingState: 'finished',
                lastError: null,
                lastRejectedNavigation: {
                    url: 'file:///etc/passwd',
                    reason: 'unsupported_url',
                },
            },
        });
        const mod = await import('./desktopWebViewBridge');

        await expect(mod.readDesktopBrowserPageInfo({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        })).resolves.toMatchObject({
            ok: true,
            pageInfo: {
                requestedUrl: 'https://example.com/next',
                currentUrl: 'https://example.com/next',
                title: 'Example',
                loadingState: 'finished',
                lastRejectedNavigation: {
                    reason: 'unsupported_url',
                },
            },
        });
        expect(invokeDesktopHostMock).toHaveBeenCalledWith('desktop_browser_get_page_info', {
            request: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
            },
        });
    });

    it('accepts the crashed loading-state so the engine can surface render-process recovery', async () => {
        isDesktopHostMock.mockReturnValue(true);
        invokeDesktopHostMock.mockResolvedValue({
            ok: true,
            availability: {
                available: true,
                platform: 'macos',
                primitive: 'macosNsViewWebKit',
                renderEngine: 'desktopWebView',
                producer: 'tauriWryNativeChildView',
                privilegedIpc: false,
                supports: {
                    navigation: true,
                    goBackForward: false,
                    reload: false,
                    stop: false,
                    pageInfoDiagnostics: true,
                    nativeDevtools: false,
                    capture: false,
                    recording: false,
                    automation: false,
                },
                disabledReasons: [],
            },
            pageInfo: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                requestedUrl: 'https://example.com/',
                currentUrl: 'https://example.com/',
                title: 'Example',
                loadingState: 'crashed',
            },
        });
        const mod = await import('./desktopWebViewBridge');

        await expect(mod.readDesktopBrowserPageInfo({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        })).resolves.toMatchObject({
            ok: true,
            pageInfo: {
                currentUrl: 'https://example.com/',
                loadingState: 'crashed',
            },
        });
    });

    it('captures typed desktop WebView snapshots only when native identity and generation match', async () => {
        isDesktopHostMock.mockReturnValue(true);
        invokeDesktopHostMock.mockResolvedValue({
            ok: true,
            availability: {
                available: true,
                platform: 'macos',
                primitive: 'macosNsViewWebKit',
                renderEngine: 'desktopWebView',
                producer: 'tauriWryNativeChildView',
                privilegedIpc: false,
                supports: {
                    navigation: true,
                    goBackForward: false,
                    reload: false,
                    stop: false,
                    pageInfoDiagnostics: true,
                    nativeDevtools: false,
                    capture: true,
                    recording: false,
                    automation: false,
                },
                disabledReasons: [],
            },
            snapshot: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 7,
                captureRequestId: 'capture_request_1',
                capturedAtMs: 12_345,
                mimeType: 'image/png',
                width: 800,
                height: 600,
                sizeBytes: 4,
                bytesBase64: 'AQIDBA==',
            },
        });
        const mod = await import('./desktopWebViewBridge');

        await expect(mod.captureDesktopBrowserSnapshot({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 7,
            captureRequestId: 'capture_request_1',
        })).resolves.toMatchObject({
            ok: true,
            snapshot: {
                mimeType: 'image/png',
                width: 800,
                height: 600,
                bytesBase64: 'AQIDBA==',
            },
        });
        expect(invokeDesktopHostMock).toHaveBeenCalledWith('desktop_browser_capture_snapshot', {
            request: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 7,
                captureRequestId: 'capture_request_1',
            },
        });
    });

    it('forwards the annotation crop clip so the Wry capture matches the union-of-targets rect (ANNO-3)', async () => {
        isDesktopHostMock.mockReturnValue(true);
        // Union of two marked targets in CSS viewport px → device clip via the canonical helper.
        const clip = resolveAnnotationCropClip({
            targets: [
                { x: 10, y: 20, width: 30, height: 40 },
                { x: 50, y: 10, width: 20, height: 20 },
            ],
            viewport: {
                scrollX: 0,
                scrollY: 0,
                devicePixelRatio: 2,
                surface: { width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER },
            },
        });
        if (clip.status !== 'clip') throw new Error('expected a clip');
        // css union {10,10,60,50} × DPR 2 → device {20,20,120,100}.
        expect(clip.devicePageRect).toEqual({ x: 20, y: 20, width: 120, height: 100 });

        invokeDesktopHostMock.mockResolvedValue({
            ok: true,
            availability: {
                available: true,
                platform: 'macos',
                primitive: 'macosNsViewWebKit',
                renderEngine: 'desktopWebView',
                producer: 'tauriWryNativeChildView',
                privilegedIpc: false,
                supports: {
                    navigation: true,
                    goBackForward: false,
                    reload: false,
                    stop: false,
                    pageInfoDiagnostics: true,
                    nativeDevtools: false,
                    capture: true,
                    recording: false,
                    automation: false,
                },
                disabledReasons: [],
            },
            // Native returns the CROPPED media — dimensions equal the device clip, not the full page.
            snapshot: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 7,
                captureRequestId: 'capture_request_1',
                capturedAtMs: 12_345,
                mimeType: 'image/png',
                width: clip.devicePageRect.width,
                height: clip.devicePageRect.height,
                sizeBytes: 4,
                bytesBase64: 'AQIDBA==',
            },
        });
        const mod = await import('./desktopWebViewBridge');

        const result = await mod.captureDesktopBrowserSnapshot({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 7,
            captureRequestId: 'capture_request_1',
            clip: clip.devicePageRect,
        });

        // The native command received the union-of-targets device clip (integer-normalized), NOT a
        // full-frame capture.
        expect(invokeDesktopHostMock).toHaveBeenCalledWith('desktop_browser_capture_snapshot', {
            request: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 7,
                captureRequestId: 'capture_request_1',
                clip: { x: 20, y: 20, width: 120, height: 100 },
            },
        });
        // The captured media dimensions equal the crop, not the page.
        expect(result.ok).toBe(true);
        expect(result.snapshot?.width).toBe(120);
        expect(result.snapshot?.height).toBe(100);
    });

    it('rejects stale desktop WebView snapshot payloads that do not match the requested generation', async () => {
        isDesktopHostMock.mockReturnValue(true);
        invokeDesktopHostMock.mockResolvedValue({
            ok: true,
            availability: {
                available: true,
                platform: 'macos',
                primitive: 'macosNsViewWebKit',
                renderEngine: 'desktopWebView',
                producer: 'tauriWryNativeChildView',
                privilegedIpc: false,
                supports: {
                    navigation: true,
                    goBackForward: false,
                    reload: false,
                    stop: false,
                    pageInfoDiagnostics: true,
                    nativeDevtools: false,
                    capture: true,
                    recording: false,
                    automation: false,
                },
                disabledReasons: [],
            },
            snapshot: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 6,
                captureRequestId: 'capture_request_1',
                capturedAtMs: 12_345,
                mimeType: 'image/png',
                width: 800,
                height: 600,
                sizeBytes: 4,
                bytesBase64: 'AQIDBA==',
            },
        });
        const mod = await import('./desktopWebViewBridge');

        const result = await mod.captureDesktopBrowserSnapshot({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 7,
            captureRequestId: 'capture_request_1',
        });
        expect(result).toMatchObject({
            ok: false,
            errorCode: 'staleNavigation',
        });
        expect(result.snapshot).toBeUndefined();
    });

    it('rejects desktop WebView snapshot payloads that return data URLs instead of raw base64 bytes', async () => {
        isDesktopHostMock.mockReturnValue(true);
        invokeDesktopHostMock.mockResolvedValue({
            ok: true,
            availability: {
                available: true,
                platform: 'macos',
                primitive: 'macosNsViewWebKit',
                renderEngine: 'desktopWebView',
                producer: 'tauriWryNativeChildView',
                privilegedIpc: false,
                supports: {
                    navigation: true,
                    goBackForward: false,
                    reload: false,
                    stop: false,
                    pageInfoDiagnostics: true,
                    nativeDevtools: false,
                    capture: true,
                    recording: false,
                    automation: false,
                },
                disabledReasons: [],
            },
            snapshot: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 7,
                captureRequestId: 'capture_request_1',
                capturedAtMs: 12_345,
                mimeType: 'image/png',
                width: 800,
                height: 600,
                sizeBytes: 4,
                bytesBase64: 'data:image/png;base64,AQIDBA==',
            },
        });
        const mod = await import('./desktopWebViewBridge');

        const result = await mod.captureDesktopBrowserSnapshot({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 7,
            captureRequestId: 'capture_request_1',
        });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'captureFailed',
        });
        expect(result.snapshot).toBeUndefined();
    });

    it('captures a reference-only recording frame over the canonical invoke (no inline bytes)', async () => {
        isDesktopHostMock.mockReturnValue(true);
        invokeDesktopHostMock.mockResolvedValue({
            ok: true,
            availability: {
                available: true,
                platform: 'macos',
                primitive: 'macosNsViewWebKit',
                renderEngine: 'desktopWebView',
                producer: 'tauriWryNativeChildView',
                privilegedIpc: false,
                supports: {
                    navigation: true,
                    goBackForward: false,
                    reload: false,
                    stop: false,
                    pageInfoDiagnostics: true,
                    nativeDevtools: false,
                    capture: true,
                    recording: false,
                    automation: false,
                },
                disabledReasons: [],
            },
            frame: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 7,
                captureRequestId: 'capture_request_1',
                capturedAtMs: 12_345,
                mimeType: 'image/png',
                width: 800,
                height: 600,
                sizeBytes: 4_096,
                path: '/tmp/happier-home/recordings/frame.png',
            },
        });
        const mod = await import('./desktopWebViewBridge');

        const result = await mod.captureDesktopBrowserRecordingFrame({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 7,
            captureRequestId: 'capture_request_1',
            outputPath: '/tmp/happier-home/recordings/frame.png',
            maxBytes: 16_000_000,
        });

        expect(result.ok).toBe(true);
        expect(result.frame).toMatchObject({
            mimeType: 'image/png',
            width: 800,
            height: 600,
            sizeBytes: 4_096,
            path: '/tmp/happier-home/recordings/frame.png',
        });
        // Reference-only: the IPC payload never carries pixel bytes.
        expect(result.frame && Object.keys(result.frame)).not.toContain('bytesBase64');
        expect(invokeDesktopHostMock).toHaveBeenCalledWith('desktop_browser_capture_recording_frame', {
            request: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 7,
                captureRequestId: 'capture_request_1',
                outputPath: '/tmp/happier-home/recordings/frame.png',
                maxBytes: 16_000_000,
            },
        });
    });

    it('rejects a recording frame that exceeds the negotiated byte cap', async () => {
        isDesktopHostMock.mockReturnValue(true);
        invokeDesktopHostMock.mockResolvedValue({
            ok: true,
            availability: {
                available: true,
                platform: 'macos',
                primitive: 'macosNsViewWebKit',
                renderEngine: 'desktopWebView',
                producer: 'tauriWryNativeChildView',
                privilegedIpc: false,
                supports: {
                    navigation: true,
                    goBackForward: false,
                    reload: false,
                    stop: false,
                    pageInfoDiagnostics: true,
                    nativeDevtools: false,
                    capture: true,
                    recording: false,
                    automation: false,
                },
                disabledReasons: [],
            },
            frame: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 7,
                captureRequestId: 'capture_request_1',
                capturedAtMs: 12_345,
                mimeType: 'image/png',
                width: 4_000,
                height: 4_000,
                sizeBytes: 32_000_000,
                path: '/tmp/happier-home/recordings/frame.png',
            },
        });
        const mod = await import('./desktopWebViewBridge');

        const result = await mod.captureDesktopBrowserRecordingFrame({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 7,
            captureRequestId: 'capture_request_1',
            outputPath: '/tmp/happier-home/recordings/frame.png',
            maxBytes: 16_000_000,
        });

        expect(result).toMatchObject({ ok: false, errorCode: 'captureTooLarge' });
        expect(result.frame).toBeUndefined();
    });

    it('passes through a native recording-frame write failure error code', async () => {
        isDesktopHostMock.mockReturnValue(true);
        invokeDesktopHostMock.mockResolvedValue({
            ok: false,
            availability: {
                available: true,
                platform: 'macos',
                primitive: 'macosNsViewWebKit',
                renderEngine: 'desktopWebView',
                producer: 'tauriWryNativeChildView',
                privilegedIpc: false,
                supports: {
                    navigation: true,
                    goBackForward: false,
                    reload: false,
                    stop: false,
                    pageInfoDiagnostics: true,
                    nativeDevtools: false,
                    capture: true,
                    recording: false,
                    automation: false,
                },
                disabledReasons: [],
            },
            errorCode: 'captureWriteFailed',
        });
        const mod = await import('./desktopWebViewBridge');

        const result = await mod.captureDesktopBrowserRecordingFrame({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 7,
            captureRequestId: 'capture_request_1',
            outputPath: '/tmp/happier-home/recordings/frame.png',
            maxBytes: 16_000_000,
        });

        expect(result).toMatchObject({ ok: false, errorCode: 'captureWriteFailed' });
    });

    it('reports the recording frame capture unavailable off-desktop without invoking', async () => {
        isDesktopHostMock.mockReturnValue(false);
        const mod = await import('./desktopWebViewBridge');

        const result = await mod.captureDesktopBrowserRecordingFrame({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 7,
            captureRequestId: 'capture_request_1',
            outputPath: '/tmp/happier-home/recordings/frame.png',
            maxBytes: 16_000_000,
        });

        expect(result).toMatchObject({ ok: false, errorCode: 'captureUnsupported' });
        expect(invokeDesktopHostMock).not.toHaveBeenCalled();
    });

    it('downgrades rejected native browser view commands to structured command unavailability', async () => {
        isDesktopHostMock.mockReturnValue(true);
        invokeDesktopHostMock.mockRejectedValue(new Error('unknown command'));
        const mod = await import('./desktopWebViewBridge');

        await expect(mod.closeDesktopBrowserView({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        })).resolves.toMatchObject({
            ok: false,
            availability: {
                available: false,
                disabledReasons: ['desktop_webview_native_command_unavailable'],
            },
        });
    });
});
