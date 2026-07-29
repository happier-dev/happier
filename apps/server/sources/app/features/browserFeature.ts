import {
    BROWSER_RECORDING_CAPTURE_PROFILES,
    DEFAULT_BROWSER_AUTOMATION_CAPABILITIES,
    DEFAULT_BROWSER_CONTEXT_CAPABILITIES,
    DEFAULT_BROWSER_DIAGNOSTICS_CAPABILITIES,
    DEFAULT_BROWSER_RECORDING_CAPABILITIES,
    readServerEnabledBit,
    type BrowserAutomationActionKindV1,
    type BrowserCapabilities,
    type FeaturesResponse,
} from "@happier-dev/protocol";

import type { FeaturesPayloadDelta } from "./types";
import { readBrowserFeatureEnv, type BrowserFeatureEnv } from "./catalog/readFeatureEnv";

const FEATURE_DISABLED_REASON = "feature_disabled";

const BROWSER_TARGET_KINDS = [
    "localServicePreview",
    "hostedPluginWeb",
    "externalUrl",
    "simulatorPreview",
] as const;

const BROWSER_ADAPTER_KINDS = [
    "localPreview",
    "hostedPlugin",
    "externalUrl",
    "chromiumSidecar",
    "streamedBrowserSurface",
    "simulatorPreview",
] as const;

const BROWSER_PERMISSION_KINDS = [
    "origin",
    "downloads",
    "uploads",
    "clipboard",
    "camera",
    "microphone",
    "fileAccess",
    "popups",
    "browserUse",
] as const;

const BROWSER_DIAGNOSTIC_FAMILIES = [
    "console",
    "pageError",
    "network",
    "elements",
    "resources",
    "storage",
    "pageInfo",
    "performance",
    "screenshot",
    "proxyTunnel",
] as const;

const BROWSER_DIAGNOSTIC_FIDELITIES = [
    "cdp",
    "previewProxy",
    "injectedPage",
    "nativeCallback",
    "streamFrame",
] as const;

const BROWSER_CONTEXT_KINDS = [
    "browserPageReference",
    "browserScreenshot",
    "browserTextSelection",
    "browserPageTextSummary",
    "browserDomSnapshotSummary",
    "browserSelectedElement",
    "browserAnnotation",
    "browserRecordingEvidence",
    "browserNetworkSummary",
    "browserConsoleSummary",
] as const;

const BROWSER_AUTOMATION_ACTIONS = [
    "getStatus",
    "snapshot",
    "semanticSnapshot",
    "queryElements",
    "getDiagnosticsSummary",
    "getActionTimeline",
    "waitFor",
    "navigate",
    "reload",
    "goBack",
    "goForward",
    "click",
    "tap",
    "type",
    "press",
    "scroll",
    "hover",
    "focus",
    "select",
    "setValue",
] as const satisfies readonly BrowserAutomationActionKindV1[];

const BROWSER_AUTOMATION_FIDELITIES = [
    "cdp",
    "nativeWebView",
    "injectedPage",
    "previewProxy",
    "streamedSurface",
    "webIframe",
] as const;

function uniqueProfileValues<T extends string>(values: Iterable<T>): T[] {
    return [...new Set(values)];
}

const BROWSER_RECORDING_CAPTURE_KINDS = uniqueProfileValues(
    BROWSER_RECORDING_CAPTURE_PROFILES.map((profile) => profile.captureKind),
);

const BROWSER_RECORDING_ADAPTER_KINDS = uniqueProfileValues(
    BROWSER_RECORDING_CAPTURE_PROFILES.flatMap((profile) => profile.adapterKinds),
);

const BROWSER_RECORDING_MIME_TYPES = uniqueProfileValues(
    BROWSER_RECORDING_CAPTURE_PROFILES.flatMap((profile) => profile.mimeTypes),
);

