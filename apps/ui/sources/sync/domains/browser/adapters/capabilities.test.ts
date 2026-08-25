import { describe, expect, it } from 'vitest';

import { buildBrowserAdapterCapabilities } from './capabilities';

describe('buildBrowserAdapterCapabilities', () => {
    it('makes a web external URL (externalUrl + webIframe) available and navigable so the address bar is enabled', () => {
        // Regression (capability split-brain): the engine selector renders web external URLs in the
        // iframe, so their capabilities MUST agree — `canNavigate: true` — or BrowserShell disables
        // the address bar from `toolbar.canNavigate` and the user sees a page they cannot navigate.
        const caps = buildBrowserAdapterCapabilities({
            adapterKind: 'externalUrl',
            supportedTargetKinds: ['externalUrl'],
            supportedRenderEngines: ['webIframe'],
        });

        expect(caps.supportedRenderEngines).toEqual(['webIframe']);
        expect(caps.navigation.canNavigate).toBe(true);
        expect(caps.navigation.canReload).toBe(true);
        expect(caps.disabledReasons).toEqual([]);
    });

    it('makes a native external URL (externalUrl + nativeWebView) available with real history capability', () => {
        // R-2 regression: `selectBrowserTargetAdapter` maps an allowed external URL on ios/android to
        // the RN `WebView`, which hosts arbitrary third-party sites and reports real history — but
        // this builder's unavailable gate only carved out `webIframe`, so the whole set collapsed to
        // `['unavailable']` and every mobile external tab shipped a dead address bar plus permanently
        // disabled Back/Forward/Reload/Stop. Discriminating against the "web-only carve-out"
        // implementation: `nativeWebView` is the ONLY engine that may claim back/forward here.
        const caps = buildBrowserAdapterCapabilities({
            adapterKind: 'externalUrl',
            supportedTargetKinds: ['externalUrl'],
            supportedRenderEngines: ['nativeWebView'],
        });

        expect(caps.supportedRenderEngines).toEqual(['nativeWebView']);
        expect(caps.disabledReasons).toEqual([]);
        expect(caps.navigation.canNavigate).toBe(true);
        expect(caps.navigation.canReload).toBe(true);
        expect(caps.navigation.canStop).toBe(true);
        expect(caps.navigation.canGoBack).toBe(true);
        expect(caps.navigation.canGoForward).toBe(true);
    });

    it('keeps a streamed browser surface fail-closed (unavailable) without its runtime', () => {
        // The web-iframe carve-out must NOT over-open: surfaces that genuinely require a runtime
        // (streamed/sidecar) still resolve unavailable.
        const caps = buildBrowserAdapterCapabilities({
            adapterKind: 'streamedBrowserSurface',
            supportedTargetKinds: ['streamedBrowser'],
            supportedRenderEngines: ['streamedSurface'],
        });

        expect(caps.supportedRenderEngines).toEqual(['unavailable']);
        expect(caps.navigation.canNavigate).toBe(false);
    });

    // §4.5 / §12.20B support-matrix closure: human-visible navigate/reload on the daemon-driven
    // engines (chromiumSidecar, streamedBrowserSurface) is consciously OUT of scope. The agent
    // sidecar drives navigation through the daemon CDP control adapter, NOT a UI `sendDaemonCommand`
    // round-trip; the human streamed-render path (12.20B) has no producer. This must remain
    // fail-closed but LABELED — never an unlabeled fail-closed — so the user/agent gets a reason.
    it.each([
        { adapterKind: 'chromiumSidecar', targetKind: 'externalUrl', engine: 'webIframe', reasonCode: 'sidecar_runtime_unavailable' },
        { adapterKind: 'streamedBrowserSurface', targetKind: 'streamedBrowser', engine: 'streamedSurface', reasonCode: 'streamed_browser_unavailable' },
    ] as const)(
        'labels navigate/reload on the $adapterKind engine as unavailable with an explicit reason (no unlabeled fail-closed)',
        ({ adapterKind, targetKind, engine, reasonCode }) => {
            const caps = buildBrowserAdapterCapabilities({
                adapterKind,
                supportedTargetKinds: [targetKind],
                supportedRenderEngines: [engine],
            });

            // Fail-closed for navigate/reload …
            expect(caps.navigation.canNavigate).toBe(false);
            expect(caps.navigation.canReload).toBe(false);
            expect(caps.navigation.canGoBack).toBe(false);
            expect(caps.navigation.canGoForward).toBe(false);
            // … but explicitly LABELED with the support-matrix reason (not a silent false).
            expect(caps.disabledReasons).toContain(reasonCode);
            expect(caps.automationActions?.navigate.disabledReasons).toContain(reasonCode);
        },
    );
});
