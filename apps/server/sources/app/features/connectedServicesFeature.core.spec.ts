import { describe, expect, it } from "vitest";

import { resolveConnectedServicesFeature } from "./connectedServicesFeature";
import { FeaturesResponseSchema } from "@happier-dev/protocol/features/payload/featuresResponseSchema";
import { validateHomeSettingsWrite } from "@happier-dev/protocol/serverConfig/homeSettingsWrite";
import { SERVER_CONFIG_REGISTRY_BASE } from "@happier-dev/protocol/serverConfig/registry";

describe("resolveConnectedServicesFeature core contract", () => {
    it("delivers the Home operator's public OAuth client through the real configuration and feature contracts", () => {
        const values = {
            HAPPIER_CONNECTED_SERVICES_CLOUDFLARE_OAUTH_CLIENT_ID: "happier-public-client",
            HAPPIER_CONNECTED_SERVICES_CLOUDFLARE_OAUTH_SCOPES: ["account.read", "scripts.write", "ci.write", "pages.write"],
        };
        expect(validateHomeSettingsWrite(SERVER_CONFIG_REGISTRY_BASE, { values })).toMatchObject({ ok: true, values });
        const feature = resolveConnectedServicesFeature({
            HAPPIER_CONNECTED_SERVICES_CLOUDFLARE_OAUTH_CLIENT_ID: values.HAPPIER_CONNECTED_SERVICES_CLOUDFLARE_OAUTH_CLIENT_ID,
            HAPPIER_CONNECTED_SERVICES_CLOUDFLARE_OAUTH_SCOPES: "account.read,scripts.write,ci.write,pages.write",
        });
        const consumed = FeaturesResponseSchema.parse({ features: feature.features, capabilities: feature.capabilities });
        expect(Reflect.get(consumed.capabilities.connectedServices, "publicOAuthClients")).toEqual([{
            service: { pluginId: "happier.deploy.cloudflare", localId: "cloudflare" },
            clientId: "happier-public-client",
            scopesByMode: {
                oauth: ["account.read", "scripts.write", "ci.write", "pages.write"],
            },
        }]);
        const absent = resolveConnectedServicesFeature({});
        expect(Reflect.get(absent.capabilities?.connectedServices ?? {}, "publicOAuthClients")).toBeUndefined();
    });

    it("advertises the Vercel public client only when its client id is set, beside Cloudflare", () => {
        const vercel = {
            service: { pluginId: "happier.machine.vercel", localId: "vercel-account" },
            clientId: "cl_vercel_public",
            scopesByMode: { oauth: ["openid", "email", "profile", "offline_access"] },
        };
        const values = { HAPPIER_CONNECTED_SERVICES_VERCEL_OAUTH_CLIENT_ID: vercel.clientId };
        expect(validateHomeSettingsWrite(SERVER_CONFIG_REGISTRY_BASE, { values })).toMatchObject({ ok: true, values });
        const consumed = (env: NodeJS.ProcessEnv) => {
            const feature = resolveConnectedServicesFeature(env);
            const parsed = FeaturesResponseSchema.parse({ features: feature.features, capabilities: feature.capabilities });
            return Reflect.get(parsed.capabilities.connectedServices, "publicOAuthClients");
        };
        expect(consumed({ HAPPIER_CONNECTED_SERVICES_VERCEL_OAUTH_CLIENT_ID: ` ${vercel.clientId} ` })).toEqual([vercel]);
        expect(consumed({ HAPPIER_CONNECTED_SERVICES_VERCEL_OAUTH_CLIENT_ID: "  " })).toBeUndefined();
        expect(consumed({
            HAPPIER_CONNECTED_SERVICES_VERCEL_OAUTH_CLIENT_ID: vercel.clientId,
            HAPPIER_CONNECTED_SERVICES_CLOUDFLARE_OAUTH_CLIENT_ID: "happier-public-client",
            HAPPIER_CONNECTED_SERVICES_CLOUDFLARE_OAUTH_SCOPES: "account.read",
        })).toEqual([
            { service: { pluginId: "happier.deploy.cloudflare", localId: "cloudflare" }, clientId: "happier-public-client", scopesByMode: { oauth: ["account.read"] } },
            vercel,
        ]);
        // One operator's malformed Cloudflare scopes must not withdraw the Vercel client.
        expect(consumed({
            HAPPIER_CONNECTED_SERVICES_VERCEL_OAUTH_CLIENT_ID: vercel.clientId,
            HAPPIER_CONNECTED_SERVICES_CLOUDFLARE_OAUTH_CLIENT_ID: "happier-public-client",
            HAPPIER_CONNECTED_SERVICES_CLOUDFLARE_OAUTH_SCOPES: "not an OAuth scope token",
        })).toEqual([vercel]);
    });

    it("defaults to connected services enabled (including quotas)", () => {
        const malformed = resolveConnectedServicesFeature({
            HAPPIER_CONNECTED_SERVICES_CLOUDFLARE_OAUTH_CLIENT_ID: "happier-public-client",
            HAPPIER_CONNECTED_SERVICES_CLOUDFLARE_OAUTH_SCOPES: "not an OAuth scope token",
        });
        const consumed = FeaturesResponseSchema.parse({ features: malformed.features, capabilities: malformed.capabilities });
        expect(Reflect.get(consumed.capabilities.connectedServices, "publicOAuthClients")).toBeUndefined();
        expect(consumed.capabilities.connectedServices.qualifiedAccounts).toEqual({ protocolVersion: 4 });
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
