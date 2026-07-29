import type {
    BrowserTargetPolicyDecisionV1,
    BrowserViewTargetV1,
} from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildBrowserAdapterCapabilities } from './capabilities';
import type { DesktopWebViewNativeAvailability } from './desktopWebView';
import {
    openBrowserExternalTabSelection,
    selectBrowserTargetAdapter,
    type BrowserAdapterSelection,
} from './selection';

const openExternalUrlMock = vi.hoisted(() => vi.fn(async (_url: string) => true));

vi.mock('@/utils/url/openExternalUrl', () => ({
    openExternalUrl: (url: string) => openExternalUrlMock(url),
}));

const localPreviewTarget = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
} satisfies BrowserViewTargetV1;

const hostedPluginTarget = {
    kind: 'hostedPluginWeb',
    targetId: 'hosted_1',
    pluginId: 'plugin.example',
    contributionId: 'hosted-web',
} satisfies BrowserViewTargetV1;

const externalUrlTarget = {
    kind: 'externalUrl',
    targetId: 'external_1',
    url: 'https://example.com/',
} satisfies BrowserViewTargetV1;

const allowedExternalUrlPolicy = {
    targetKind: 'externalUrl',
    state: 'allowed',
    profileId: 'profile_browser_1',
    profileMode: 'ephemeral',
    origin: 'https://example.com',
    security: {
        url: 'https://example.com/',
        origin: 'https://example.com',
        securityLevel: 'secure',
        reasonCodes: [],
    },
    permissions: {
        downloads: 'deny',
        uploads: 'deny',
        clipboard: 'deny',
        camera: 'deny',
        microphone: 'deny',
        fileAccess: 'deny',
        popups: 'deny',
        browserUse: 'prompt',
    },
    disabledReasons: [],
} satisfies BrowserTargetPolicyDecisionV1;

const deniedExternalUrlPolicy = {
    ...allowedExternalUrlPolicy,
    state: 'denied',
    reasonCode: 'policy_denied',
    disabledReasons: ['policy_denied'],
} satisfies BrowserTargetPolicyDecisionV1;

const simulatorTarget = {
    kind: 'simulatorPreview',
    targetId: 'simulator_1',
    deviceId: 'device_1',
} satisfies BrowserViewTargetV1;

const availableDesktopWebView = {
    available: true,
    platform: 'macos',
    primitive: 'macosNsViewWebKit',
    renderEngine: 'desktopWebView',
    producer: 'tauriWryNativeChildView',
    privilegedIpc: false,
    supports: {
        navigation: true,
        goBackForward: true,
        reload: true,
        stop: true,
        pageInfoDiagnostics: true,
        nativeDevtools: false,
        capture: false,
        recording: false,
        automation: false,
    },
    disabledReasons: [],
} satisfies DesktopWebViewNativeAvailability;

const capturingDesktopWebView = {
    ...availableDesktopWebView,
    supports: {
        ...availableDesktopWebView.supports,
        capture: true,
    },
} satisfies DesktopWebViewNativeAvailability;

