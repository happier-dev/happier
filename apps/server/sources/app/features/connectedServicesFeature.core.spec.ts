import { describe, expect, it } from "vitest";

import { resolveConnectedServicesFeature } from "./connectedServicesFeature";
import { FeaturesResponseSchema } from "@happier-dev/protocol/features/payload/featuresResponseSchema";
import { validateHomeSettingsWrite } from "@happier-dev/protocol/serverConfig/homeSettingsWrite";
import { SERVER_CONFIG_REGISTRY_BASE } from "@happier-dev/protocol/serverConfig/registry";

describe("resolveConnectedServicesFeature core contract", () => {
    it("advertises operator-configured qualified OAuth clients for any plugin and drops malformed rows", () => {
        const external = {
            service: { pluginId: "example.connected.accounts", localId: "cloud" },
            clientId: "external-public",
            scopesByMode: { "sign-in": null },
        };
        const cloudflare = {
            service: { pluginId: "happier.deploy.cloudflare", localId: "cloudflare" },
            clientId: "cloudflare-public",
            scopesByMode: { oauth: ["account.read", "workers.write"] },
        };
        const values = { HAPPIER_CONNECTED_SERVICES_PUBLIC_OAUTH_CLIENTS: [external, cloudflare] };
        expect(validateHomeSettingsWrite(SERVER_CONFIG_REGISTRY_BASE, { values })).toMatchObject({ ok: true, values });
        const read = (clients: unknown) => {
            const feature = resolveConnectedServicesFeature({
                HAPPIER_CONNECTED_SERVICES_PUBLIC_OAUTH_CLIENTS: JSON.stringify(clients),
            });
            return FeaturesResponseSchema.parse({
                features: feature.features, capabilities: feature.capabilities,
            }).capabilities.connectedServices.publicOAuthClients;
        };
        expect(read([external, cloudflare])).toEqual([external, cloudflare]);
        expect(read([external, { ...cloudflare, scopesByMode: { oauth: ["not a scope token"] } }])).toEqual([external]);
        expect(read([{ ...external, clientId: "bad\nclient" }, cloudflare])).toEqual([cloudflare]);
        expect(read([])).toBeUndefined();
        expect(read({})).toBeUndefined();
        expect(read(undefined)).toBeUndefined();
    });

    it("defaults to connected services enabled (including quotas)", () => {
        const feature = resolveConnectedServicesFeature({} as NodeJS.ProcessEnv);

        expect(feature.features?.connectedServices).toEqual({
            enabled: true,
            quotas: { enabled: true },
            subscription: { enabled: true },
            accountGroups: { enabled: true },
            accountFallback: { enabled: true },
            autoQuotaReset: { enabled: true },
            autoDisablePlanInvalid: { enabled: true },
            poolQuotaLimitSelection: { enabled: true },
        });
        expect(feature.capabilities?.connectedServices).toEqual({
            credentialDelete: { revisionGuard: true },
            qualifiedAccounts: { protocolVersion: 4 },
            credentialRemovalReview: { protocolVersion: 1 },
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
            subscription: { enabled: true },
            accountGroups: { enabled: true },
            accountFallback: { enabled: true },
            autoQuotaReset: { enabled: true },
            autoDisablePlanInvalid: { enabled: true },
            poolQuotaLimitSelection: { enabled: true },
        });
    });

    it("reads quota enablement independently", () => {
        const feature = resolveConnectedServicesFeature({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "0",
        } as NodeJS.ProcessEnv);

        expect(feature.features?.connectedServices).toEqual({
            enabled: true,
            quotas: { enabled: false },
            subscription: { enabled: true },
            accountGroups: { enabled: true },
            accountFallback: { enabled: true },
            autoQuotaReset: { enabled: true },
            autoDisablePlanInvalid: { enabled: true },
            poolQuotaLimitSelection: { enabled: true },
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
            subscription: { enabled: true },
            accountGroups: { enabled: false },
            accountFallback: { enabled: false },
            autoQuotaReset: { enabled: true },
            autoDisablePlanInvalid: { enabled: true },
            poolQuotaLimitSelection: { enabled: true },
        });
    });
});
