import { describe, expect, it } from "vitest";

import { resolveConnectedServicesFeature } from "./connectedServicesFeature";

describe("resolveConnectedServicesFeature", () => {
    it("defaults to connected services enabled (including quotas)", () => {
        const feature = resolveConnectedServicesFeature({} as NodeJS.ProcessEnv);

        expect(feature.connectedServices).toEqual({
            enabled: true,
            webOauthProxyEnabled: true,
            quotas: { enabled: false },
        });
    });

    it("disables quotas when connected services are disabled by env", () => {
        const feature = resolveConnectedServicesFeature({
            HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: "0",
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1",
        } as NodeJS.ProcessEnv);

        expect(feature.connectedServices).toEqual({
            enabled: false,
            webOauthProxyEnabled: false,
            quotas: { enabled: false },
        });
    });

    it("hard-disables connected services when build policy denies the feature", () => {
        const feature = resolveConnectedServicesFeature({
            HAPPIER_BUILD_FEATURES_DENY: "connected.services",
            HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: "1",
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1",
        } as NodeJS.ProcessEnv);

        expect(feature.connectedServices).toEqual({
            enabled: false,
            webOauthProxyEnabled: false,
            quotas: { enabled: false },
        });
    });

    it("hard-disables quotas when build policy denies the sub-feature", () => {
        const feature = resolveConnectedServicesFeature({
            HAPPIER_BUILD_FEATURES_DENY: "connected.services.quotas",
            HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: "1",
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1",
        } as NodeJS.ProcessEnv);

        expect(feature.connectedServices).toEqual({
            enabled: true,
            webOauthProxyEnabled: true,
            quotas: { enabled: false },
        });
    });
});
