import { beforeEach, describe, expect, it, vi } from 'vitest';


const invokeDesktopHostMock = vi.hoisted(() => vi.fn());
const isDesktopHostMock = vi.hoisted(() => vi.fn());
const listenDesktopHostEventMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/platform/desktopHost', () => ({
    invokeDesktopHost: (command: string, args?: Record<string, unknown>) => invokeDesktopHostMock(command, args),
    isDesktopHost: () => isDesktopHostMock(),
    listenDesktopHostEvent: (...args: unknown[]) => listenDesktopHostEventMock(...args),
}));

describe('desktop WebView native bridge', () => {
    it('delivers guest shortcut events only to the exact view with validated keyboard data', async () => {
        listenDesktopHostEventMock.mockResolvedValue(() => {});
        const { subscribeDesktopBrowserView } = await import('./desktopWebViewBridge');
        const listener = vi.fn();
        const unsubscribe = await subscribeDesktopBrowserView({ browserSessionId: 'session', viewId: 'view' }, listener);
        try {
            const publish = listenDesktopHostEventMock.mock.calls.at(-1)![1] as (value: unknown) => void;
            const event = { key: 'l', code: 'KeyL', repeat: false, modifiers: { shift: false, ctrl: false, meta: true, alt: false } };
            publish({ kind: 'keyboardShortcut', browserSessionId: 'other', viewId: 'view', event });
            publish({ kind: 'keyboardShortcut', browserSessionId: 'session', viewId: 'view', event: { ...event, repeat: 'false' } });
            expect(listener).not.toHaveBeenCalled();
            publish({ kind: 'keyboardShortcut', browserSessionId: 'session', viewId: 'view', event });
            expect(listener).toHaveBeenCalledWith({ kind: 'keyboardShortcut', event });
        } finally { unsubscribe(); }
    });
    it('admits changed native facts only for the subscribed view and releases the host listener', async () => {
        const stop = vi.fn();
        listenDesktopHostEventMock.mockResolvedValue(stop);
        const { subscribeDesktopBrowserView } = await import('./desktopWebViewBridge');
        const listener = vi.fn();
        const unsubscribe = await subscribeDesktopBrowserView({ browserSessionId: 'session', viewId: 'view' }, listener);
        const publish = listenDesktopHostEventMock.mock.calls.at(-1)![1] as (value: unknown) => void;
        const pageInfo = { browserSessionId: 'session', viewId: 'view', requestedUrl: 'https://example.test',
            loadingState: 'finished', canGoBack: true, canGoForward: false, title: 'Document' };
        publish({ browserSessionId: 'other', viewId: 'view', kind: 'pageInfoChanged', pageInfo, lifecycleChanged: false, navigationGeneration: 0 });
        publish({ browserSessionId: 'session', viewId: 'view', kind: 'pageInfoChanged', pageInfo: { ...pageInfo, canGoBack: 'yes' }, lifecycleChanged: false, navigationGeneration: 0 });
        expect(listener).not.toHaveBeenCalled();
        publish({ browserSessionId: 'session', viewId: 'view', kind: 'pageInfoChanged', pageInfo, lifecycleChanged: false, navigationGeneration: 0 });
        expect(listener).toHaveBeenCalledWith({ kind: 'pageInfoChanged', pageInfo: expect.objectContaining(pageInfo), lifecycleChanged: false, navigationGeneration: 0 });
        unsubscribe();
        expect(stop).toHaveBeenCalledTimes(1);
    });

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

    it.each([false, true])('accepts injected reload/stop and automation=%s on a backed desktop WebView', async (automation) => {
        // Current Rust native_child_view_availability advertises injected automation; retain the
        // already-supported false fact without downgrading the whole browsing surface.
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
                automation,
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
                automation,
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
                canGoBack: true,
                canGoForward: false,
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
                canGoBack: true,
                canGoForward: false,
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
                canGoBack: false,
                canGoForward: false,
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

    it('preserves native source privacy denials for screenshots and recording frames', async () => {
        isDesktopHostMock.mockReturnValue(true);
        invokeDesktopHostMock.mockResolvedValue({ ok: false, availability: {}, errorCode: 'sensitiveFieldsPresent' });
        const mod = await import('./desktopWebViewBridge');
        const request = { browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 7,
            captureRequestId: 'capture_request_1' };
        expect(await mod.captureDesktopBrowserSnapshot(request)).toMatchObject({ ok: false, errorCode: 'sensitiveFieldsPresent' });
        expect(await mod.captureDesktopBrowserRecordingFrame({ ...request, outputPath: '/tmp/frame.png' }))
            .toMatchObject({ ok: false, errorCode: 'sensitiveFieldsPresent' });
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
                scaleFactor: 2,
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
            },
        });
    });

    it('accepts a valid recording frame beyond the former byte default', async () => {
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
        });

        expect(result).toMatchObject({ ok: true, frame: { sizeBytes: 32_000_000 } });
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