const BROWSER_RECORDING_RETENTION_CLASSES = [
    "preSend",
    "attached",
    "clearOnClose",
    "clearOnSend",
    "diagnosticsOnly",
] as const;

function disabledReasons(enabled: boolean): string[] {
    return enabled ? [] : [FEATURE_DISABLED_REASON];
}

function valuesWhenEnabled<T>(enabled: boolean, values: readonly T[]): T[] {
    return enabled ? [...values] : [];
}

function resolveBrowserCapabilities(config: BrowserFeatureEnv): BrowserCapabilities {
    const viewTargetsEnabled = config.enabled && config.viewTargetsEnabled;
    const internalEnabled = viewTargetsEnabled && config.internalEnabled;
    const sidecarEnabled = internalEnabled && config.sidecarEnabled;
    const diagnosticsEnabled = internalEnabled && config.diagnosticsEnabled;
    const contextEnabled = internalEnabled && config.contextEnabled;
    const automationEnabled = internalEnabled && config.automationEnabled;
    const automationEvalEnabled = automationEnabled && diagnosticsEnabled;
    const recordingEnabled = internalEnabled && config.recordingEnabled;

    return {
        viewTargets: {
            enabled: viewTargetsEnabled,
            supportedTargetKinds: valuesWhenEnabled(viewTargetsEnabled, BROWSER_TARGET_KINDS),
            iframeAvailable: viewTargetsEnabled,
            webViewAvailable: viewTargetsEnabled,
            // Headless managed Chromium is represented by `sidecar` + `automation` capabilities.
            // Do not advertise a human `streamedBrowser` target until a streamed renderer/producer
            // exists for the browser view surface.
            streamedSurfaceAvailable: false,
            disabledReasons: disabledReasons(viewTargetsEnabled),
        },
        internal: {
            enabled: internalEnabled,
            supportedStorageModes: valuesWhenEnabled(internalEnabled, ["ephemeral", "session", "user", "plugin"] as const),
            supportedPermissionKinds: valuesWhenEnabled(internalEnabled, BROWSER_PERMISSION_KINDS),
            disabledReasons: disabledReasons(internalEnabled),
        },
        sidecar: {
            enabled: sidecarEnabled,
            available: sidecarEnabled,
            disabledReasons: disabledReasons(sidecarEnabled),
        },
        diagnostics: {
            ...DEFAULT_BROWSER_DIAGNOSTICS_CAPABILITIES,
            enabled: diagnosticsEnabled,
            available: diagnosticsEnabled,
            supportedFamilies: valuesWhenEnabled(diagnosticsEnabled, BROWSER_DIAGNOSTIC_FAMILIES),
            supportedFidelities: valuesWhenEnabled(diagnosticsEnabled, BROWSER_DIAGNOSTIC_FIDELITIES),
            supportedAdapterKinds: valuesWhenEnabled(diagnosticsEnabled, BROWSER_ADAPTER_KINDS),
            bodyCapture: diagnosticsEnabled ? "metadataOnly" : "unavailable",
            payloadCapture: diagnosticsEnabled ? "metadataOnly" : "unavailable",
            disabledReasons: disabledReasons(diagnosticsEnabled),
        },
        context: {
            ...DEFAULT_BROWSER_CONTEXT_CAPABILITIES,
            enabled: contextEnabled,
            available: contextEnabled,
            supportedContextKinds: valuesWhenEnabled(contextEnabled, BROWSER_CONTEXT_KINDS),
            supportedAdapterKinds: valuesWhenEnabled(contextEnabled, BROWSER_ADAPTER_KINDS),
            screenshot: {
                supported: contextEnabled,
                requiresAttachmentUploads: true,
            },
            disabledReasons: disabledReasons(contextEnabled),
            policyDeniedReasons: [],
        },
        automation: {
            ...DEFAULT_BROWSER_AUTOMATION_CAPABILITIES,
            enabled: automationEnabled,
            available: automationEnabled,
            supportedActions: valuesWhenEnabled(automationEnabled, BROWSER_AUTOMATION_ACTIONS),
            supportedFidelities: valuesWhenEnabled(automationEnabled, BROWSER_AUTOMATION_FIDELITIES),
            supportedAdapterKinds: valuesWhenEnabled(automationEnabled, BROWSER_ADAPTER_KINDS),
            injectedPage: {
                enabled: automationEnabled,
                available: automationEnabled,
                capabilityVersion: automationEnabled ? "1" : undefined,
                disabledReasons: disabledReasons(automationEnabled),
            },
            eval: {
                enabled: automationEvalEnabled,
                available: automationEvalEnabled,
                requiresDiagnosticsInteraction: true,
                disabledReasons: disabledReasons(automationEvalEnabled),
            },
            disabledReasons: disabledReasons(automationEnabled),
        },
        recording: {
            ...DEFAULT_BROWSER_RECORDING_CAPABILITIES,
            enabled: recordingEnabled,
            attachmentsEnabled: recordingEnabled,
            available: recordingEnabled,
            supportedCaptureKinds: valuesWhenEnabled(recordingEnabled, BROWSER_RECORDING_CAPTURE_KINDS),
            supportedMimeTypes: valuesWhenEnabled(recordingEnabled, BROWSER_RECORDING_MIME_TYPES),
            supportedAdapterKinds: valuesWhenEnabled(recordingEnabled, BROWSER_RECORDING_ADAPTER_KINDS),
            audioSupported: false,
            cursorOverlaySupported: recordingEnabled,
            actionTimelineChaptersSupported: recordingEnabled,
            supportedRetentionClasses: valuesWhenEnabled(recordingEnabled, BROWSER_RECORDING_RETENTION_CLASSES),
            disabledReasons: disabledReasons(recordingEnabled),
            policyDeniedReasons: [],
        },
    };
}

