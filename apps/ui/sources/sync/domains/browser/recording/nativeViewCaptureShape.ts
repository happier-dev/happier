import type {
    BrowserRenderEngineKindV1,
    BrowserSemanticAdapterKindV1,
    BrowserViewTargetKindV1,
} from '@happier-dev/protocol';

/**
 * The structural half of "can this view be recorded by native view capture": the target, adapter and
 * engine shape that the desktop reverse-capture path is built for. The other half — whether a
 * reverse-capture handler is actually registered for the machine — is runtime state owned by
 * `reverseCaptureAvailability.ts`.
 *
 * SB-C: three owners used to answer this question and the published one was simply wrong.
 * `adapters/capabilities.ts` hard-coded `automationActions.recording.available = false` for every
 * `desktopWebView` view — a false capability published over the protocol to agents and plugins while
 * the product records — and it was internally inconsistent with its own `screenshotReference` branch
 * fourteen lines above, which does consult `desktopWebViewSupport.capture`. Meanwhile
 * `reverseCaptureAvailability.ts` can return true for the same view and is what actually gates the
 * recording UI.
 *
 * This module is the one place the structural predicate is written, so the capability the protocol
 * publishes and the availability the product enforces cannot disagree about the shape.
 */
export function browserNativeViewCaptureShapeSupported(input: Readonly<{
    targetKind: BrowserViewTargetKindV1 | undefined;
    adapterKind: BrowserSemanticAdapterKindV1 | undefined;
    engineKind: BrowserRenderEngineKindV1 | undefined;
}>): boolean {
    return input.targetKind === 'externalUrl'
        && input.adapterKind === 'externalUrl'
        && input.engineKind === 'desktopWebView';
}
