import { describe, expect, it } from "vitest";

import { resolveConnectedServicesFeature } from "./connectedServicesFeature";

describe("resolveConnectedServicesFeature core contract", () => {
    it("defaults to connected services enabled (including quotas)", () => {
        const feature = resolveConnectedServicesFeature({} as NodeJS.ProcessEnv);

        expect(feature.features?.connectedServices).toEqual({
            enabled: true,
            quotas: { enabled: true },
            accountGroups: { enabled: true },
            accountFallback: { enabled: true },
        });
        expect(feature.capabilities?.connectedServices).toEqual({
            credentialDelete: { revisionGuard: true },
            qualifiedAccounts: { protocolVersion: 4 },
        });
    });

    it("ignores the retired master env while preserving the compatibility wire bit", () => {
        const feature = resolveConnectedServicesFeature({
            HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: "0",
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1",
        } as NodeJS.ProcessEnv);

        expect(feature.features?.connectedServices).toEqual({
            enabled: true,
            quotas: { enabled: true },
            accountGroups: { enabled: true },
            accountFallback: { enabled: true },
        });
    });

    it("reads quota enablement independently", () => {
        const feature = resolveConnectedServicesFeature({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "0",
        } as NodeJS.ProcessEnv);

        expect(feature.features?.connectedServices).toEqual({
            enabled: true,
            quotas: { enabled: false },
            accountGroups: { enabled: true },
            accountFallback: { enabled: true },
        });
    });

    it("reads account group and fallback enablement independently", () => {
        const feature = resolveConnectedServicesFeature({
            HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: "0",
            HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: "0",
        } as NodeJS.ProcessEnv);

        expect(feature.features?.connectedServices).toEqual({
            enabled: true,
            quotas: { enabled: true },
            accountGroups: { enabled: false },
            accountFallback: { enabled: false },
        });
    });
});
