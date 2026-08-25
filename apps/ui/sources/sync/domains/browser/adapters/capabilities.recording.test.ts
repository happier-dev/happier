import type { BrowserAutomationActionCapabilityV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { browserViewCanUseNativeViewCapture } from '../recording/reverseCaptureAvailability';
import type { BrowserControlViewState } from '../control';
import { buildBrowserAdapterCapabilities } from './capabilities';

/**
 * SB-C. `automationActions.recording` was hard-coded `available: false` for every `desktopWebView`
 * view, while `recording/reverseCaptureAvailability.ts` could return true for the same view and is
 * what actually gates the recording UI. The published capability was therefore a false statement
 * made to agents and plugins about a thing the product does.
 *
 * These cases pin that the two now agree, and that the capability is still fail-closed for a caller
 * that cannot supply the runtime handler fact.
 */
const DESKTOP_WEBVIEW_SUPPORT = {
    navigation: true,
    goBackForward: false,
    reload: false,
    stop: false,
    pageInfoDiagnostics: false,
    nativeDevtools: false,
    capture: true,
    recording: false,
    automation: false,
} as const;

/**
 * `automationActions` is optional on `BrowserAdapterCapabilitiesV1`
 * (`protocol/browser/adapters/v1.ts`), so it cannot be indexed unguarded. Throwing here rather than
 * optional-chaining keeps a missing map a test failure instead of a silently-skipped assertion.
 */
function recordingCapabilityFor(input: Readonly<{
    nativeViewCaptureHandlerRegistered?: boolean;
    adapterKind?: 'externalUrl' | 'localPreview';
}>): BrowserAutomationActionCapabilityV1 {
    const actions = capabilitiesFor(input).automationActions;
    if (!actions) {
        throw new Error('buildBrowserAdapterCapabilities returned no automationActions');
    }
    return actions.recording;
}

function capabilitiesFor(input: Readonly<{
    nativeViewCaptureHandlerRegistered?: boolean;
    adapterKind?: 'externalUrl' | 'localPreview';
}>) {
    return buildBrowserAdapterCapabilities({
        adapterKind: input.adapterKind ?? 'externalUrl',
        supportedTargetKinds: [input.adapterKind === 'localPreview' ? 'localServicePreview' : 'externalUrl'],
        supportedRenderEngines: ['desktopWebView'],
        desktopWebViewSupport: DESKTOP_WEBVIEW_SUPPORT,
        ...(input.nativeViewCaptureHandlerRegistered === undefined
            ? {}
            : { nativeViewCaptureHandlerRegistered: input.nativeViewCaptureHandlerRegistered }),
    });
}

describe('published desktop-webview recording capability (SB-C)', () => {
    it('is available exactly when the reverse-capture owner would allow native view capture', () => {
        const view = {
            target: { kind: 'externalUrl' },
            adapterKind: 'externalUrl',
            engineKind: 'desktopWebView',
        } as unknown as BrowserControlViewState;
        // The structural half both sides now share.
        expect(browserViewCanUseNativeViewCapture(view)).toBe(true);

        expect(recordingCapabilityFor({ nativeViewCaptureHandlerRegistered: true }))
            .toMatchObject({ available: true, fidelity: 'nativeWebView' });
    });

    it('stays unavailable while no reverse-capture handler is registered', () => {
        expect(recordingCapabilityFor({ nativeViewCaptureHandlerRegistered: false }))
            .toMatchObject({ available: false, fidelity: 'unavailable' });
    });

    it('fails closed for a caller that cannot supply the runtime handler fact', () => {
        expect(recordingCapabilityFor({}))
            .toMatchObject({ available: false, fidelity: 'unavailable' });
    });

    it('stays unavailable for a view shape the reverse-capture owner rejects', () => {
        const view = {
            target: { kind: 'localServicePreview' },
            adapterKind: 'localPreview',
            engineKind: 'desktopWebView',
        } as unknown as BrowserControlViewState;
        expect(browserViewCanUseNativeViewCapture(view)).toBe(false);

        expect(recordingCapabilityFor({
            adapterKind: 'localPreview',
            nativeViewCaptureHandlerRegistered: true,
        })).toMatchObject({ available: false, fidelity: 'unavailable' });
    });
});
