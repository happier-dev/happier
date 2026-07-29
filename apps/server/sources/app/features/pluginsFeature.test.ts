import { readServerEnabledBit } from "@happier-dev/protocol";
import { describe, expect, it } from "vitest";

import { resolveServerFeaturePayload } from "./catalog/resolveServerFeaturePayload";
import { serverFeatureRegistry } from "./catalog/serverFeatureRegistry";

describe("plugins server feature resolver", () => {
    it("defaults the core plugin platform + UI gates to allow so plugins are on by default", () => {
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "plugins")).toBe(true);
        expect(readServerEnabledBit(payload, "plugins.ui")).toBe(true);
    });

    it("defaults the plugin UI tier kill-switches to allow so installed+enabled+trusted plugins can render (§4.1)", () => {
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, serverFeatureRegistry);

        // Server-represented + default-ALLOW kill-switches; per-plugin trust derivation (5.1/5.2)
        // still governs actual render.
        expect(readServerEnabledBit(payload, "plugins.ui.hostedWeb")).toBe(true);
        expect(readServerEnabledBit(payload, "plugins.ui.structuredMessages")).toBe(true);
        expect(readServerEnabledBit(payload, "plugins.ui.reactNativeBundles")).toBe(true);
    });

    it("treats a payload with no plugin UI tier projection as fail-closed (missing bit = disabled)", () => {
        // Old-server compatibility: when the resolver emits only the parent, the schema default
        // leaves each tier bit absent → readServerEnabledBit reads false.
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, [
            () => ({ features: { plugins: { enabled: true, ui: { enabled: true } } } }),
        ]);

        expect(readServerEnabledBit(payload, "plugins.ui.hostedWeb")).toBe(false);
        expect(readServerEnabledBit(payload, "plugins.ui.structuredMessages")).toBe(false);
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
    });

    it("lets a server disable just the plugin UI projection while keeping the platform on", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_PLUGINS_UI__ENABLED: "0",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "plugins")).toBe(true);
        expect(readServerEnabledBit(payload, "plugins.ui")).toBe(false);
    });
});
