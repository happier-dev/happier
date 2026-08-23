import type {
    BrowserSemanticAdapterKindV1,
    BrowserViewTargetKindV1,
} from '@happier-dev/protocol';

export type BrowserAdapterUnavailableReasonCode =
    | 'desktop_engine_unavailable'
    | 'desktop_webview_child_view_unverified'
    | 'desktop_webview_linux_display_unavailable'
    | 'desktop_webview_native_command_unavailable'
    | 'desktop_webview_native_contract_invalid'
    | 'desktop_webview_unsupported_platform'
    | 'desktop_webview_wayland_gtk_unimplemented'
    | 'desktop_webview_x11_child_unverified'
    | 'electron_engine_unavailable'
    | 'external_url_policy_denied'
    | 'external_url_unavailable'
    | 'simulator_preview_unavailable'
    | 'sidecar_runtime_unavailable'
    | 'streamed_browser_unavailable'
    | 'tauri_host_unavailable'
    | 'target_kind_unavailable';

export type BrowserAdapterUnavailableReason = Readonly<{
    reasonCode: BrowserAdapterUnavailableReasonCode;
    targetKind: BrowserViewTargetKindV1;
    requiredCapability:
        | 'browserStreamSurface'
        | 'chromiumSidecarRuntime'
        | 'desktopWebView'
        | 'electronWebContentsView'
        | 'policyBackedExternalBrowsing'
        | 'simulatorPreviewStream';
    blockedBy: readonly string[];
}>;

export function resolveDesktopWebViewUnavailableReason(
    targetKind: BrowserViewTargetKindV1,
    reasonCode: BrowserAdapterUnavailableReasonCode = 'desktop_engine_unavailable',
): BrowserAdapterUnavailableReason {
    return {
        reasonCode,
        targetKind,
        requiredCapability: 'desktopWebView',
        blockedBy: ['BRW-5'],
    };
}

export function resolveExternalUrlPolicyDeniedReason(
    targetKind: BrowserViewTargetKindV1,
): BrowserAdapterUnavailableReason {
    return {
        reasonCode: 'external_url_policy_denied',
        targetKind,
        requiredCapability: 'policyBackedExternalBrowsing',
        blockedBy: ['BRW-6'],
    };
}

export function resolveBrowserAdapterUnavailableReason(input: Readonly<{
    adapterKind: BrowserSemanticAdapterKindV1;
    targetKind: BrowserViewTargetKindV1;
}>): BrowserAdapterUnavailableReason {
    switch (input.adapterKind) {
        case 'externalUrl':
            return {
                reasonCode: 'external_url_unavailable',
                targetKind: input.targetKind,
                requiredCapability: 'policyBackedExternalBrowsing',
                blockedBy: ['BRW-5', 'BRW-6'],
            };
        case 'streamedBrowserSurface':
            return {
                reasonCode: 'streamed_browser_unavailable',
                targetKind: input.targetKind,
                requiredCapability: 'browserStreamSurface',
                blockedBy: ['BRW-7', 'BRW-8', 'PMS-8', 'SIM-5'],
            };
        case 'chromiumSidecar':
            return {
                reasonCode: 'sidecar_runtime_unavailable',
                targetKind: input.targetKind,
                requiredCapability: 'chromiumSidecarRuntime',
                blockedBy: ['BRW-7', 'BRW-7b', 'BRW-6'],
            };
        case 'localPreview':
        case 'hostedPlugin':
            return resolveDesktopWebViewUnavailableReason(input.targetKind);
        case 'simulatorPreview':
            return {
                reasonCode: 'simulator_preview_unavailable',
                targetKind: input.targetKind,
                requiredCapability: 'simulatorPreviewStream',
                blockedBy: ['SIM-1', 'SIM-5'],
            };
    }
}