export function applyBrowserCapabilityFeatureGateClosure(payload: FeaturesResponse): void {
    payload.capabilities.browser = resolveBrowserCapabilities({
        enabled: readServerEnabledBit(payload, "browser") === true,
        viewTargetsEnabled: readServerEnabledBit(payload, "browser.viewTargets") === true,
        internalEnabled: readServerEnabledBit(payload, "browser.internal") === true,
        sidecarEnabled: readServerEnabledBit(payload, "browser.sidecar") === true,
        diagnosticsEnabled: readServerEnabledBit(payload, "browser.diagnostics") === true,
        contextEnabled: readServerEnabledBit(payload, "browser.context") === true,
        automationEnabled: readServerEnabledBit(payload, "browser.automation") === true,
        recordingEnabled: readServerEnabledBit(payload, "browser.recording") === true,
    });
}

export function resolveBrowserFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const config = readBrowserFeatureEnv(env);

    // Core browser surfaces are server-represented + default-allow: the server can disable the
    // browser surface for its users and the daemon/UI follow. The capability surfaces
    // (diagnostics/context/automation/recording) are ALSO server-represented + default-ALLOW per
    // §13.4 (one default posture): the capability is available, the dangerous agent-initiated
    // exercise is approval-gated by the active agent-approval floor. The managed Chromium sidecar is
    // source-backed in RU2, so it follows the same server-represented default-allow posture.
    // Dependency enforcement in resolveServerFeaturePayload cascades the parent off-state to the
    // children.
    return {
        features: {
            browser: {
                enabled: config.enabled,
                viewTargets: { enabled: config.viewTargetsEnabled },
                internal: { enabled: config.internalEnabled },
                sidecar: { enabled: config.sidecarEnabled },
                diagnostics: { enabled: config.diagnosticsEnabled },
                context: { enabled: config.contextEnabled },
                automation: { enabled: config.automationEnabled },
                recording: { enabled: config.recordingEnabled },
            },
        },
        capabilities: {
            browser: resolveBrowserCapabilities(config),
        },
    };
}
