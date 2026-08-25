import {
    BrowserAdapterCapabilitiesV1Schema,
    type BrowserAutomationActionCapabilityMapV1,
    type BrowserAutomationActionCapabilityV1,
    type BrowserAdapterCapabilitiesV1,
    type BrowserRenderEngineKindV1,
    type BrowserSemanticAdapterKindV1,
    type BrowserViewTargetKindV1,
} from '@happier-dev/protocol';

import {
    resolveDesktopWebViewUnavailableReason,
    resolveBrowserAdapterUnavailableReason,
    type BrowserAdapterUnavailableReason,
    type BrowserAdapterUnavailableReasonCode,
} from './availability';
import { browserNativeViewCaptureShapeSupported } from '../recording/nativeViewCaptureShape';
import type { DesktopWebViewSupport } from './desktopWebView';

type BuildBrowserAdapterCapabilitiesInput = Readonly<{
    adapterKind: BrowserSemanticAdapterKindV1;
    supportedTargetKinds: readonly BrowserViewTargetKindV1[];
    supportedRenderEngines: readonly BrowserRenderEngineKindV1[];
    desktopWebViewSupport?: DesktopWebViewSupport | null;
    /**
     * SB-C: whether a desktop reverse-capture handler is registered for this view's machine. It is
     * the runtime half of native-view-capture availability, owned by
     * `recording/reverseCaptureAvailability.ts`; the structural half is
     * {@link browserNativeViewCaptureShapeSupported}. Absent ⇒ the published `recording` capability
     * stays unavailable, which is the fail-closed answer and matches the pre-SB-C behaviour for any
     * caller that cannot supply the fact.
     */
    nativeViewCaptureHandlerRegistered?: boolean;
}>;

type BrowserAutomationDisabledReasonCode =
    | BrowserAdapterUnavailableReasonCode
    | 'desktop_webview_automation_unavailable'
    | 'hosted_plugin_automation_policy_unavailable';

function disabledAutomationAction(
    reasonCode: BrowserAutomationDisabledReasonCode,
): BrowserAutomationActionCapabilityV1 {
    return {
        available: false,
        fidelity: 'unavailable',
        trustedInput: false,
        disabledReasons: [reasonCode],
    };
}

function buildUnavailableAutomationActions(
    reasonCode: BrowserAutomationDisabledReasonCode,
): BrowserAutomationActionCapabilityMapV1 {
    const action = disabledAutomationAction(reasonCode);
    return {
        snapshot: action,
        semanticSnapshot: action,
        locatorQuery: action,
        navigate: action,
        click: action,
        tap: action,
        type: action,
        press: action,
        scroll: action,
        hover: action,
        upload: action,
        drag: action,
        waitFor: action,
        evaluate: action,
        elementPicker: action,
        screenshotReference: action,
        recording: action,
        trustedInput: action,
        crossOriginFrameAccess: action,
    };
}

function defaultTargetKindForAdapter(adapterKind: BrowserSemanticAdapterKindV1): BrowserViewTargetKindV1 {
    switch (adapterKind) {
        case 'localPreview':
            return 'localServicePreview';
        case 'hostedPlugin':
            return 'hostedPluginWeb';
        case 'externalUrl':
        case 'chromiumSidecar':
            return 'externalUrl';
        case 'streamedBrowserSurface':
            return 'streamedBrowser';
        case 'simulatorPreview':
            return 'simulatorPreview';
    }
}

function resolveUnavailableCapabilitiesReason(
    input: BuildBrowserAdapterCapabilitiesInput,
): BrowserAdapterUnavailableReason | null {
    if (input.supportedRenderEngines.includes('desktopWebView') && input.desktopWebViewSupport?.navigation !== true) {
        return resolveDesktopWebViewUnavailableReason(
            input.supportedTargetKinds[0] ?? defaultTargetKindForAdapter(input.adapterKind),
        );
    }
    if (
        input.adapterKind === 'externalUrl'
        && input.supportedRenderEngines.includes('desktopWebView')
        && input.desktopWebViewSupport?.navigation === true
    ) {
        return null;
    }
    // Web external URLs render best-effort in the sandboxed `webIframe` engine; non-framable sites
    // fall back to the always-present open-in-system-browser escape. So `externalUrl + webIframe` is
    // AVAILABLE with usable address-bar navigation — it must not dead-end as "unavailable", or
    // BrowserShell disables the address bar from `toolbar.canNavigate`. (chromiumSidecar /
    // streamedBrowserSurface still require their runtimes and fall through to unavailable below.)
    //
    // R-2: `nativeWebView` is the SAME story on iOS/Android, and it was missing. `selectBrowserTargetAdapter`
    // maps an allowed external URL on ios/android to the RN `WebView`, which hosts arbitrary
    // third-party sites outright and reports real history — yet this gate fell through and
    // collapsed the whole set to `supportedRenderEngines: ['unavailable']`, so every mobile
    // external-URL tab shipped a dead address bar and permanently disabled Back/Forward/Reload/Stop
    // no matter what the engine reported. Same defect class as G17, on the native arm.
    if (
        input.adapterKind === 'externalUrl'
        && (input.supportedRenderEngines.includes('webIframe')
            || input.supportedRenderEngines.includes('nativeWebView'))
    ) {
        return null;
    }
    if (
        input.adapterKind !== 'externalUrl'
        && input.adapterKind !== 'chromiumSidecar'
        && input.adapterKind !== 'streamedBrowserSurface'
    ) {
        return null;
    }
    // DEC-5: `streamedBrowserSurface` has NO escape from this gate any more. There is no producer
    // of a streamed target and no renderer for the kind, so a reachable daemon control transport
    // was never evidence that a surface exists — it only made this adapter publish a full navigable
    // capability set to agents and plugins for something that could not paint.
    return resolveBrowserAdapterUnavailableReason({
        adapterKind: input.adapterKind,
        targetKind: input.supportedTargetKinds[0] ?? defaultTargetKindForAdapter(input.adapterKind),
    });
}

