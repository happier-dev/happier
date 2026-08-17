import { readServerEnabledBit } from "@happier-dev/protocol";
import { describe, expect, it } from "vitest";

import { resolveServerFeaturePayload } from "./catalog/resolveServerFeaturePayload";
import { serverFeatureRegistry } from "./catalog/serverFeatureRegistry";
import { resolvePluginsFeature } from "./pluginsFeature";

describe("plugins server feature resolver", () => {
    it("projects the Collection deployment policy through the additive top-level capability family", () => {
        const defaulted = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, serverFeatureRegistry);
        expect(defaulted.capabilities.pluginDataCollections).toEqual({
            maxRowEncodedBytes: 512 * 1024,
            maxBatchBytes: 16 * 1024 * 1024,
            maxBatchRows: 100,
            maxAccountRows: 10_000,
            maxAccountBytes: 256 * 1024 * 1024,
        });
        expect(defaulted.capabilities.plugins).not.toHaveProperty("pluginDataCollections");
        expect(defaulted.capabilities.server).not.toHaveProperty("pluginDataCollections");

        const configured = resolveServerFeaturePayload({
            HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES: "600000",
            HAPPIER_COLLECTION_MAX_BATCH_BYTES: "18000000",
            HAPPIER_COLLECTION_MAX_BATCH_ROWS: "90",
            HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: "12000",
            HAPPIER_COLLECTION_MAX_ACCOUNT_BYTES: "300000000",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);
        expect(configured.capabilities.pluginDataCollections).toEqual({
            maxRowEncodedBytes: 600_000,
            maxBatchBytes: 18_000_000,
            maxBatchRows: 90,
            maxAccountRows: 12_000,
            maxAccountBytes: 300_000_000,
        });
    });

    it("defaults the core plugin platform + UI gates to allow so plugins are on by default", () => {
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "plugins")).toBe(true);
        expect(readServerEnabledBit(payload, "plugins.ui")).toBe(true);
    });

    it("keeps public webhook ingress fail-closed until an operator deliberately enables it", () => {
        const defaulted = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, serverFeatureRegistry);
        expect(readServerEnabledBit(defaulted, "plugins.webhooks")).toBe(false);

        const enabled = resolveServerFeaturePayload({
            HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);
        expect(readServerEnabledBit(enabled, "plugins.webhooks")).toBe(true);
    });

    it("keeps Account UI artifact hosting disabled until an operator configures coherent limits", () => {
        const defaulted = resolvePluginsFeature({} as NodeJS.ProcessEnv);
        expect(defaulted.capabilities).toMatchObject({
            plugins: { uiArtifactHosting: { enabled: false } },
        });

        const enabled = resolvePluginsFeature({
            HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__ENABLED: "1",
            HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: "1024",
            HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: "4096",
        } as NodeJS.ProcessEnv);
        expect(enabled.capabilities).toMatchObject({
            plugins: {
                uiArtifactHosting: {
                    enabled: true,
                    maxArtifactBytes: 1024,
                    maxAccountBytes: 4096,
                },
            },
        });

        const incoherentLimits = resolvePluginsFeature({
            HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__ENABLED: "1",
            HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: "4096",
            HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: "1024",
        } as NodeJS.ProcessEnv);
        expect(incoherentLimits.capabilities).toMatchObject({
            plugins: { uiArtifactHosting: { enabled: false } },
        });
    });

    it("defaults supported plugin UI tier kill-switches to allow and omits deferred structured messages (§4.1)", () => {
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, serverFeatureRegistry);

        // Server-represented + default-ALLOW kill-switches; per-plugin trust derivation (5.1/5.2)
        // still governs actual render.
        expect(readServerEnabledBit(payload, "plugins.ui.hostedWeb")).toBe(true);
        expect(payload.features.plugins?.ui).not.toHaveProperty("structuredMessages");
        expect(readServerEnabledBit(payload, "plugins.ui.reactNativeBundles")).toBe(true);
    });

    it("treats a payload with no plugin UI tier projection as fail-closed (missing bit = disabled)", () => {
        // Old-server compatibility: when the resolver emits only the parent, the schema default
        // leaves each tier bit absent → readServerEnabledBit reads false.
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, [
            () => ({ features: { plugins: { enabled: true, ui: { enabled: true } } } }),
        ]);

        expect(readServerEnabledBit(payload, "plugins.ui.hostedWeb")).toBe(false);
        expect(payload.features.plugins?.ui).not.toHaveProperty("structuredMessages");
        expect(readServerEnabledBit(payload, "plugins.ui.reactNativeBundles")).toBe(false);
    });

    it("lets a server disable an individual plugin UI tier independently", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_PLUGINS_UI_REACT_NATIVE_BUNDLES__ENABLED: "0",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "plugins.ui.hostedWeb")).toBe(true);
        expect(readServerEnabledBit(payload, "plugins.ui.reactNativeBundles")).toBe(false);
    });

    it("lets a server disable the plugin surface for its users", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_PLUGINS__ENABLED: "0",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "plugins")).toBe(false);
        // Dependency enforcement cascades the parent off-state to the UI projection child.
        expect(readServerEnabledBit(payload, "plugins.ui")).toBe(false);
        expect(readServerEnabledBit(payload, "plugins.webhooks")).toBe(false);
    });

    it("lets a server disable just the plugin UI projection while keeping the platform on", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_PLUGINS_UI__ENABLED: "0",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "plugins")).toBe(true);
        expect(readServerEnabledBit(payload, "plugins.ui")).toBe(false);
    });
});
