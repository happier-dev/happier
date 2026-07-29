import { BrowserAutomationActionKindV1Schema, readServerEnabledBit } from "@happier-dev/protocol";
import { describe, expect, it } from "vitest";

import { resolveServerFeaturePayload } from "./catalog/resolveServerFeaturePayload";
import { serverFeatureRegistry } from "./catalog/serverFeatureRegistry";

describe("browser server feature resolver", () => {
    it("defaults the core browser product gates to allow so the browser surface is on by default", () => {
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "browser")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.viewTargets")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.internal")).toBe(true);
        expect(payload.capabilities.browser.viewTargets).toMatchObject({
            enabled: true,
            supportedTargetKinds: [
                "localServicePreview",
                "hostedPluginWeb",
                "externalUrl",
                "simulatorPreview",
            ],
            iframeAvailable: true,
            webViewAvailable: true,
            streamedSurfaceAvailable: false,
            disabledReasons: [],
        });
        expect(payload.capabilities.browser.internal).toMatchObject({
            enabled: true,
            supportedStorageModes: ["ephemeral", "session", "user", "plugin"],
            supportedPermissionKinds: [
                "origin",
                "downloads",
                "uploads",
                "clipboard",
                "camera",
                "microphone",
                "fileAccess",
                "popups",
                "browserUse",
            ],
            disabledReasons: [],
        });
    });

    it("defaults the capability-available browser surfaces to allow (one default posture, §13.4)", () => {
        // §13.4: diagnostics is read-only devtools on your own page (IMMEDIATE split out of the
        // dangerous group). automation/context/recording carry the capability by default; the
        // dangerous *agent-initiated* exercise stays approval-gated by the active agent-approval
        // floor (`AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS`), so the server bit being on does
        // NOT bypass consent. user-initiated forms never prompt.
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "browser.diagnostics")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.context")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.recording")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.automation")).toBe(true);
        expect(payload.capabilities.browser.diagnostics).toMatchObject({
            enabled: true,
            available: true,
            supportedFamilies: [
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
            ],
            supportedFidelities: ["cdp", "previewProxy", "injectedPage", "nativeCallback", "streamFrame"],
            supportedAdapterKinds: [
                "localPreview",
                "hostedPlugin",
                "externalUrl",
                "chromiumSidecar",
                "streamedBrowserSurface",
                "simulatorPreview",
            ],
            bodyCapture: "metadataOnly",
            payloadCapture: "metadataOnly",
            disabledReasons: [],
        });
        expect(payload.capabilities.browser.context).toMatchObject({
            enabled: true,
            available: true,
            supportedContextKinds: [
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
            ],
            supportedAdapterKinds: [
                "localPreview",
                "hostedPlugin",
                "externalUrl",
                "chromiumSidecar",
                "streamedBrowserSurface",
                "simulatorPreview",
            ],
            screenshot: {
                supported: true,
                requiresAttachmentUploads: true,
            },
            disabledReasons: [],
        });
        expect(payload.capabilities.browser.recording).toMatchObject({
            enabled: true,
            attachmentsEnabled: true,
            available: true,
            supportedCaptureKinds: ["nativeViewCapture", "cdpScreencast", "streamFrameCapture"],
            supportedMimeTypes: ["image/png", "video/webm"],
            supportedAdapterKinds: [
                "externalUrl",
                "chromiumSidecar",
                "streamedBrowserSurface",
                "simulatorPreview",
            ],
            disabledReasons: [],
        });
        expect(payload.capabilities.browser.automation).toMatchObject({
            enabled: true,
            available: true,
            supportedActions: [
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
            ],
            supportedFidelities: ["cdp", "nativeWebView", "injectedPage", "previewProxy", "streamedSurface", "webIframe"],
            supportedAdapterKinds: [
                "localPreview",
                "hostedPlugin",
                "externalUrl",
                "chromiumSidecar",
                "streamedBrowserSurface",
                "simulatorPreview",
            ],
            injectedPage: {
                enabled: true,
                available: true,
            },
            eval: {
                enabled: true,
                available: true,
                requiresDiagnosticsInteraction: true,
            },
            disabledReasons: [],
        });
        expect(payload.capabilities.browser.automation.supportedActions).toEqual(
            BrowserAutomationActionKindV1Schema.options.filter((action) => ![
                "evaluate",
                "startElementPicker",
                "cancelElementPicker",
            ].includes(action)),
        );
        expect(payload.capabilities.browser.automation.supportedActions).not.toContain("evaluate");
        expect(payload.capabilities.browser.automation.supportedActions).not.toContain("startElementPicker");
        expect(payload.capabilities.browser.automation.supportedActions).not.toContain("cancelElementPicker");
    });

    it("defaults the managed-sidecar browser surface on after the managed Chromium sidecar shipped", () => {
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "browser.sidecar")).toBe(true);
        expect(payload.capabilities.browser.sidecar).toMatchObject({
            enabled: true,
            available: true,
            disabledReasons: [],
        });
    });

    it("lets a server disable an enabled-by-default capture surface via its own server bit", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_BROWSER_AUTOMATION__ENABLED: "0",
            HAPPIER_FEATURE_BROWSER_RECORDING__ENABLED: "0",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        // The capability gates are server-owned: an admin can independently disable agent automation
        // or recording while keeping the core browser surface + diagnostics on.
        expect(readServerEnabledBit(payload, "browser")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.internal")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.diagnostics")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.automation")).toBe(false);
        expect(readServerEnabledBit(payload, "browser.recording")).toBe(false);
        expect(payload.capabilities.browser.diagnostics.enabled).toBe(true);
        expect(payload.capabilities.browser.automation).toMatchObject({
            enabled: false,
            available: false,
            supportedActions: [],
            supportedFidelities: [],
            supportedAdapterKinds: [],
            disabledReasons: ["feature_disabled"],
        });
        expect(payload.capabilities.browser.recording).toMatchObject({
            enabled: false,
            attachmentsEnabled: false,
            available: false,
            supportedCaptureKinds: [],
            supportedAdapterKinds: [],
            disabledReasons: ["feature_disabled"],
        });
    });

    it("keeps browser automation on when its server bit is explicitly enabled", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_BROWSER_AUTOMATION__ENABLED: "1",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        // Automation is its own server-owned gate (default-allow per §13.4): an explicit on bit keeps
        // it enabled while the core browser surface stays on; it can be disabled independently while
        // keeping human browsing/devtools (see the explicit-disable test below).
        expect(readServerEnabledBit(payload, "browser")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.internal")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.automation")).toBe(true);
    });

    it("lets a server disable the browser surface for its users", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_BROWSER__ENABLED: "0",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "browser")).toBe(false);
        // Dependency enforcement cascades the parent off-state to the children.
        expect(readServerEnabledBit(payload, "browser.viewTargets")).toBe(false);
        expect(readServerEnabledBit(payload, "browser.internal")).toBe(false);
        expect(payload.capabilities.browser.viewTargets).toMatchObject({
            enabled: false,
            supportedTargetKinds: [],
            iframeAvailable: false,
            webViewAvailable: false,
            streamedSurfaceAvailable: false,
            disabledReasons: ["feature_disabled"],
        });
        expect(payload.capabilities.browser.internal).toMatchObject({
            enabled: false,
            supportedStorageModes: [],
            supportedPermissionKinds: [],
            disabledReasons: ["feature_disabled"],
        });
        expect(payload.capabilities.browser.diagnostics).toMatchObject({
            enabled: false,
            available: false,
            supportedFamilies: [],
            supportedFidelities: [],
            supportedAdapterKinds: [],
            disabledReasons: ["feature_disabled"],
        });
    });

    it("keeps capability facts fail-closed when build policy disables a represented browser feature", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_BUILD_FEATURES_DENY: "browser.diagnostics,browser.recording",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "browser")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.diagnostics")).toBe(false);
        expect(readServerEnabledBit(payload, "browser.recording")).toBe(false);
        expect(payload.capabilities.browser.diagnostics).toMatchObject({
            enabled: false,
            available: false,
            supportedFamilies: [],
            supportedFidelities: [],
            supportedAdapterKinds: [],
            disabledReasons: ["feature_disabled"],
        });
        expect(payload.capabilities.browser.recording).toMatchObject({
            enabled: false,
            attachmentsEnabled: false,
            available: false,
            supportedCaptureKinds: [],
            supportedAdapterKinds: [],
            disabledReasons: ["feature_disabled"],
        });
        expect(payload.capabilities.browser.automation.enabled).toBe(true);
        expect(payload.capabilities.browser.automation.eval).toMatchObject({
            enabled: false,
            available: false,
            requiresDiagnosticsInteraction: true,
            disabledReasons: ["feature_disabled"],
        });
        expect(payload.capabilities.browser.automation.supportedActions).not.toContain("evaluate");
    });

    it("allows enabling a capture surface only when the core surface stays on", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_BROWSER_CONTEXT__ENABLED: "1",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "browser")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.internal")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.context")).toBe(true);
    });
});