function buildDiagnosticsFidelityByFamily(
    input: BuildBrowserAdapterCapabilitiesInput,
    primaryEngine: BrowserRenderEngineKindV1,
): BrowserAdapterCapabilitiesV1['diagnosticsFidelityByFamily'] {
    const pageInfoFidelity = primaryEngine === 'webIframe' || primaryEngine === 'nativeWebView'
        ? { pageInfo: 'nativeCallback' as const }
        : primaryEngine === 'desktopWebView' && input.desktopWebViewSupport?.pageInfoDiagnostics === true
            ? { pageInfo: 'nativeCallback' as const }
        : {};

    if (input.adapterKind === 'localPreview') {
        return {
            ...pageInfoFidelity,
            network: 'previewProxy',
            proxyTunnel: 'previewProxy',
            ...(primaryEngine === 'nativeWebView'
                ? {
                    console: 'injectedPage' as const,
                    pageError: 'injectedPage' as const,
                    resources: 'injectedPage' as const,
                    storage: 'injectedPage' as const,
                }
                : {}),
        };
    }

    if (primaryEngine === 'nativeWebView') {
        return {
            console: 'injectedPage',
            pageError: 'injectedPage',
            network: 'injectedPage',
            resources: 'injectedPage',
            storage: 'injectedPage',
            ...pageInfoFidelity,
        };
    }

    return pageInfoFidelity;
}

function buildBrowserAutomationActions(
    input: BuildBrowserAdapterCapabilitiesInput,
    primaryEngine: BrowserRenderEngineKindV1,
): BrowserAutomationActionCapabilityMapV1 {
    if (input.adapterKind === 'hostedPlugin') {
        return buildUnavailableAutomationActions('hosted_plugin_automation_policy_unavailable');
    }
    if (input.adapterKind === 'simulatorPreview' || primaryEngine === 'streamedSurface' || primaryEngine === 'unavailable') {
        return buildUnavailableAutomationActions('target_kind_unavailable');
    }
    if (primaryEngine === 'desktopWebView') {
        const screenshotReference: BrowserAutomationActionCapabilityV1 = input.desktopWebViewSupport?.capture === true
            ? {
                available: true,
                fidelity: 'nativeWebView',
                trustedInput: false,
                disabledReasons: [],
            }
            : {
                available: false,
                fidelity: 'unavailable',
                trustedInput: false,
                disabledReasons: ['screenshot_reference_unavailable'],
            };
        // SB-C: `recording` used to be hard-coded unavailable here while
        // `recording/reverseCaptureAvailability.ts` could return true for the same view — a false
        // capability published to agents and plugins. Both now answer from one structural predicate
        // plus the one runtime fact.
        const nativeViewCaptureShapeSupported = browserNativeViewCaptureShapeSupported({
            targetKind: input.supportedTargetKinds[0],
            adapterKind: input.adapterKind,
            engineKind: primaryEngine,
        });
        const nativeViewCaptureAvailable = nativeViewCaptureShapeSupported
            && input.nativeViewCaptureHandlerRegistered === true;
        const recording: BrowserAutomationActionCapabilityV1 = nativeViewCaptureAvailable
            ? {
                available: true,
                fidelity: 'nativeWebView',
                trustedInput: false,
                disabledReasons: [],
            }
            : {
                available: false,
                fidelity: 'unavailable',
                trustedInput: false,
                disabledReasons: ['browser_recording_capture_adapter_missing'],
            };
        return {
            ...buildUnavailableAutomationActions('desktop_webview_automation_unavailable'),
            screenshotReference,
            recording,
        } satisfies BrowserAutomationActionCapabilityMapV1;
    }

    const injectedPageAvailable = primaryEngine === 'webIframe'
        || primaryEngine === 'nativeWebView';
    const syntheticAction: BrowserAutomationActionCapabilityV1 = {
        available: injectedPageAvailable,
        fidelity: injectedPageAvailable ? 'injectedPage' : 'unavailable',
        trustedInput: false,
        disabledReasons: injectedPageAvailable ? [] : ['runtime_unavailable'],
    };
    const navigationAvailable = primaryEngine === 'webIframe' || primaryEngine === 'nativeWebView';

    return {
        snapshot: syntheticAction,
        semanticSnapshot: syntheticAction,
        locatorQuery: syntheticAction,
        click: syntheticAction,
        tap: syntheticAction,
        type: syntheticAction,
        press: syntheticAction,
        scroll: syntheticAction,
        hover: syntheticAction,
        // Injected-page `upload` attaches payload-supplied file content to a file input; it cannot
        // read a host path from the page. `drag` synthesises the HTML5 drag sequence. Both are
        // untrusted synthetic input, exactly like `click`/`type`.
        upload: syntheticAction,
        drag: syntheticAction,
        waitFor: syntheticAction,
        navigate: {
            available: navigationAvailable,
            fidelity: navigationAvailable ? (primaryEngine === 'nativeWebView' ? 'nativeWebView' : 'webIframe') : 'unavailable',
            trustedInput: false,
            disabledReasons: navigationAvailable ? [] : ['unsupported_action'],
        } satisfies BrowserAutomationActionCapabilityV1,
        evaluate: {
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['browser_automation_eval_disabled'],
        } satisfies BrowserAutomationActionCapabilityV1,
        elementPicker: syntheticAction,
        screenshotReference: {
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['screenshot_reference_unavailable'],
        } satisfies BrowserAutomationActionCapabilityV1,
        recording: {
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['browser_recording_capture_adapter_missing'],
        } satisfies BrowserAutomationActionCapabilityV1,
        trustedInput: {
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['trusted_input_unavailable'],
        } satisfies BrowserAutomationActionCapabilityV1,
        crossOriginFrameAccess: {
            available: false,
            fidelity: 'unavailable',
            trustedInput: false,
            disabledReasons: ['cross_origin_frame_unavailable'],
        } satisfies BrowserAutomationActionCapabilityV1,
    };
}