describe('selectBrowserTargetAdapter', () => {
    it('selects the shared iframe engine for web local previews', () => {
        expect(selectBrowserTargetAdapter({
            target: localPreviewTarget,
            platform: 'web',
        })).toMatchObject({
            ok: true,
            adapterKind: 'localPreview',
            engineKind: 'webIframe',
        });
    });

    it('selects the shared native WebView engine for hosted-plugin targets on native clients', () => {
        expect(selectBrowserTargetAdapter({
            target: hostedPluginTarget,
            platform: 'ios',
        })).toMatchObject({
            ok: true,
            adapterKind: 'hostedPlugin',
            engineKind: 'nativeWebView',
            capabilities: {
                diagnosticsFidelityByFamily: {
                    console: 'injectedPage',
                    pageError: 'injectedPage',
                    network: 'injectedPage',
                    resources: 'injectedPage',
                    pageInfo: 'nativeCallback',
                },
            },
        });
    });

    it('keeps web iframe diagnostics limited to native load callbacks and preview proxy telemetry', () => {
        expect(selectBrowserTargetAdapter({
            target: localPreviewTarget,
            platform: 'web',
        })).toMatchObject({
            ok: true,
            adapterKind: 'localPreview',
            engineKind: 'webIframe',
            capabilities: {
                diagnosticsFidelityByFamily: {
                    network: 'previewProxy',
                    proxyTunnel: 'previewProxy',
                    pageInfo: 'nativeCallback',
                },
            },
        });
    });

    it('selects the web iframe engine for allowed web external URLs (framability is the engine call)', () => {
        // OWNER-ENGINE (BRW-5): the selector always returns a renderable `webIframe` for an allowed
        // (non-denied) web external URL. Framability is NOT knowable synchronously at selection time,
        // so the engine (WebIframeEngine) — not the selector — decides framable vs. non-framable and
        // surfaces the open-in-system-browser fallback.
        expect(selectBrowserTargetAdapter({
            target: externalUrlTarget,
            platform: 'web',
            targetPolicyDecision: allowedExternalUrlPolicy,
        })).toMatchObject({
            ok: true,
            outcome: 'renderEngine',
            adapterKind: 'externalUrl',
            engineKind: 'webIframe',
        });
    });

    it('selects the native WebView engine for allowed external URLs on ios/android', () => {
        // Mobile WebViews can host arbitrary third-party sites, so an allowed external URL renders
        // inline via the native WebView engine instead of dead-ending as unavailable.
        for (const platform of ['ios', 'android'] as const) {
            expect(selectBrowserTargetAdapter({
                target: externalUrlTarget,
                platform,
                targetPolicyDecision: allowedExternalUrlPolicy,
            })).toMatchObject({
                ok: true,
                outcome: 'renderEngine',
                adapterKind: 'externalUrl',
                engineKind: 'nativeWebView',
            });
        }
    });

    it('keeps ios/android external URLs unavailable when policy denies browsing', () => {
        for (const platform of ['ios', 'android'] as const) {
            expect(selectBrowserTargetAdapter({
                target: externalUrlTarget,
                platform,
                targetPolicyDecision: deniedExternalUrlPolicy,
            })).toMatchObject({
                ok: false,
                adapterKind: 'externalUrl',
                engineKind: 'unavailable',
                reasonCode: 'external_url_policy_denied',
            });
        }
    });

    it('selects a renderable engine for an allowed external URL on every platform', () => {
        // Closure: no platform dead-ends as a bare non-fulfilled `openExternalTab` from the selector
        // for an allowed in-app external open. (desktop requires a backed availability producer.)
        const byPlatform: Readonly<Record<'web' | 'ios' | 'android' | 'desktop', 'webIframe' | 'nativeWebView' | 'desktopWebView'>> = {
            web: 'webIframe',
            ios: 'nativeWebView',
            android: 'nativeWebView',
            desktop: 'desktopWebView',
        };
        for (const [platform, engineKind] of Object.entries(byPlatform) as Array<['web' | 'ios' | 'android' | 'desktop', 'webIframe' | 'nativeWebView' | 'desktopWebView']>) {
            const selection = selectBrowserTargetAdapter({
                target: externalUrlTarget,
                platform,
                targetPolicyDecision: allowedExternalUrlPolicy,
                ...(platform === 'desktop' ? { desktopWebViewAvailability: availableDesktopWebView } : {}),
            });
            expect(selection).toMatchObject({
                ok: true,
                outcome: 'renderEngine',
                engineKind,
            });
        }
    });

    it('keeps web external URL targets denied by policy unavailable (no new-tab open)', () => {
        expect(selectBrowserTargetAdapter({
            target: externalUrlTarget,
            platform: 'web',
            targetPolicyDecision: deniedExternalUrlPolicy,
        })).toEqual({
            ok: false,
            adapterKind: 'externalUrl',
            engineKind: 'unavailable',
            reasonCode: 'external_url_policy_denied',
            reason: {
                reasonCode: 'external_url_policy_denied',
                blockedBy: ['BRW-6'],
                requiredCapability: 'policyBackedExternalBrowsing',
                targetKind: 'externalUrl',
            },
        });
    });

    it('keeps desktop external URL targets unavailable until a real desktop WebView engine is available', () => {
        expect(selectBrowserTargetAdapter({
            target: externalUrlTarget,
            platform: 'desktop',
            targetPolicyDecision: allowedExternalUrlPolicy,
        })).toEqual({
            ok: false,
            adapterKind: 'externalUrl',
            engineKind: 'unavailable',
            reasonCode: 'desktop_engine_unavailable',
            reason: {
                reasonCode: 'desktop_engine_unavailable',
                blockedBy: ['BRW-5'],
                requiredCapability: 'desktopWebView',
                targetKind: 'externalUrl',
            },
        });
    });

    it('selects desktop WebView for allowed external URLs only when native availability reports a real producer', () => {
        expect(selectBrowserTargetAdapter({
            target: externalUrlTarget,
            platform: 'desktop',
            targetPolicyDecision: allowedExternalUrlPolicy,
            desktopWebViewAvailability: availableDesktopWebView,
        })).toMatchObject({
            ok: true,
            adapterKind: 'externalUrl',
            engineKind: 'desktopWebView',
            capabilities: {
                supportedTargetKinds: ['externalUrl'],
                supportedRenderEngines: ['desktopWebView'],
                navigation: {
                    canNavigate: true,
                    canGoBack: true,
                    canGoForward: true,
                    canReload: true,
                    canStop: true,
                },
                diagnosticsFidelityByFamily: {
                    pageInfo: 'nativeCallback',
                },
                inputRouting: 'native',
                supportsStreamingDisplay: false,
                disabledReasons: [],
            },
        });
    });

    it('NEVER selects the sandboxed web iframe engine on desktop with a supported native producer (B-3 closure)', () => {
        // B-3 invariant: the iframe (`webIframe`) is producible ONLY by `platform === 'web'`. A
        // desktop platform with a real desktop-WebView producer must resolve to the native Wry
        // `desktopWebView`, never the sandboxed iframe — this is the engine half of the regression.
        const selection = selectBrowserTargetAdapter({
            target: externalUrlTarget,
            platform: 'desktop',
            targetPolicyDecision: allowedExternalUrlPolicy,
            desktopWebViewAvailability: availableDesktopWebView,
        });
        expect(selection.ok).toBe(true);
        if (selection.ok && selection.outcome === 'renderEngine') {
            expect(selection.engineKind).toBe('desktopWebView');
            expect(selection.engineKind).not.toBe('webIframe');
        } else {
            throw new Error('expected a renderEngine selection on desktop');
        }
    });

    it('keeps policy-denied external URL targets unavailable on desktop', () => {
        expect(selectBrowserTargetAdapter({
            target: externalUrlTarget,
            platform: 'desktop',
            targetPolicyDecision: deniedExternalUrlPolicy,
        })).toEqual({
            ok: false,
            adapterKind: 'externalUrl',
            engineKind: 'unavailable',
            reasonCode: 'external_url_policy_denied',
            reason: {
                reasonCode: 'external_url_policy_denied',
                blockedBy: ['BRW-6'],
                requiredCapability: 'policyBackedExternalBrowsing',
                targetKind: 'externalUrl',
            },
        });
    });

    it('fails closed for streamed browser targets with sidecar and stream dependencies named', () => {
        expect(selectBrowserTargetAdapter({
            target: {
                kind: 'streamedBrowser',
                targetId: 'stream_1',
                streamId: 'stream_1',
            },
            platform: 'web',
        })).toEqual({
            ok: false,
            adapterKind: 'streamedBrowserSurface',
            engineKind: 'unavailable',
            reasonCode: 'streamed_browser_unavailable',
            reason: {
                reasonCode: 'streamed_browser_unavailable',
                blockedBy: ['BRW-7', 'BRW-8', 'PMS-8', 'SIM-5'],
                requiredCapability: 'browserStreamSurface',
                targetKind: 'streamedBrowser',
            },
        });
    });

    it('selects an available daemon-authoritative streamed browser surface when its control transport is reachable', () => {
        const selection = selectBrowserTargetAdapter({
            target: {
                kind: 'streamedBrowser',
                targetId: 'stream_1',
                streamId: 'stream_1',
            },
            platform: 'web',
            streamedBrowserSurfaceAvailability: { daemonControlReachable: true },
        });

        expect(selection).toMatchObject({
            ok: true,
            outcome: 'renderEngine',
            adapterKind: 'streamedBrowserSurface',
            engineKind: 'streamedSurface',
            capabilities: {
                adapterKind: 'streamedBrowserSurface',
                supportedTargetKinds: ['streamedBrowser'],
                supportedRenderEngines: ['streamedSurface'],
                supportsStreamingDisplay: true,
                // A daemon-driven real Chromium can navigate; navigation routes over the daemon
                // control transport (the `daemonCommand` effect), so the address bar is enabled.
                navigation: {
                    canNavigate: true,
                    canReload: true,
                    canGoBack: true,
                    canGoForward: true,
                    canStop: true,
                },
            },
        });
        // It must NOT carry the fail-closed unavailable marker.
        expect((selection as { capabilities?: { disabledReasons?: unknown } }).capabilities?.disabledReasons)
            .toEqual([]);
    });

    it('keeps the streamed browser surface fail-closed when the daemon control transport is not reachable', () => {
        expect(selectBrowserTargetAdapter({
            target: {
                kind: 'streamedBrowser',
                targetId: 'stream_1',
                streamId: 'stream_1',
            },
            platform: 'web',
            streamedBrowserSurfaceAvailability: { daemonControlReachable: false },
        })).toMatchObject({
            ok: false,
            adapterKind: 'streamedBrowserSurface',
            engineKind: 'unavailable',
            reasonCode: 'streamed_browser_unavailable',
        });
    });

    it('builds available navigable capabilities for a live streamed browser surface', () => {
        const capabilities = buildBrowserAdapterCapabilities({
            adapterKind: 'streamedBrowserSurface',
            supportedTargetKinds: ['streamedBrowser'],
            supportedRenderEngines: ['streamedSurface'],
            streamedSurfaceLive: true,
        });

        expect(capabilities).toMatchObject({
            supportedRenderEngines: ['streamedSurface'],
            supportsStreamingDisplay: true,
            navigation: { canNavigate: true, canReload: true },
        });
        expect(capabilities.disabledReasons).toEqual([]);
    });

    it('selects the streamed simulator adapter for simulator preview targets', () => {
        expect(selectBrowserTargetAdapter({
            target: simulatorTarget,
            platform: 'web',
        })).toMatchObject({
            ok: true,
            adapterKind: 'simulatorPreview',
            engineKind: 'streamedSurface',
            capabilities: {
                supportedTargetKinds: ['simulatorPreview'],
                supportedRenderEngines: ['streamedSurface'],
                inputRouting: 'pmsControlSideband',
                supportsStreamingDisplay: true,
            },
        });
    });

    it('does not advertise hosted-plugin automation before the host policy owner is implemented', () => {
        const capabilities = buildBrowserAdapterCapabilities({
            adapterKind: 'hostedPlugin',
            supportedTargetKinds: ['hostedPluginWeb'],
            supportedRenderEngines: ['webIframe'],
        });

        expect(capabilities.automationActions?.snapshot).toMatchObject({
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['hosted_plugin_automation_policy_unavailable'],
        });
        expect(capabilities.automationActions?.click).toMatchObject({
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['hosted_plugin_automation_policy_unavailable'],
        });
    });

    it('builds fail-closed capability diagnostics for real browser engines without runtime owners', () => {
        const sidecar = buildBrowserAdapterCapabilities({
            adapterKind: 'chromiumSidecar',
            supportedTargetKinds: ['externalUrl'],
            supportedRenderEngines: ['streamedSurface'],
        });
        const streamedBrowser = buildBrowserAdapterCapabilities({
            adapterKind: 'streamedBrowserSurface',
            supportedTargetKinds: ['streamedBrowser'],
            supportedRenderEngines: ['streamedSurface'],
        });
        const externalUrl = buildBrowserAdapterCapabilities({
            adapterKind: 'externalUrl',
            supportedTargetKinds: ['externalUrl'],
            supportedRenderEngines: ['nativeWebView'],
        });

        expect(sidecar).toMatchObject({
            supportedRenderEngines: ['unavailable'],
            disabledReasons: ['sidecar_runtime_unavailable'],
            supportsStreamingDisplay: false,
            navigation: {
                canNavigate: false,
                canGoBack: false,
                canGoForward: false,
                canReload: false,
                canStop: false,
            },
        });
        expect(sidecar.automationActions?.snapshot).toMatchObject({
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['sidecar_runtime_unavailable'],
        });

        expect(streamedBrowser).toMatchObject({
            supportedRenderEngines: ['unavailable'],
            disabledReasons: ['streamed_browser_unavailable'],
            supportsStreamingDisplay: false,
        });
        expect(streamedBrowser.automationActions?.click).toMatchObject({
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['streamed_browser_unavailable'],
        });

        expect(externalUrl).toMatchObject({
            supportedRenderEngines: ['unavailable'],
            disabledReasons: ['external_url_unavailable'],
            inputRouting: 'none',
        });
        expect(externalUrl.automationActions?.navigate).toMatchObject({
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['external_url_unavailable'],
        });
    });

    it('does not advertise desktop WebView automation without a desktop automation producer', () => {
        const capabilities = buildBrowserAdapterCapabilities({
            adapterKind: 'localPreview',
            supportedTargetKinds: ['localServicePreview'],
            supportedRenderEngines: ['desktopWebView'],
        });

        expect(capabilities.automationActions?.snapshot).toMatchObject({
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['desktop_engine_unavailable'],
        });
        expect(capabilities.automationActions?.click).toMatchObject({
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['desktop_engine_unavailable'],
        });
        expect(capabilities.automationActions?.screenshotReference).toMatchObject({
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['desktop_engine_unavailable'],
        });
        expect(capabilities.automationActions?.recording).toMatchObject({
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['desktop_engine_unavailable'],
        });
    });

    it('advertises only native navigation and page-info diagnostics for a backed desktop WebView producer', () => {
        const capabilities = buildBrowserAdapterCapabilities({
            adapterKind: 'externalUrl',
            supportedTargetKinds: ['externalUrl'],
            supportedRenderEngines: ['desktopWebView'],
            desktopWebViewSupport: availableDesktopWebView.supports,
        });

        expect(capabilities).toMatchObject({
            supportedRenderEngines: ['desktopWebView'],
            navigation: {
                canNavigate: true,
                canGoBack: true,
                canGoForward: true,
                canReload: true,
                canStop: true,
            },
            diagnosticsFidelityByFamily: {
                pageInfo: 'nativeCallback',
            },
            inputRouting: 'native',
            supportsStreamingDisplay: false,
            disabledReasons: [],
        });
        expect(capabilities.automationActions?.snapshot).toMatchObject({
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['desktop_webview_automation_unavailable'],
        });
        expect(capabilities.automationActions?.navigate).toMatchObject({
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['desktop_webview_automation_unavailable'],
        });
        expect(capabilities.automationActions?.screenshotReference).toMatchObject({
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['screenshot_reference_unavailable'],
        });
        expect(capabilities.automationActions?.recording).toMatchObject({
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['browser_recording_capture_adapter_missing'],
        });
    });

    it('advertises native screenshot references only when the desktop WebView capture producer is backed', () => {
        const capabilities = buildBrowserAdapterCapabilities({
            adapterKind: 'externalUrl',
            supportedTargetKinds: ['externalUrl'],
            supportedRenderEngines: ['desktopWebView'],
            desktopWebViewSupport: capturingDesktopWebView.supports,
        });

        expect(capabilities.automationActions?.screenshotReference).toMatchObject({
            available: true,
            fidelity: 'nativeWebView',
            trustedInput: false,
            disabledReasons: [],
        });
        expect(capabilities.automationActions?.snapshot).toMatchObject({
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['desktop_webview_automation_unavailable'],
        });
        expect(capabilities.automationActions?.recording).toMatchObject({
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['browser_recording_capture_adapter_missing'],
        });
    });
});

