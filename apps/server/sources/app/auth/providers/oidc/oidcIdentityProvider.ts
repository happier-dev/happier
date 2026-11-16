import { claimIdentityEligibilityCheck, prepareIdentityLink, readIdentityEligibilityStatus, unlinkIdentity, refreshIdentity } from "../accountIdentityLifecycle";
import { evaluateOidcIdentityEligibility } from "./oidcEligibility";
import type { IdentityProvider } from "@/app/auth/providers/identityProviders/types";
import type { Context } from "@/context";
import type { AuthPolicy } from "@/app/auth/authPolicy";
import type { LoginEligibilityResult } from "@/app/auth/loginEligibilityResult";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import type { OidcAuthProviderInstanceConfig } from "@/app/auth/providers/oidc/oidcProviderConfig";
import {
    createOidcIdentityProfile,
    normalizeOidcIdentityClaims,
    type NormalizedOidcIdentityClaims,
    type NormalizeOidcIdentityClaimsResult,
} from "@/app/auth/providers/oidc/normalizeOidcIdentityClaims";
import { decryptString, encryptString } from "@/modules/encrypt";
import * as oidcClient from "openid-client";
import { discoverOidcConfiguration } from "@/app/oauth/providers/oidc/oidcDiscovery";
import type { OutboundIdentityNetworkPolicy } from "@/app/net/outboundIdentityNetworkPolicy";
import {
    prepareIdentityConnectionGroupRefresh,
    selectMatchingExternalGroupIds,
} from "@/app/teams/memberships/identityConnectionGroupRefresh";
import { normalizeVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';

export type OidcTeamIdentityConnection = Readonly<{
    teamId: string;
    connectionId: string;
    allow: OidcAuthProviderInstanceConfig["allow"];
}>;

function extractOAuthErrorCode(err: unknown): string | null {
    if (!err || typeof err !== "object") return null;
    const record = err as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
    if (typeof record.code === "string" && record.code.trim()) return record.code.trim();
    const cause = record.cause;
    if (cause && typeof cause === "object") {
        const code = extractOAuthErrorCode(cause);
        if (code) return code;
    }
    const body = record.body;
    if (body && typeof body === "object") {
        const code = extractOAuthErrorCode(body);
        if (code) return code;
    }
    return null;
}

function isEligible(params: {
    instance: OidcAuthProviderInstanceConfig;
    claims: Readonly<NormalizedOidcIdentityClaims>;
    additionalAllow?: OidcAuthProviderInstanceConfig["allow"];
}): { ok: boolean } {
    return {
        ok: evaluateOidcIdentityEligibility({
            allow: params.instance.allow,
            ...(params.additionalAllow ? { additionalAllow: params.additionalAllow } : {}),
            claims: params.claims,
        }).status === "eligible",
    };
}

export function createOidcIdentityProvider(
    instance: OidcAuthProviderInstanceConfig,
    runtimeFingerprint: string,
    networkPolicy?: OutboundIdentityNetworkPolicy,
    teamConnection?: OidcTeamIdentityConnection,
): IdentityProvider {
    const providerId = instance.id.toString().trim().toLowerCase();

    const prepareConnect: IdentityProvider["prepareConnect"] = async (params) => {
        const userId = params.ctx.uid;
        const normalized = normalizeOidcIdentityClaims({
            idTokenClaims: params.profile,
            claims: instance.claims,
        });
        if (!normalized.ok) throw new Error(normalized.error);

        const eligibility = isEligible({
            instance,
            claims: normalized.value,
            additionalAllow: teamConnection?.allow,
        });
        if (!eligibility.ok) {
            throw new Error("not-eligible");
        }

        const refreshToken = params.refreshToken?.trim() ?? "";
        const tokenToPersist =
            instance.storeRefreshToken && refreshToken
                ? encryptString(["user", userId, providerId, "refresh_token"], refreshToken)
                : null;

        const preparedGroups = teamConnection && normalized.value.groups !== null && !normalized.value.groupsIncomplete
            ? await prepareIdentityConnectionGroupRefresh({
                accountId: userId,
                teamId: teamConnection.teamId,
                connectionId: teamConnection.connectionId,
                observeActiveExternalGroupIds: async (configuredExternalGroupIds) =>
                    selectMatchingExternalGroupIds(configuredExternalGroupIds, normalized.value.groups ?? []),
            })
            : null;
        const preparedIdentity = await prepareIdentityLink({
            accountId: userId,
            provider: providerId,
            providerUserId: normalized.value.subject,
            providerLogin: normalized.value.login,
            profile: createOidcIdentityProfile(normalized.value, instance.claims),
            token: tokenToPersist,
            eligibility: {
                eligibilityStatus: "eligible",
                eligibilityReason: null,
                eligibilityCheckedAt: new Date(),
                eligibilityNextCheckAt: null,
            },
            presentation: { username: params.preferredUsername, name: normalized.value.name },
            usernamePolicyEnv: params.usernamePolicyEnv,
            transferFromAccountId: params.transferFromAccountId,
        });
        const verifiedMailbox = normalized.value.emailVerified && normalized.value.email
            ? normalizeVerifiedEmail(normalized.value.email)
            : null;
        return {
            ...(verifiedMailbox ? { verifiedMailbox } : {}),
            connectInTx: async (tx) => {
                await preparedGroups?.acquireAdmissionInTx(tx, {
                    additionalAccountIds: params.transferFromAccountId ? [params.transferFromAccountId] : [],
                    intent: "exclusive",
                });
                await preparedIdentity.connectInTx(tx);
                await preparedGroups?.applyInTx(tx);
            },
        };
    };

    return Object.freeze({
        id: providerId,
        prepareConnect,
        connect: async (params) => {
            const prepared = await prepareConnect(params);
            await inTx(prepared.connectInTx, { isolationLevel: "Serializable" /* Provider currentness, identity transfer and Account presentation share one link-admission snapshot. */ });
        },
        disconnect: async (params: { ctx: Context }) => {
            const userId = params.ctx.uid;
            await unlinkIdentity({ accountId: userId, provider: providerId });
        },
        enforceLoginEligibility: async (params: {
            accountId: string;
            env: NodeJS.ProcessEnv;
            policy: AuthPolicy;
            now?: Date;
        }): Promise<LoginEligibilityResult> => {
            const accountId = params.accountId.toString().trim();
            if (!accountId) return { ok: false, statusCode: 401, error: "invalid-token" };

            const identity = await db.accountIdentity.findFirst({
                where: { accountId, provider: providerId },
                select: {
                    id: true,
                    providerUserId: true,
                    providerLogin: true,
                    profile: true,
                    token: true,
                    eligibilityStatus: true,
                    eligibilityCheckedAt: true,
                    eligibilityNextCheckAt: true,
                },
            });
            if (!identity) return { ok: false, statusCode: 403, error: "provider-required", provider: providerId };
            if (identity.eligibilityStatus === "ineligible") {
                return { ok: false, statusCode: 403, error: "not-eligible" };
            }

            const now = params.now ?? new Date();

            const currentClaims = normalizeOidcIdentityClaims({
                idTokenClaims: identity.profile,
                claims: instance.claims,
            });
            if (!currentClaims.ok) return { ok: false, statusCode: 403, error: "not-eligible" };
            const currentEligibility = isEligible({
                instance,
                claims: currentClaims.value,
                additionalAllow: teamConnection?.allow,
            });
            if (!currentEligibility.ok) return { ok: false, statusCode: 403, error: "not-eligible" };

            const restrictionsConfigured =
                instance.allow.usersAllowlist.length > 0 ||
                instance.allow.emailDomains.length > 0 ||
                instance.allow.groupsAny.length > 0 ||
                instance.allow.groupsAll.length > 0 ||
                Boolean(teamConnection && (
                    teamConnection.allow.usersAllowlist.length > 0
                    || teamConnection.allow.emailDomains.length > 0
                    || teamConnection.allow.groupsAny.length > 0
                    || teamConnection.allow.groupsAll.length > 0
                ));

            const shouldRefresh =
                Boolean(params.policy.offboarding.enabled) &&
                Boolean(instance.storeRefreshToken) &&
                Boolean(identity.token) &&
                (!identity.eligibilityNextCheckAt || identity.eligibilityNextCheckAt.getTime() <= now.getTime());

            if (!shouldRefresh) return { ok: true };
            // Every API node re-decides its connected Accounts on a sign-in policy change, and HTTP
            // checks race across nodes: only the claim winner presents the (possibly rotating) token.
            if (!await claimIdentityEligibilityCheck({
                accountId, provider: providerId, identityId: identity.id,
                readNextCheckAt: identity.eligibilityNextCheckAt,
                readToken: new Uint8Array(identity.token!),
                nextCheckAt: new Date(now.getTime() + params.policy.offboarding.intervalSeconds * 1000),
            })) {
                // Another checker owns this check; the winner may already have offboarded the Account
                // (and then withdraws its live sockets cluster-wide, accountIdentityLifecycle).
                return await readIdentityEligibilityStatus(identity.id) === "ineligible"
                    ? { ok: false, statusCode: 403, error: "not-eligible" }
                    : { ok: true };
            }

            let refreshedClaims: NormalizeOidcIdentityClaimsResult | null = null;
            let refreshedTokenBytes = new Uint8Array(identity.token!);
            /**
             * A grant may issue a replacement refresh token and revoke the presented one
             * (RFC 6749 §6). Once the issuer has done that the stored token is dead, so every
             * exit below persists the rotation — otherwise the next refresh fails
             * `invalid_grant` and offboards a legitimate Account.
             */
            let rotatedTokenBytes: ReturnType<typeof encryptString> | null = null;

            try {
                const refreshToken = decryptString(
                    ["user", accountId, providerId, "refresh_token"],
                    new Uint8Array(identity.token!),
                );
                const cfg = await discoverOidcConfiguration(instance, runtimeFingerprint, networkPolicy);

                const tokens = await oidcClient.refreshTokenGrant(cfg, refreshToken);
                // Capture the replacement before any further fallible claim/UserInfo work: the
                // issuer may already have revoked the presented token (RFC 6749 §6).
                const newRefreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : "";
                if (newRefreshToken) {
                    rotatedTokenBytes = encryptString(["user", accountId, providerId, "refresh_token"], newRefreshToken);
                    refreshedTokenBytes = rotatedTokenBytes;
                }
                const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : "";
                const idTokenClaims = tokens.claims?.();
                if (idTokenClaims !== undefined) {
                    const idTokenResult = normalizeOidcIdentityClaims({
                        idTokenClaims,
                        claims: instance.claims,
                    });
                    refreshedClaims = idTokenResult;
                    if (idTokenResult.ok && instance.fetchUserInfo) {
                        const userInfo = await oidcClient.fetchUserInfo(cfg, accessToken, oidcClient.skipSubjectCheck);
                        refreshedClaims = normalizeOidcIdentityClaims({
                            idTokenClaims,
                            userInfo,
                            claims: instance.claims,
                        });
                    }
                } else if (instance.fetchUserInfo && accessToken) {
                    const userInfo = await oidcClient.fetchUserInfo(cfg, accessToken, oidcClient.skipSubjectCheck);
                    refreshedClaims = normalizeOidcIdentityClaims({
                        idTokenClaims: { sub: identity.providerUserId },
                        userInfo,
                        claims: instance.claims,
                    });
                }

                if (!refreshedClaims && restrictionsConfigured && params.policy.offboarding.strict) {
                    throw new Error("oidc_refresh_claims_missing");
                }
            } catch (err) {
                const code = extractOAuthErrorCode(err);
                const isInvalidGrant = code === "invalid_grant" || code === "invalid_token";

                if (restrictionsConfigured && isInvalidGrant) {
                    await refreshIdentity({
                        accountId, provider: providerId, identityId: identity.id,
                        data: {
                            ...(rotatedTokenBytes ? { token: rotatedTokenBytes } : {}),
                            eligibilityStatus: "ineligible",
                            eligibilityReason: "eligibility-refresh-invalid-grant",
                            eligibilityCheckedAt: now,
                            eligibilityNextCheckAt: new Date(now.getTime() + params.policy.offboarding.intervalSeconds * 1000),
                        },
                    });
                    return { ok: false, statusCode: 403, error: "not-eligible" };
                }

                if (restrictionsConfigured && params.policy.offboarding.strict) {
                    await refreshIdentity({
                        accountId, provider: providerId, identityId: identity.id,
                        data: {
                            ...(rotatedTokenBytes ? { token: rotatedTokenBytes } : {}),
                            eligibilityStatus: "unknown",
                            eligibilityReason: "eligibility-refresh-error",
                            eligibilityCheckedAt: now,
                            eligibilityNextCheckAt: new Date(now.getTime() + params.policy.offboarding.intervalSeconds * 1000),
                        },
                    });
                    return { ok: false, statusCode: 403, error: "not-eligible" };
                }

                // Best-effort refresh failures: preserve current profile and eligibility.
                await refreshIdentity({
                    accountId, provider: providerId, identityId: identity.id,
                    data: {
                        ...(rotatedTokenBytes ? { token: rotatedTokenBytes } : {}),
                        eligibilityCheckedAt: now,
                        eligibilityNextCheckAt: new Date(now.getTime() + params.policy.offboarding.intervalSeconds * 1000),
                    },
                });
                return { ok: true };
            }

            if (!refreshedClaims) {
                await refreshIdentity({
                    accountId, provider: providerId, identityId: identity.id,
                    data: {
                        ...(rotatedTokenBytes ? { token: rotatedTokenBytes } : {}),
                        eligibilityCheckedAt: now,
                        eligibilityNextCheckAt: new Date(now.getTime() + params.policy.offboarding.intervalSeconds * 1000),
                    },
                });
                return { ok: true };
            }

            if (!refreshedClaims.ok) {
                const subjectFailure =
                    refreshedClaims.reason === "id_token_claims_invalid" ||
                    refreshedClaims.reason === "subject_invalid" ||
                    refreshedClaims.reason === "userinfo_invalid" ||
                    refreshedClaims.reason === "userinfo_subject_mismatch";
                await refreshIdentity({
                    accountId, provider: providerId, identityId: identity.id,
                    data: {
                        ...(rotatedTokenBytes ? { token: rotatedTokenBytes } : {}),
                        eligibilityStatus: "ineligible",
                        eligibilityReason: subjectFailure ? "eligibility-refresh-sub-mismatch" : "not-eligible",
                        eligibilityCheckedAt: now,
                        eligibilityNextCheckAt: new Date(now.getTime() + params.policy.offboarding.intervalSeconds * 1000),
                    },
                });
                return { ok: false, statusCode: 403, error: "not-eligible" };
            }

            if (refreshedClaims.value.subject !== identity.providerUserId) {
                await refreshIdentity({
                    accountId, provider: providerId, identityId: identity.id,
                    data: {
                        ...(rotatedTokenBytes ? { token: rotatedTokenBytes } : {}),
                        eligibilityStatus: "ineligible",
                        eligibilityReason: "eligibility-refresh-sub-mismatch",
                        eligibilityCheckedAt: now,
                        eligibilityNextCheckAt: new Date(now.getTime() + params.policy.offboarding.intervalSeconds * 1000),
                    },
                });
                return { ok: false, statusCode: 403, error: "not-eligible" };
            }

            const refreshedEligibility = isEligible({
                instance,
                claims: refreshedClaims.value,
                additionalAllow: teamConnection?.allow,
            });
            await refreshIdentity({
                accountId, provider: providerId, identityId: identity.id,
                data: {
                    providerLogin: refreshedClaims.value.login ?? identity.providerLogin,
                    profile: createOidcIdentityProfile(refreshedClaims.value, instance.claims),
                    token: refreshedTokenBytes,
                    eligibilityStatus: refreshedEligibility.ok ? "eligible" : "ineligible",
                    eligibilityReason: refreshedEligibility.ok ? null : "not-eligible",
                    eligibilityCheckedAt: now,
                    eligibilityNextCheckAt: new Date(now.getTime() + params.policy.offboarding.intervalSeconds * 1000),
                },
            });

            if (!refreshedEligibility.ok) {
                return { ok: false, statusCode: 403, error: "not-eligible" };
            }

            return { ok: true };
        },
    });
}
