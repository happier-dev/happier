import { readServerEnabledBit } from "@happier-dev/protocol";
import { describe, expect, it } from "vitest";

import { resolveServerFeaturePayload } from "./catalog/resolveServerFeaturePayload";
import { serverFeatureRegistry } from "./catalog/serverFeatureRegistry";
import { resolveProvidersFeature } from "./providersFeature";

describe("providers server feature resolver", () => {
    it("defaults first-class providers and their local capabilities to enabled", () => {
        expect(resolveProvidersFeature({} as NodeJS.ProcessEnv)).toEqual({
            features: {
                providers: {
                    enabled: true,
                    localDiscovery: { enabled: true },
                    localModelManagement: { enabled: true },
                },
            },
        });
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "providers")).toBe(true);
        expect(readServerEnabledBit(payload, "providers.localDiscovery")).toBe(true);
        expect(readServerEnabledBit(payload, "providers.localModelManagement")).toBe(true);
    });

    it("cascades parent and local-inventory dependencies without coupling model management to discovery", () => {
        const parentDisabled = resolveServerFeaturePayload({
            HAPPIER_FEATURE_PROVIDERS__ENABLED: "0",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);
        expect(readServerEnabledBit(parentDisabled, "providers")).toBe(false);
        expect(readServerEnabledBit(parentDisabled, "providers.localDiscovery")).toBe(false);
        expect(readServerEnabledBit(parentDisabled, "providers.localModelManagement")).toBe(false);

        const inventoryDisabled = resolveServerFeaturePayload({
            HAPPIER_FEATURE_LOCAL_SERVICES_INVENTORY__ENABLED: "0",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);
        expect(readServerEnabledBit(inventoryDisabled, "providers")).toBe(true);
        expect(readServerEnabledBit(inventoryDisabled, "providers.localDiscovery")).toBe(false);
        expect(readServerEnabledBit(inventoryDisabled, "providers.localModelManagement")).toBe(true);
    });

    it("fails closed when provider bits are missing or malformed", () => {
        const missing = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, [
            () => ({ features: {} }),
        ]);
        expect(readServerEnabledBit(missing, "providers")).toBe(false);
        expect(readServerEnabledBit(missing, "providers.localDiscovery")).toBe(false);
        expect(readServerEnabledBit(missing, "providers.localModelManagement")).toBe(false);

        const malformed = {
            features: {
                providers: {
                    enabled: "yes",
                    localDiscovery: { enabled: 1 },
                    localModelManagement: { enabled: null },
                },
            },
            capabilities: {},
        } as never;
        expect(readServerEnabledBit(malformed, "providers") === true).toBe(false);
        expect(readServerEnabledBit(malformed, "providers.localDiscovery") === true).toBe(false);
        expect(readServerEnabledBit(malformed, "providers.localModelManagement") === true).toBe(false);
    });
});
