import * as oidcClient from "openid-client";

import type { OAuthFlowProvider, OAuthTokenExchangeResult } from "@/app/oauth/providers/types";
import type { OidcAuthProviderInstanceConfig } from "@/app/auth/providers/oidc/oidcProviderConfig";
import { discoverOidcConfiguration } from "./oidcDiscovery";

export function createOidcOAuthProvider(instance: OidcAuthProviderInstanceConfig): OAuthFlowProvider {
    const isConfigured = () => Boolean(instance.clientId && instance.clientSecret && instance.redirectUrl && instance.issuer);
    const configured = isConfigured();

    const provider: OAuthFlowProvider = Object.freeze({
        id: instance.id,
        resolveStatus: () => ({ enabled: true, configured }),
        isConfigured: () => configured,
        resolveRedirectUrl: () => instance.redirectUrl,
        resolveScope: () => instance.scopes,
        resolveAuthorizeUrl: async ({ state, scope, codeChallenge, codeChallengeMethod, nonce }) => {
            if (!instance.clientId || !instance.clientSecret || !instance.redirectUrl || !instance.issuer) {
                throw new Error("oauth_not_configured");
            }
            const cfg = await discoverOidcConfiguration(instance);
            const url = oidcClient.buildAuthorizationUrl(cfg, {
                redirect_uri: instance.redirectUrl,
                scope,
                state,
                ...(codeChallenge && codeChallengeMethod
                    ? { code_challenge: codeChallenge, code_challenge_method: codeChallengeMethod }
                    : {}),
                ...(nonce ? { nonce } : {}),
            });
            return url.toString();
        },
        exchangeCodeForAccessToken: async ({ code, state, iss, pkceCodeVerifier, expectedNonce }): Promise<OAuthTokenExchangeResult> => {
            if (!instance.clientId || !instance.clientSecret || !instance.redirectUrl || !instance.issuer) {
                throw new Error("oauth_not_configured");
            }
            const cfg = await discoverOidcConfiguration(instance);
            const callbackUrl = new URL(instance.redirectUrl);
            callbackUrl.searchParams.set("code", code);
            if (typeof state === "string" && state) {
                callbackUrl.searchParams.set("state", state);
            }
            if (typeof iss === "string" && iss) {
                callbackUrl.searchParams.set("iss", iss);
            }

            const tokens = await oidcClient.authorizationCodeGrant(cfg, callbackUrl, {
                ...(typeof expectedNonce === "string" && expectedNonce ? { expectedNonce } : {}),
                ...(typeof state === "string" && state ? { expectedState: state } : {}),
                ...(typeof pkceCodeVerifier === "string" && pkceCodeVerifier ? { pkceCodeVerifier } : {}),
                idTokenExpected: true,
            });

            const accessToken = (tokens as any).access_token?.toString?.() ?? "";
            if (!accessToken) {
                throw new Error("missing_access_token");
            }
            const idToken = (tokens as any).id_token?.toString?.() ?? undefined;
            const idTokenClaims = tokens.claims?.() ?? undefined;
            const refreshToken = (tokens as any).refresh_token?.toString?.() ?? undefined;

            return { accessToken, idToken, idTokenClaims, refreshToken };
        },
        fetchProfile: async ({ env: _env, accessToken, idTokenClaims }) => {
            if (!idTokenClaims || typeof idTokenClaims !== "object") {
                throw new Error("invalid_profile");
            }

            if (!instance.fetchUserInfo) return idTokenClaims;

            const cfg = await discoverOidcConfiguration(instance);
            try {
                const expectedSubject = (idTokenClaims as any)?.sub?.toString?.().trim?.() ?? "";
                if (!expectedSubject) {
                    throw new Error("invalid_profile");
                }
                const userinfo = await oidcClient.fetchUserInfo(cfg, accessToken, expectedSubject);
                if (!userinfo || typeof userinfo !== "object") {
                    throw new Error("invalid_userinfo");
                }
                return { ...(idTokenClaims as any), ...(userinfo as any) };
            } catch (err) {
                throw new Error("profile_fetch_failed", { cause: err });
            }
        },
        getLogin: (profile) => {
            const record = profile as any;
            const mapped = record?.[instance.claims.login]?.toString?.().trim?.() ?? "";
            if (mapped) return mapped;

            const preferred = record?.preferred_username?.toString?.().trim?.() ?? "";
            if (preferred) return preferred;
            const email = record?.email?.toString?.().trim?.() ?? "";
            if (email) return email;
            const upn = record?.upn?.toString?.().trim?.() ?? "";
            return upn ? upn : null;
        },
        getProviderUserId: (profile) => {
            const sub = (profile as any)?.sub?.toString?.().trim?.() ?? "";
            return sub ? sub : null;
        },
    });

    return provider;
}
