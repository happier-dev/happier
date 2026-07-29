import type {
    BrowserDiagnosticEventV1,
    BrowserDiagnosticsElementPickerRequestV1,
    BrowserDiagnosticsElementPickerResultV1,
    BrowserDiagnosticsEvalRequestV1,
    BrowserDiagnosticsEvalResultV1,
    BrowserDiagnosticsGetPropertiesRequestV1,
    BrowserDiagnosticsGetPropertiesResultV1,
    BrowserDiagnosticsReleaseObjectGroupRequestV1,
    BrowserDiagnosticsReleaseObjectGroupResultV1,
} from '@happier-dev/protocol';
import type { BrowserAutomationControlService } from '@/sync/domains/browser/automation';

export type BrowserDiagnosticsMessageRejectionReason =
    | 'collector_mismatch'
    | 'invalid_json'
    | 'navigation_mismatch'
    | 'navigation_stale'
    | 'origin_mismatch'
    | 'schema_invalid'
    | 'source_mismatch'
    | 'unsupported_web_post_message'
    | 'wrong_kind';

export type BrowserDiagnosticsEngineBridgeConfig = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    collectorId: string;
    nonce: string;
    collectorVersion: string;
    sourceOrigin?: string;
    webPostMessageTargetOrigin?: string;
    /**
     * DEV-2: the LOCAL owner's `browser.diagnostics` value-capture policy. When set, the injected
     * collector emits length-capped local-owner values and the host re-sanitizer preserves them. Default
     * (unset) is fail-closed metadata-only. The egress classifier strips owner-only values for any
     * agent/remote destination regardless.
     */
    consoleValueCapture?: boolean;
    valueCapture?: boolean;
    evalRequest?: BrowserDiagnosticsEvalRequestV1;
    getPropertiesRequest?: BrowserDiagnosticsGetPropertiesRequestV1;
    releaseObjectGroupRequest?: BrowserDiagnosticsReleaseObjectGroupRequestV1;
    elementPickerRequest?: BrowserDiagnosticsElementPickerRequestV1;
    onCollectorScriptReady?: (script: string) => void;
    onEvents: (events: readonly BrowserDiagnosticEventV1[]) => void;
    onEvalResult?: (result: BrowserDiagnosticsEvalResultV1) => void;
    onPropertiesResult?: (result: BrowserDiagnosticsGetPropertiesResultV1) => void;
    onReleaseObjectGroupResult?: (result: BrowserDiagnosticsReleaseObjectGroupResultV1) => void;
    onElementPickerResult?: (result: BrowserDiagnosticsElementPickerResultV1) => void;
    onRejectedMessage?: (reasonCode: BrowserDiagnosticsMessageRejectionReason) => void;
}>;

export type BrowserAutomationEngineBridgeConfig = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    collectorId: string;
    nonce: string;
    capabilityVersion: string;
    adapterKind: string;
    sourceOrigin?: string;
    supportedActions: readonly string[];
    controlService: BrowserAutomationControlService;
    nowMs?: () => number;
    onRegistrationRejected?: (reasonCode: string) => void;
    onRejectedMessage?: (reasonCode: string) => void;
}>;

export type BrowserWebFrameMessageBridgeConfig = Readonly<{
    onMessage: (event: MessageEvent) => unknown | Promise<unknown>;
}>;

export type BrowserNativeFrameMessageBridgeConfig = Readonly<{
    onMessage: (event: Readonly<{
        nativeEvent?: Readonly<{
            data?: string;
            url?: string;
        }>;
    }>) => unknown | Promise<unknown>;
}>;

export type BrowserFrameNavigationCommand = Readonly<{
    commandId: string;
    kind: 'goBack' | 'goForward' | 'reload' | 'stop';
}>;

export type WebIframeEngineConfig = Readonly<{
    kind: 'webIframe';
    title: string;
    url: string;
    sandbox: string;
    testID: string;
    navigationKey?: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    referrerPolicy?: 'no-referrer';
    /**
     * Optional frame-level Content-Security-Policy applied via the iframe `csp`
     * attribute. Defense-in-depth in addition to the `sandbox` clamps and any
     * static-asset server response header — used by host-rendered plugin frames
     * so the frame carries a `default-src 'none'`-class policy regardless of the
     * served headers.
     */
    csp?: string;
    onLoad?: () => void;
    onError?: () => void;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
    automation?: BrowserAutomationEngineBridgeConfig;
    webMessageBridge?: BrowserWebFrameMessageBridgeConfig;
}>;

export type NativeWebViewEngineConfig = Readonly<{
    kind: 'nativeWebView';
    title: string;
    url: string;
    testID: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    originWhitelist: readonly string[];
    javaScriptEnabled?: boolean;
    mixedContentMode?: 'never' | 'compatibility' | 'always';
    onLoadStart?: () => void;
    onLoadEnd?: () => void;
    onError?: () => void;
    onBlockedNavigation?: (url: string) => void;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
    automation?: BrowserAutomationEngineBridgeConfig;
    nativeMessageBridge?: BrowserNativeFrameMessageBridgeConfig;
}>;

export type BrowserUnavailableEngineConfig = Readonly<{
    kind: 'unavailable';
    reasonCode: string;
    testID: string;
}>;

export type BrowserLoadingEngineConfig = Readonly<{
    kind: 'loading';
    testID: string;
}>;

export type BrowserErrorEngineConfig = Readonly<{
    kind: 'error';
    errorCode: string;
    testID: string;
    onReload?: () => void;
}>;

export type BrowserFrameEngineConfig =
    | WebIframeEngineConfig
    | NativeWebViewEngineConfig
    | BrowserUnavailableEngineConfig
    | BrowserLoadingEngineConfig
    | BrowserErrorEngineConfig;