export function buildBrowserAdapterCapabilities(
    input: BuildBrowserAdapterCapabilitiesInput,
): BrowserAdapterCapabilitiesV1 {
    const unavailableReason = resolveUnavailableCapabilitiesReason(input);
    if (unavailableReason) {
        return BrowserAdapterCapabilitiesV1Schema.parse({
            adapterKind: input.adapterKind,
            supportedTargetKinds: input.supportedTargetKinds,
            supportedRenderEngines: ['unavailable'],
            navigation: {},
            diagnosticsFidelityByFamily: {},
            automationActions: buildUnavailableAutomationActions(unavailableReason.reasonCode),
            contextKinds: [],
            inputRouting: 'none',
            supportsStreamingDisplay: false,
            disabledReasons: [unavailableReason.reasonCode],
        });
    }

    const primaryEngine = input.supportedRenderEngines[0] ?? 'unavailable';
    const simulatorPreview = input.adapterKind === 'simulatorPreview';
    const desktopWebViewNavigation = primaryEngine === 'desktopWebView'
        ? input.desktopWebViewSupport
        : null;
    return BrowserAdapterCapabilitiesV1Schema.parse({
        adapterKind: input.adapterKind,
        supportedTargetKinds: input.supportedTargetKinds,
        supportedRenderEngines: input.supportedRenderEngines,
        navigation: {
            canNavigate: !simulatorPreview && (
                primaryEngine === 'webIframe'
                || primaryEngine === 'nativeWebView'
                || desktopWebViewNavigation?.navigation === true
            ),
            canGoBack: !simulatorPreview && (
                primaryEngine === 'nativeWebView'
                || desktopWebViewNavigation?.goBackForward === true
            ),
            canGoForward: !simulatorPreview && (
                primaryEngine === 'nativeWebView'
                || desktopWebViewNavigation?.goBackForward === true
            ),
            canReload: !simulatorPreview && (
                primaryEngine === 'webIframe'
                || primaryEngine === 'nativeWebView'
                || desktopWebViewNavigation?.reload === true
            ),
            canStop: !simulatorPreview && (
                primaryEngine === 'nativeWebView'
                || desktopWebViewNavigation?.stop === true
            ),
        },
        diagnosticsFidelityByFamily: buildDiagnosticsFidelityByFamily(input, primaryEngine),
        automationActions: buildBrowserAutomationActions(input, primaryEngine),
        contextKinds: ['browserPageReference'],
        inputRouting: simulatorPreview
            ? 'pmsControlSideband'
            : primaryEngine === 'nativeWebView' || primaryEngine === 'desktopWebView' ? 'native' : 'none',
        supportsStreamingDisplay: simulatorPreview || primaryEngine === 'streamedSurface',
    });
}