describe('openBrowserExternalTabSelection', () => {
    beforeEach(() => {
        openExternalUrlMock.mockClear();
    });

    it('opens the canonical OS-tab handoff for an external-tab selection (the engine non-framable fallback)', async () => {
        // The web non-framable fallback is now the only producer of an `openExternalTab` selection
        // (the engine decides framability, §3.4). It hands the URL to the OS-tab opener.
        const selection: BrowserAdapterSelection = {
            ok: true,
            outcome: 'openExternalTab',
            adapterKind: 'externalUrl',
            url: 'https://example.com/',
        };

        await expect(openBrowserExternalTabSelection(selection)).resolves.toBe(true);
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://example.com/');
    });

    it('does not open a new tab for a web render-engine selection', async () => {
        const selection = selectBrowserTargetAdapter({
            target: externalUrlTarget,
            platform: 'web',
            targetPolicyDecision: allowedExternalUrlPolicy,
        });

        await expect(openBrowserExternalTabSelection(selection)).resolves.toBe(false);
        expect(openExternalUrlMock).not.toHaveBeenCalled();
    });

    it('does not open a new tab for a desktop render-engine selection', async () => {
        const selection = selectBrowserTargetAdapter({
            target: externalUrlTarget,
            platform: 'desktop',
            targetPolicyDecision: allowedExternalUrlPolicy,
            desktopWebViewAvailability: availableDesktopWebView,
        });

        await expect(openBrowserExternalTabSelection(selection)).resolves.toBe(false);
        expect(openExternalUrlMock).not.toHaveBeenCalled();
    });

    it('does not open a new tab for an unavailable (policy-denied) selection', async () => {
        const selection = selectBrowserTargetAdapter({
            target: externalUrlTarget,
            platform: 'web',
            targetPolicyDecision: deniedExternalUrlPolicy,
        });

        await expect(openBrowserExternalTabSelection(selection)).resolves.toBe(false);
        expect(openExternalUrlMock).not.toHaveBeenCalled();
    });
});
