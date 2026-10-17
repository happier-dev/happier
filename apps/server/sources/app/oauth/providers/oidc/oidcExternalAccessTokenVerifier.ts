import * as oidcClient from "openid-client";
import * as privacyKit from "privacy-kit";

import type { ExternalAccessTokenVerification } from "@/app/oauth/providers/types";
import type { OidcAuthProviderInstanceConfig, OidcTokenExchangeConfig } from "@/app/auth/providers/oidc/oidcProviderConfig";
import { describeLoggableError } from "@/utils/logging/describeLoggableError";
import { log } from "@/utils/logging/log";
import { discoverOidcConfiguration } from "./oidcDiscovery";

// openid-client's code for a UserInfo `sub` that differs from the expected subject.
const USERINFO_SUBJECT_MISMATCH = "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED";
// openid-client's code for a non-200 UserInfo response without a WWW-Authenticate challenge.
const USERINFO_UNEXPECTED_STATUS = "OAUTH_RESPONSE_IS_NOT_CONFORM";

function readUnverifiedJwtClaims(token: string): Record<string, unknown> | null {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    try {
        const payload: unknown = JSON.parse(new TextDecoder().decode(privacyKit.decodeBase64(parts[1], "base64url")));
        return typeof payload === "object" && payload !== null && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

function readStringClaim(claims: Record<string, unknown>, name: string): string | null {
    const value = claims[name];
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readClientId(claims: Record<string, unknown>, config: OidcTokenExchangeConfig): string | null {
    if (config.clientIdClaim) return readStringClaim(claims, config.clientIdClaim);
    return readStringClaim(claims, "client_id") ?? readStringClaim(claims, "azp");
}

function isRejectionStatus(status: unknown): boolean {
    return status === 401 || status === 403;
}

function isTokenRejectedByProvider(error: unknown): boolean {
    if (error instanceof oidcClient.WWWAuthenticateChallengeError) return isRejectionStatus(error.status);
    if (error instanceof oidcClient.ResponseBodyError) return isRejectionStatus(error.status);
    if (error instanceof oidcClient.ClientError) {
        if (error.code === USERINFO_SUBJECT_MISMATCH) return true;
        if (error.code === USERINFO_UNEXPECTED_STATUS && error.cause instanceof Response) {
            return isRejectionStatus(error.cause.status);
        }
    }
    return false;
}

/**
 * Verifies an access token that a machine obtained from this OIDC provider on its own.
 *
 * The client claim is read from the unverified JWT payload and checked against the
 * allowlist first. The provider's UserInfo endpoint then validates the whole token: it
 * refuses a token whose payload was edited (the signature no longer matches), expired, or
 * revoked. openid-client also requires the UserInfo `sub` to equal the token's configured
 * subject claim, which binds the allowlisted client to the user UserInfo reports.
 * Opaque (non-JWT) access tokens carry no readable client claim and are refused.
 */
export function createOidcExternalAccessTokenVerifier(
    instance: OidcAuthProviderInstanceConfig,
    config: OidcTokenExchangeConfig,
): (params: { accessToken: string }) => Promise<ExternalAccessTokenVerification> {
    return async ({ accessToken }) => {
        const claims = readUnverifiedJwtClaims(accessToken);
        if (!claims) return { ok: false, error: "invalid-token" };

        const clientId = readClientId(claims, config);
        if (!clientId || !config.allowedClientIds.includes(clientId)) {
            return { ok: false, error: "client-not-allowed" };
        }

        const subject = readStringClaim(claims, config.subjectClaim);
        if (!subject) return { ok: false, error: "invalid-token" };

        try {
            const cfg = await discoverOidcConfiguration(instance);
            const profile = await oidcClient.fetchUserInfo(cfg, accessToken, subject);
            return { ok: true, profile };
        } catch (error) {
            if (isTokenRejectedByProvider(error)) {
                log(
                    { module: "auth-token-exchange", level: "warn" },
                    "Identity provider refused an exchanged access token",
                    { providerId: instance.id, clientId, error: describeLoggableError(error) },
                );
                return { ok: false, error: "invalid-token" };
            }
            log(
                { module: "auth-token-exchange", level: "error" },
                "Could not verify an exchanged access token at the identity provider",
                { providerId: instance.id, clientId, error: describeLoggableError(error) },
            );
            return { ok: false, error: "upstream_error" };
        }
    };
}
