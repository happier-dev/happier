import type {
    BrowserDiagnosticFidelityV1,
    BrowserRenderEngineKindV1,
    BrowserSemanticAdapterKindV1,
} from '@happier-dev/protocol';

/**
 * ANNO-6 engine matrix — the capability-truth owner for in-page annotation CAPTURE per render engine.
 * Feeds the editor overlay (disabled-with-reason tooltip) and BA-7's engine×capability closure matrix.
 *
 * Matrix:
 *  - desktop Wry (`desktopWebView` + native capture support) → FULL (`nativeCallback` snapshot clip).
 *  - managed Chromium (`chromiumSidecar`) → GATED: available only when the managed-capture feature
 *    gate is on (the CDP `Page.captureScreenshot({clip})` producer behind `featureGate.ts`).
 *  - web iframe / native RN webview / simulator / streamed surfaces → DISABLED with an explicit
 *    reason code so the editor surfaces a disabled-with-reason tooltip (never silently hidden).
 */
export type BrowserAnnotationCaptureCapability =
    | Readonly<{ available: true; fidelity: BrowserDiagnosticFidelityV1 }>
    | Readonly<{ available: false; disabledReason: 'browser_context_annotation_capture_unavailable' }>;

export type ResolveBrowserAnnotationCaptureCapabilityInput = Readonly<{
    adapterKind: BrowserSemanticAdapterKindV1;
    primaryEngine: BrowserRenderEngineKindV1;
    /** Desktop Wry native capture support (`DesktopWebViewSupport.capture`). */
    desktopCaptureSupported?: boolean;
    /** Managed-Chromium CDP capture feature gate (MCH-6). */
    managedCaptureGateEnabled?: boolean;
}>;

const DISABLED: Extract<BrowserAnnotationCaptureCapability, { available: false }> = {
    available: false,
    disabledReason: 'browser_context_annotation_capture_unavailable',
};

export function resolveBrowserAnnotationCaptureCapability(
    input: ResolveBrowserAnnotationCaptureCapabilityInput,
): BrowserAnnotationCaptureCapability {
    // Managed Chromium sidecar: gated on the CDP capture producer feature flag.
    if (input.adapterKind === 'chromiumSidecar') {
        return input.managedCaptureGateEnabled === true
            ? { available: true, fidelity: 'cdp' }
            : DISABLED;
    }

    // Desktop Wry webview: full editor + cropped capture when the native producer is present.
    if (input.primaryEngine === 'desktopWebView') {
        return input.desktopCaptureSupported === true
            ? { available: true, fidelity: 'nativeCallback' }
            : DISABLED;
    }

    // Web iframe + native RN webview + simulator/streamed surfaces cannot host the cropped capture
    // producer → annotation capture is disabled with an explicit reason.
    return DISABLED;
}
