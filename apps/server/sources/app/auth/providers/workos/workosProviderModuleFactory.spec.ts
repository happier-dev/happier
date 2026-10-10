import type { WorkOS } from "@workos-inc/node";
import { describe, expect, it, vi } from "vitest";

import type { AuthPolicy } from "@/app/auth/authPolicy";

import {
    createWorkosProviderModule,
    resolveWorkosAuthProviderFeatures,
    type WorkosProviderModuleInput,
} from "./workosProviderModuleFactory";

describe("createWorkosProviderModule", () => {
    it("adapts WorkOS's atomic token/profile response to the common OAuth contract", async () => {
        const getAuthorizationUrl = vi.fn(() => "https://api.workos.test/sso/authorize");
        const getProfileAndToken = vi.fn(async () => ({
            accessToken: "access",
            profile: {
                id: "user_exact",
                idpId: "idp_exact",
                email: "USER@EXAMPLE.COM",
                organizationId: "org_exact",
                connectionId: "conn_exact",
            },
        }));
        const moduleInput = {
            providerInstanceId: "provider_exact",
            displayName: "Acme SSO",
            enabled: true,
            redirectUrl: "https://home.example.test/v1/oauth/provider_exact/callback",
            externalReference: {
                v: 1,
                kind: "workos_sso",
                organizationId: "org_exact",
                connectionId: "conn_exact",
            },
            platform: {
                available: true,
                clientId: "client_exact",
                client: { sso: { getAuthorizationUrl, getProfileAndToken } } as unknown as WorkOS,
                runtimeFingerprint: "workos-platform:v1:test",
            },
        } satisfies WorkosProviderModuleInput;
        const module = createWorkosProviderModule(moduleInput);

        await expect(module.oauth?.exchangeCodeForAccessToken({
            env: {},
            code: "code",
            pkceCodeVerifier: "verifier",
        })).resolves.toEqual({
            accessToken: "access",
            profile: {
                id: "user_exact",
                idpId: "idp_exact",
                email: "user@example.com",
                organizationId: "org_exact",
                connectionId: "conn_exact",
            },
        });
        expect(module.oauth?.getLogin({
            id: "user_exact",
            idpId: null,
            email: "user@example.com",
            organizationId: "org_exact",
            connectionId: "conn_exact",
        })).toBe("user@example.com");
        expect(module.identity?.id).toBe("provider_exact");
        expect(module.oauth?.accessTokenCustody).toBe("identity_proof_only");

        const policy: AuthPolicy = {
            anonymousSignupEnabled: false,
            signupProviders: [],
            requiredLoginProviders: [],
            offboarding: { enabled: true, strict: false, intervalSeconds: 900, mode: "per-request-cache" },
        };
        const expectedFeatures = {
            enabled: true,
            configured: true,
            ui: {
                displayName: "Acme SSO",
                iconHint: "workos",
                supportsProfileBadge: false,
            },
            restrictions: {
                usersAllowlist: false,
                orgsAllowlist: true,
                orgMatch: "any",
            },
            offboarding: {
                enabled: false,
                intervalSeconds: 900,
                mode: "per-request-cache",
                source: "workos_sso",
            },
        } as const;
        expect(module.auth?.resolveFeatures({ env: {}, policy })).toEqual(expectedFeatures);
        expect(resolveWorkosAuthProviderFeatures({
            displayName: "Acme SSO",
            enabled: true,
            configured: true,
            scope: "home",
        }, policy)).toEqual(expectedFeatures);
        const teamModule = createWorkosProviderModule({
            ...moduleInput,
            teamConnection: { teamId: "team_exact", connectionId: "binding_exact" },
        });
        expect(teamModule.auth?.resolveFeatures({ env: {}, policy }).offboarding.enabled).toBe(true);
    });
});
