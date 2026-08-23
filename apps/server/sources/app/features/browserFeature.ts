import {
    BROWSER_RECORDING_CAPTURE_PROFILES,
    BrowserAutomationFidelityV1Schema,
    BrowserAutomationImplementedActionKindV1Schema,
    BrowserContextKindV1Schema,
    BrowserDiagnosticFamilyV1Schema,
    BrowserDiagnosticFidelityV1Schema,
    BrowserPermissionKindV1Schema,
    BrowserProfileStorageModeV1Schema,
    BrowserRecordingRetentionClassV1Schema,
    BrowserSemanticAdapterKindV1Schema,
    BrowserViewTargetKindV1Schema,
    DEFAULT_BROWSER_AUTOMATION_CAPABILITIES,
    DEFAULT_BROWSER_CONTEXT_CAPABILITIES,
    DEFAULT_BROWSER_DIAGNOSTICS_CAPABILITIES,
    DEFAULT_BROWSER_RECORDING_CAPABILITIES,
    readServerEnabledBit,
    type BrowserCapabilities,
    type FeaturesResponse,
} from "@happier-dev/protocol";

import type { FeaturesPayloadDelta } from "./types";
import { readBrowserFeatureEnv, type BrowserFeatureEnv } from "./catalog/readFeatureEnv";

const FEATURE_DISABLED_REASON = "feature_disabled";

/**
 * G19: every published browser enum is derived from the protocol schema that owns it. The server
 * previously hand-maintained nine copies of these lists; only one carried a type tie, and that tie
 * (`as const satisfies readonly T[]`) rejects an invalid member while being completely blind to an
 * omitted one. `BROWSER_TARGET_KINDS` had already drifted — it omitted `streamedBrowser`, which the
 * protocol declares — and the automation list silently stopped publishing every verb added to the
 * action union after it was written.
 *
 * Reading `.options` off the owning schema removes the copy outright: a member added to the protocol
 * is published automatically, and a member removed from it stops being published. The two places
 * where the server must publish *less* than the protocol declares are expressed as a checked
 * `.exclude(...)` with the reason, so the exclusion is a decision on the record rather than an
 * omission nobody notices.
 */

/**
 * `streamedBrowser` is deliberately withheld: there is no streamed renderer or producer for the
 * human browser view surface, which is the same fact `streamedSurfaceAvailable: false` publishes
 * below. Headless managed Chromium is represented by the `sidecar` + `automation` capabilities.
 */
const BROWSER_TARGET_KINDS = BrowserViewTargetKindV1Schema.exclude(["streamedBrowser"]).options;

const BROWSER_ADAPTER_KINDS = BrowserSemanticAdapterKindV1Schema.options;

const BROWSER_STORAGE_MODES = BrowserProfileStorageModeV1Schema.options;

const BROWSER_PERMISSION_KINDS = BrowserPermissionKindV1Schema.options;

const BROWSER_DIAGNOSTIC_FAMILIES = BrowserDiagnosticFamilyV1Schema.options;

/** `unavailable` is the absent-fidelity sentinel, not a fidelity the server can offer. */
const BROWSER_DIAGNOSTIC_FIDELITIES = BrowserDiagnosticFidelityV1Schema.exclude(["unavailable"]).options;

const BROWSER_CONTEXT_KINDS = BrowserContextKindV1Schema.options;

/**
 * The action union minus the verbs the daemon answers with `not_implemented`. Both sides read the
 * one protocol-owned list, so a verb can never be refused by the daemon while advertised here.
 */
const BROWSER_AUTOMATION_ACTIONS = BrowserAutomationImplementedActionKindV1Schema.options;

/** `unavailable` is the absent-fidelity sentinel, not a fidelity the server can offer. */
const BROWSER_AUTOMATION_FIDELITIES = BrowserAutomationFidelityV1Schema.exclude(["unavailable"]).options;

const BROWSER_RECORDING_RETENTION_CLASSES = BrowserRecordingRetentionClassV1Schema.options;

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
            supportedStorageModes: valuesWhenEnabled(internalEnabled, BROWSER_STORAGE_MODES),
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
