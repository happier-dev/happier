import { describe, expect, it } from "vitest";

import { resolveConnectedServicesFeature } from "./connectedServicesFeature";

describe("resolveConnectedServicesFeature", () => {
    it("defaults to connected services enabled (including quotas)", () => {
        const feature = resolveConnectedServicesFeature({} as NodeJS.ProcessEnv);

        expect(feature.features?.connectedServices).toEqual({
            enabled: true,
            quotas: { enabled: false },
        });
    });

    it("reads quotas enablement independently from connected services enablement", () => {
        const feature = resolveConnectedServicesFeature({
            HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: "0",
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1",
        } as NodeJS.ProcessEnv);

        expect(feature.features?.connectedServices).toEqual({
            enabled: false,
            quotas: { enabled: true },
        });
    });

    it("enables quotas when explicitly enabled by env", () => {
        const feature = resolveConnectedServicesFeature({
            HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: "1",
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1",
        } as NodeJS.ProcessEnv);

        expect(feature.features?.connectedServices).toEqual({
            enabled: true,
            quotas: { enabled: true },
        });
    });
});
