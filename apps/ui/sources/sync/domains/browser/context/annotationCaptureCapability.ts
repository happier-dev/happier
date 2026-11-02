import type {
    BrowserDiagnosticFidelityV1} from '@happier-dev/protocol/browser/diagnostics/v1';
import type {
    BrowserRenderEngineKindV1,
    BrowserSemanticAdapterKindV1,
} from '@happier-dev/protocol/browser/adapters/kinds';

/**
 * Annotation capture availability shared by Markup, its editor and the registered agent Action.
 * The host binds a real capture provider (desktop native snapshot or managed Chromium CDP), or
 * an already-produced media draft. An advertised engine capability alone cannot supply pixels.
 * The iframe collector supports page interaction, but supplies no screenshot capture producer.
 */
export type BrowserAnnotationCaptureCapability =
    | Readonly<{ available: true; fidelity: BrowserDiagnosticFidelityV1 }>
    | Readonly<{ available: false; disabledReason:
        | 'browser_context_annotation_capture_unavailable'
        | 'browser_context_annotation_iframe_capture_unavailable' }>;

export type ResolveBrowserAnnotationCaptureCapabilityInput = Readonly<{
    adapterKind: BrowserSemanticAdapterKindV1;
    primaryEngine: BrowserRenderEngineKindV1;
    /** A live available capture provider or an already-produced media draft is bound. */
    captureSourceAvailable: boolean;
}>;

const DISABLED: Extract<BrowserAnnotationCaptureCapability, { available: false }> = {
    available: false,
    disabledReason: 'browser_context_annotation_capture_unavailable',
};

export function resolveBrowserAnnotationCaptureCapability(
    input: ResolveBrowserAnnotationCaptureCapabilityInput,
): BrowserAnnotationCaptureCapability {
    if (!input.captureSourceAvailable) {
        return input.primaryEngine === 'webIframe'
            ? { available: false, disabledReason: 'browser_context_annotation_iframe_capture_unavailable' }
            : DISABLED;
    }

    if (input.adapterKind === 'chromiumSidecar') {
        return { available: true, fidelity: 'cdp' };
    }

    if (input.primaryEngine === 'desktopWebView') {
        return { available: true, fidelity: 'nativeCallback' };
    }

    return { available: true, fidelity: 'injectedPage' };
}
