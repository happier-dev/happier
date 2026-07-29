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
import type { DesktopWebViewSupport } from './desktopWebView';

type BuildBrowserAdapterCapabilitiesInput = Readonly<{
    adapterKind: BrowserSemanticAdapterKindV1;
    supportedTargetKinds: readonly BrowserViewTargetKindV1[];
    supportedRenderEngines: readonly BrowserRenderEngineKindV1[];
    desktopWebViewSupport?: DesktopWebViewSupport | null;
    // True when a managed daemon/sidecar Chromium is live behind a `streamedBrowserSurface`
    // adapter. It flips the surface from fail-closed unavailable to an available, navigable
    // daemon-authoritative view whose navigation/lifecycle is driven over the daemon control
    // transport. Only meaningful for `adapterKind === 'streamedBrowserSurface'`.
    streamedSurfaceLive?: boolean;
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
    if (
        input.adapterKind === 'externalUrl'
        && input.supportedRenderEngines.includes('webIframe')
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
    // A live managed daemon/sidecar Chromium backs the streamed surface: it is available (its
    // runtime owner exists), unlike the fail-closed default and unlike `chromiumSidecar`, which
    // still has no UI-reachable runtime here.
    if (input.adapterKind === 'streamedBrowserSurface' && input.streamedSurfaceLive === true) {
        return null;
    }
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
        return {
            ...buildUnavailableAutomationActions('desktop_webview_automation_unavailable'),
            screenshotReference,
            recording: {
                available: false,
                fidelity: 'unavailable',
                trustedInput: false,
                disabledReasons: ['browser_recording_capture_adapter_missing'],
            },
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
    // A live `streamedBrowserSurface` is a daemon-driven real Chromium: navigation/lifecycle is
    // fully supported and routed over the daemon control transport (the `daemonCommand` effect),
    // so its address bar and back/forward/reload/stop must be enabled. (We only reach this branch
    // for a streamed surface when it is live; otherwise the unavailable gate returned above.)
    const daemonStreamedBrowser = input.adapterKind === 'streamedBrowserSurface';
    return BrowserAdapterCapabilitiesV1Schema.parse({
        adapterKind: input.adapterKind,
        supportedTargetKinds: input.supportedTargetKinds,
        supportedRenderEngines: input.supportedRenderEngines,
        navigation: {
            canNavigate: daemonStreamedBrowser || (!simulatorPreview && (
                primaryEngine === 'webIframe'
                || primaryEngine === 'nativeWebView'
                || desktopWebViewNavigation?.navigation === true
            )),
            canGoBack: daemonStreamedBrowser || (!simulatorPreview && (
                primaryEngine === 'nativeWebView'
                || desktopWebViewNavigation?.goBackForward === true
            )),
            canGoForward: daemonStreamedBrowser || (!simulatorPreview && (
                primaryEngine === 'nativeWebView'
                || desktopWebViewNavigation?.goBackForward === true
            )),
            canReload: daemonStreamedBrowser || (!simulatorPreview && (
                primaryEngine === 'webIframe'
                || primaryEngine === 'nativeWebView'
                || desktopWebViewNavigation?.reload === true
            )),
            canStop: daemonStreamedBrowser || (!simulatorPreview && (
                primaryEngine === 'nativeWebView'
                || desktopWebViewNavigation?.stop === true
            )),
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
