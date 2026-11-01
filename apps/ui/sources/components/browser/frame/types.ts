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
import type { BrowserPreviewRefusalReasonCode } from '@/sync/domains/browser/adapters/targets/localPreview';

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

/**
 * The host->frame push direction (EU-8).
 *
 * The frame engine owns the delivery primitive — an exact-origin
 * `postMessage` into the iframe's own window, or a `MessageEvent` dispatched
 * into the native WebView — and nothing else. It hands that primitive to the
 * bridge owner through `attachHostMessages` for the frame's lifetime and takes
 * it back on unmount, so a retired frame can never be posted into and the
 * engine never learns what a host message means.
 */
export type BrowserFrameHostMessageAttachment = Readonly<{
    attachHostMessages: (send: (message: unknown) => void) => () => void;
}>;

/** Host-owned evidence attached to one physical frame message receipt. */
export type BrowserFrameMessageReceipt = Readonly<{
    /** Spend this exact receipt's transient activation at most once. */
    consumeTransientActivation(): boolean;
}>;

export type BrowserWebFrameMessageBridgeConfig = Readonly<{
    onMessage: (event: MessageEvent, receipt: BrowserFrameMessageReceipt) => unknown | Promise<unknown>;
    /** Bind authority to the exact admitted Document through a transferred port. */
    exactDocumentChannel?: boolean;
    /**
     * The exact origin every host->frame post is addressed to. Never `'*'`: a
     * wildcard would hand the message to whatever document happens to occupy
     * the frame after a navigation.
     */
    targetOrigin?: string;
    /**
     * Only an intentionally opaque sandboxed Artifact guest may require `*`:
     * source-window, nonce, qualified destination, and bound-lifetime checks
     * remain the caller authority before this delivery primitive is used.
     */
    allowWildcardTargetOrigin?: boolean;
}> & Partial<BrowserFrameHostMessageAttachment>;

export type BrowserNativeFrameMessageBridgeConfig = Readonly<{
    onMessage: (event: Readonly<{
        nativeEvent?: Readonly<{
            data?: string;
            url?: string;
        }>;
    }>, receipt: BrowserFrameMessageReceipt) => unknown | Promise<unknown>;
}> & Partial<BrowserFrameHostMessageAttachment>;

export type BrowserFrameNavigationCommand = Readonly<{
    commandId: string;
    kind: 'goBack' | 'goForward' | 'reload' | 'stop';
}>;

/**
 * An engine's own navigation snapshot, normalized at the engine boundary. Carries the back/forward
 * history flags the control reducer has no other producer for (G4); the adapter forwards it
 * verbatim as a `navigationStateChanged` lifecycle signal. Only engines with real history truth
 * report it — a sandboxed cross-origin iframe cannot read its guest's history and never does.
 */
export type BrowserFrameNavigationState = Readonly<{
    url?: string | null;
    navigationGeneration?: number;
    title?: string | null;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
}>;

/** Inline documents and navigable URLs are distinct frame sources. */
export type WebIframeSource =
    | Readonly<{ url: string; html?: never }>
    | Readonly<{ html: string; url?: never }>;

export type WebIframeEngineConfig = Readonly<{
    kind: 'webIframe';
    localPreview?: boolean;
    title: string;
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
    /** A relay preview's documents report their own history and loading; no other framed page can. */
    onNavigationStateChange?: (navigationState: BrowserFrameNavigationState) => void;
    /** The relay proxy refused the preview's document; the frame shows that state in place of the page. */
    onPreviewRefused?: (reasonCode: BrowserPreviewRefusalReasonCode) => void;
    /** What the preview's card offers in place of the page (see `BrowserFrameRecovery`). */
    recovery?: BrowserFrameRecovery;
    /**
     * An opaque Artifact guest cannot expose its loaded URL to the host. Its
     * first load is the declared entry; every later load retires the frame.
     */
    revokeOnUnexpectedNavigation?: boolean;
    onUnexpectedNavigation?: () => void;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
    automation?: BrowserAutomationEngineBridgeConfig;
    webMessageBridge?: BrowserWebFrameMessageBridgeConfig;
}> & WebIframeSource;

export type NativeWebViewSource =
    | Readonly<{ url: string; html?: never }>
    | Readonly<{ html: string; url?: never }>;

export type NativeWebViewEngineConfig = Readonly<{
    kind: 'nativeWebView';
    title: string;
    testID: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    originWhitelist: readonly string[];
    javaScriptEnabled?: boolean;
    mixedContentMode?: 'never' | 'compatibility' | 'always';
    onLoadStart?: () => void;
    onLoadEnd?: () => void;
    onError?: () => void;
    onNavigationStateChange?: (navigationState: BrowserFrameNavigationState) => void;
    onBlockedNavigation?: (url: string) => void;
    onUnexpectedNavigation?: () => void;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
    automation?: BrowserAutomationEngineBridgeConfig;
    nativeMessageBridge?: BrowserNativeFrameMessageBridgeConfig;
}> & NativeWebViewSource;

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

/**
 * The recovery a relay preview's card offers in place of the page. The Browser shell resolves it:
 * for an ended preview, the last page's title (or display address), the reopen through the Services opener
 * when the same Service runs now, the scope's way to Services, and closing the tab; for a preview it
 * cannot reach, trying again through the toolbar's reload.
 */
export type BrowserFrameRecovery = Readonly<{
    /** The serving Machine's existing display-name projection; absent rows never expose a raw id. */
    machineName?: string | null;
    lastPage?: string | null;
    onOpenAgain?: () => void | Promise<unknown>;
    /** Why the last Open again was refused, in the Services opener's own words. */
    openAgainFailure?: string | null;
    /** Current failed-start presentation and the Services row's existing sanitized output recovery. */
    serviceStartFailure?: Readonly<{
        reasonCode: string;
        title: string;
        body: string;
        recovery?: import('@/sync/domains/local/services/serviceFailure').LocalServiceOutputRecovery;
    }>;
    /** Current matching Service name, or the preview's retained display name after it disappears. */
    serviceName?: string | null;
    /** The Service this preview belongs to, when Services knows it has stopped. */
    stoppedServiceName?: string | null;
    /**
     * Start the stopped or failed Service through the Services row's own Start Action. The card binds the
     * Action admission; `run` settles its outcome under the shell's one Services outcome runner.
     */
    startAgain?: Readonly<{
        target: import('@/sync/domains/local/services/launch').LocalServiceLaunchTarget;
        serverId: string | null;
        run: (start: () => Promise<unknown>) => Promise<boolean>;
    }>;
    /** The scope's own way to its Services surface, when the scope has one. */
    onOpenServices?: () => void;
    onClose?: () => void;
    /** The toolbar's reload, offered as Try again on a preview the machine is not answering for. */
    onTryAgain?: () => void;
}>;
