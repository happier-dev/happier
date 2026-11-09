import { describe, expect, it } from 'vitest';

import { buildBrowserAdapterCapabilities, resolveBrowserNavigationVerbAvailability } from './capabilities';
import type { DesktopWebViewSupport } from './desktopWebView';
import { INJECTED_PAGE_AUTOMATION_ACTIONS } from '@happier-dev/peer-mediation/browser/collector/actions';

const DESKTOP_AUTOMATION_SUPPORT = {
    navigation: true,
    goBackForward: true,
    reload: true,
    stop: true,
    pageInfoDiagnostics: true,
    nativeDevtools: true,
    capture: true,
    recording: false,
    automation: true,
} satisfies DesktopWebViewSupport;

describe('buildBrowserAdapterCapabilities', () => {
    it.each(['webIframe', 'nativeWebView', 'desktopWebView'] as const)('admits completed injected element context on %s independently of automation', engine => {
        const caps = buildBrowserAdapterCapabilities({ adapterKind: 'externalUrl', supportedTargetKinds: ['externalUrl'],
            supportedRenderEngines: [engine], desktopWebViewSupport: { ...DESKTOP_AUTOMATION_SUPPORT, automation: false } });
        expect(caps.contextKinds).toContain('browserSelectedElement');
    });
    it.each([
        { adapterKind: 'chromiumSidecar', engine: 'streamedSurface', capture: true, media: true },
        { adapterKind: 'externalUrl', engine: 'desktopWebView', capture: true, media: true },
        { adapterKind: 'externalUrl', engine: 'desktopWebView', capture: false, media: false },
        { adapterKind: 'localPreview', engine: 'webIframe', capture: false, media: false },
        { adapterKind: 'externalUrl', engine: 'nativeWebView', capture: false, media: false },
        { adapterKind: 'streamedBrowserSurface', engine: 'streamedSurface', capture: false, media: false },
    ] as const)('admits media context only for the $adapterKind/$engine capture producer ($capture)', ({ adapterKind, engine, capture, media }) => {
        const caps = buildBrowserAdapterCapabilities({ adapterKind,
            supportedRenderEngines: [engine],
            desktopWebViewSupport: { ...DESKTOP_AUTOMATION_SUPPORT, capture },
            // The target kind does not grant the streamed viewer a screenshot producer.
            supportedTargetKinds: [engine === 'streamedSurface' ? 'streamedBrowser' : adapterKind === 'localPreview' ? 'localServicePreview' : 'externalUrl'],
        });
        expect(caps.contextKinds.includes('browserAnnotation')).toBe(media);
        expect(caps.contextKinds.includes('browserScreenshot')).toBe(media);
        if (media) expect(caps.diagnosticsFidelityByFamily.screenshot).toBe(engine === 'streamedSurface' ? 'cdp' : 'nativeCallback');
    });

    it.each(['webIframe', 'nativeWebView', 'desktopWebView'] as const)(
        'advertises only the executable injected contribution on %s, independently of human navigation and diagnostics',
        (engine) => {
            const caps = buildBrowserAdapterCapabilities({
                adapterKind: 'externalUrl',
                supportedTargetKinds: ['externalUrl'],
                supportedRenderEngines: [engine],
                desktopWebViewSupport: DESKTOP_AUTOMATION_SUPPORT,
            });
            const actions = caps.automationActions;
            if (!actions) throw new Error('Missing automation capability map');
            for (const entry of INJECTED_PAGE_AUTOMATION_ACTIONS) {
                expect(actions[entry.capability], entry.action).toMatchObject({
                    available: true,
                    fidelity: 'injectedPage',
                    trustedInput: false,
                    disabledReasons: [],
                });
            }
            expect(caps.navigation.canNavigate).toBe(true);
            expect(actions.navigate.available).toBe(false);
            expect(actions.elementPicker.available).toBe(false);
            expect(actions.evaluate.available).toBe(false);
            expect(actions.trustedInput.available).toBe(false);
            expect(actions.crossOriginFrameAccess.available).toBe(false);
        },
    );

    it('requires desktop native automation support without coupling capture or recording to it', () => {
        const caps = buildBrowserAdapterCapabilities({
            adapterKind: 'externalUrl',
            supportedTargetKinds: ['externalUrl'],
            supportedRenderEngines: ['desktopWebView'],
            desktopWebViewSupport: { ...DESKTOP_AUTOMATION_SUPPORT, automation: false },
            nativeViewCaptureHandlerRegistered: true,
        });
        const actions = caps.automationActions;
        if (!actions) throw new Error('Missing automation capability map');
        for (const entry of INJECTED_PAGE_AUTOMATION_ACTIONS) {
            expect(actions[entry.capability].available, entry.action).toBe(false);
        }
        expect(actions.screenshotReference.available).toBe(true);
        expect(actions.recording.available).toBe(true);
        expect(caps.navigation.canNavigate).toBe(true);
    });

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

    it.each([
        { adapterKind: 'localPreview', targetKind: 'localServicePreview', relay: true },
        { adapterKind: 'externalUrl', targetKind: 'externalUrl', relay: false },
        { adapterKind: 'hostedPlugin', targetKind: 'hostedPluginWeb', relay: false },
    ] as const)('offers web iframe history and stop only where a collector can report them: $adapterKind', ({ adapterKind, targetKind, relay }) => {
        // Both halves or neither: Back/Forward/Stop are claimed only for relay previews, whose documents
        // carry the navigation reporter. Every other framed page is cross-origin and keeps Reload alone.
        const { navigation } = buildBrowserAdapterCapabilities({
            adapterKind, supportedTargetKinds: [targetKind], supportedRenderEngines: ['webIframe'],
        });

        expect(navigation.canReload).toBe(true);
        expect(navigation.canGoBack).toBe(relay);
        expect(navigation.canGoForward).toBe(relay);
        expect(navigation.canStop).toBe(relay);
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

    it.each(['streamedBrowserSurface', 'chromiumSidecar'] as const)('exposes registered streamed display and daemon navigation for %s', (adapterKind) => {
        const caps = buildBrowserAdapterCapabilities({
            adapterKind,
            supportedTargetKinds: ['streamedBrowser'],
            supportedRenderEngines: ['streamedSurface'],
        });

        expect(caps.supportedRenderEngines).toEqual(['streamedSurface']);
        expect(caps.supportsStreamingDisplay).toBe(true);
        expect(caps.navigation.canNavigate).toBe(true);
        expect(caps.navigation.canReload).toBe(true);
        expect(caps.inputRouting).toBe('pmsControlSideband');
    });

    it.each([
        { adapterKind: 'chromiumSidecar', targetKind: 'externalUrl', engine: 'webIframe', reasonCode: 'sidecar_runtime_unavailable' },
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

describe('resolveBrowserNavigationVerbAvailability (AMD-8)', () => {
    it('gives a third-party page in the web iframe Reload, and a typed history reason for Back, Forward and Stop', () => {
        const caps = buildBrowserAdapterCapabilities({
            adapterKind: 'externalUrl', supportedTargetKinds: ['externalUrl'], supportedRenderEngines: ['webIframe'],
        });

        expect(resolveBrowserNavigationVerbAvailability(caps, 'reload')).toEqual({ available: true });
        expect(resolveBrowserNavigationVerbAvailability(caps, 'navigate')).toEqual({ available: true });
        for (const verb of ['goBack', 'goForward', 'stop'] as const) {
            expect(resolveBrowserNavigationVerbAvailability(caps, verb))
                .toEqual({ available: false, reasonCode: 'page_history_uncontrollable' });
        }
    });

    it.each([
        { adapterKind: 'localPreview', targetKind: 'localServicePreview', engine: 'webIframe' },
        { adapterKind: 'externalUrl', targetKind: 'externalUrl', engine: 'nativeWebView' },
    ] as const)('keeps every verb for a page Happier controls: $adapterKind on $engine', ({ adapterKind, targetKind, engine }) => {
        const caps = buildBrowserAdapterCapabilities({
            adapterKind, supportedTargetKinds: [targetKind], supportedRenderEngines: [engine],
        });

        for (const verb of ['navigate', 'goBack', 'goForward', 'reload', 'stop'] as const) {
            expect(resolveBrowserNavigationVerbAvailability(caps, verb)).toEqual({ available: true });
        }
    });

    it('reports a framed plugin page without history as plainly unavailable, not as a third-party page', () => {
        const caps = buildBrowserAdapterCapabilities({
            adapterKind: 'hostedPlugin', supportedTargetKinds: ['hostedPluginWeb'], supportedRenderEngines: ['webIframe'],
        });

        expect(resolveBrowserNavigationVerbAvailability(caps, 'goBack'))
            .toEqual({ available: false, reasonCode: 'adapter_unavailable' });
    });
});
