import type { IdentityProvider } from "@/app/auth/providers/identityProviders/types";
import type { Context } from "@/context";
import type { AuthPolicy } from "@/app/auth/authPolicy";
import type { LoginEligibilityResult } from "@/app/auth/loginEligibilityResult";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import type { OidcAuthProviderInstanceConfig } from "@/app/auth/providers/oidc/oidcProviderConfig";
import { decryptString, encryptString } from "@/modules/encrypt";
import * as oidcClient from "openid-client";
import { discoverOidcConfiguration } from "@/app/oauth/providers/oidc/oidcDiscovery";

function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function extractOAuthErrorCode(err: unknown): string | null {
    if (!err || typeof err !== "object") return null;
    const record = err as any;
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

function extractSub(profile: unknown): string | null {
    return asNonEmptyString((profile as any)?.sub);
}

function extractStringClaim(profile: unknown, claim: string): string | null {
    if (!claim) return null;
    return asNonEmptyString((profile as any)?.[claim]);
}

function extractLogin(profile: unknown, claims: OidcAuthProviderInstanceConfig["claims"]): string | null {
    const mapped = extractStringClaim(profile, claims.login);
    if (mapped) return mapped.toLowerCase();

    const preferred = asNonEmptyString((profile as any)?.preferred_username);
    if (preferred) return preferred.toLowerCase();
    const email = asNonEmptyString((profile as any)?.email);
    if (email) return email.toLowerCase();
    const upn = asNonEmptyString((profile as any)?.upn);
    if (upn) return upn.toLowerCase();
    return null;
}

function extractEmail(profile: unknown, claims: OidcAuthProviderInstanceConfig["claims"]): string | null {
    const mapped = extractStringClaim(profile, claims.email);
    if (mapped) return mapped.toLowerCase();
    const email = asNonEmptyString((profile as any)?.email);
    return email ? email.toLowerCase() : null;
}

function extractEmailDomain(email: string | null): string | null {
    if (!email) return null;
    const at = email.lastIndexOf("@");
    if (at < 0) return null;
    const domain = email.slice(at + 1).trim().toLowerCase();
    return domain ? domain : null;
}

function extractGroups(profile: unknown, claims: OidcAuthProviderInstanceConfig["claims"]): { groups: string[] | null; overage: boolean } {
    const claimName = claims.groups?.toString?.().trim?.() ?? "groups";

    const claimNames = (profile as any)?._claim_names;
    const overage = Boolean(claimNames && typeof claimNames === "object" && (claimNames as any)?.[claimName]);
    if (overage) return { groups: null, overage: true };

    const raw = (profile as any)?.[claimName];
    if (Array.isArray(raw)) {
        const groups = raw
            .map((v) => (typeof v === "string" ? v.trim() : ""))
            .filter(Boolean)
            .map((v) => v.toLowerCase());
        return { groups, overage: false };
    }
    const single = asNonEmptyString(raw);
    if (single) return { groups: [single.toLowerCase()], overage: false };
    return { groups: null, overage: false };
}

function isEligible(params: {
    instance: OidcAuthProviderInstanceConfig;
    profile: unknown;
}): { ok: true } | { ok: false } {
    const allow = params.instance.allow;
    const claims = params.instance.claims;
    const login = extractLogin(params.profile, claims);

    if (allow.usersAllowlist.length > 0) {
        if (!login || !allow.usersAllowlist.includes(login)) return { ok: false };
    }

    if (allow.emailDomains.length > 0) {
        const email = extractEmail(params.profile, claims);
        const domain = extractEmailDomain(email);
        if (!domain || !allow.emailDomains.includes(domain)) return { ok: false };
    }

    const groupsRequired = allow.groupsAny.length > 0 || allow.groupsAll.length > 0;
    if (groupsRequired) {
        const extracted = extractGroups(params.profile, claims);
        // If groups are required but missing (or overage is in effect), fail closed.
        if (!extracted.groups || extracted.groups.length === 0) return { ok: false };

        if (allow.groupsAny.length > 0) {
            const ok = allow.groupsAny.some((g) => extracted.groups!.includes(g));
            if (!ok) return { ok: false };
        }
        if (allow.groupsAll.length > 0) {
            const ok = allow.groupsAll.every((g) => extracted.groups!.includes(g));
            if (!ok) return { ok: false };
        }
    }

    return { ok: true };
}

export function createOidcIdentityProvider(instance: OidcAuthProviderInstanceConfig): IdentityProvider {
    const providerId = instance.id.toString().trim().toLowerCase();

    return Object.freeze({
        id: providerId,
        connect: async (params: { ctx: Context; profile: unknown; accessToken: string; refreshToken?: string; preferredUsername?: string | null }) => {
            const userId = params.ctx.uid;
            const providerUserId = extractSub(params.profile);
            if (!providerUserId) {
                throw new Error("invalid_profile");
            }

            const eligibility = isEligible({ instance, profile: params.profile });
            if (!eligibility.ok) {
                throw new Error("not-eligible");
            }

            const providerLogin = extractLogin(params.profile, instance.claims);
            const preferredUsername = params.preferredUsername?.toString().trim().toLowerCase() || null;
            const refreshToken = params.refreshToken?.toString?.().trim?.() ?? "";
            const tokenToPersist =
                instance.storeRefreshToken && refreshToken
                    ? (encryptString(["user", userId, providerId, "refresh_token"], refreshToken) as any)
                    : null;

            const alreadyLinked = await db.accountIdentity.findFirst({
                where: {
                    provider: providerId,
                    providerUserId,
                    NOT: { accountId: userId },
                },
                select: { id: true },
            });
            if (alreadyLinked) {
                throw new Error("provider-already-linked");
            }

            await inTx(async (tx) => {
                const account = await tx.account.findUnique({
                    where: { id: userId },
                    select: { username: true },
                });
                if (!account) throw new Error("account-not-found");

                const existingUsername = account.username?.toString().trim() || null;
                let usernameToSet: string | null = null;
                if (!existingUsername && preferredUsername) {
                    const taken = await tx.account.findFirst({
                        where: { username: preferredUsername, NOT: { id: userId } },
                        select: { id: true },
                    });
                    if (!taken) usernameToSet = preferredUsername;
                }

                await tx.accountIdentity.upsert({
                    where: { accountId_provider: { accountId: userId, provider: providerId } },
                    update: {
                        providerUserId,
                        providerLogin,
                        profile: params.profile as any,
                        token: tokenToPersist,
                    },
                    create: {
                        accountId: userId,
                        provider: providerId,
                        providerUserId,
                        providerLogin,
                        profile: params.profile as any,
                        token: tokenToPersist,
                    },
                });

                if (usernameToSet) {
                    await tx.account.update({
                        where: { id: userId },
                        data: { username: usernameToSet },
                    });
                }
            });
        },
        disconnect: async (params: { ctx: Context }) => {
            const userId = params.ctx.uid;
            await db.accountIdentity.deleteMany({
                where: { accountId: userId, provider: providerId },
            });
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

            const now = params.now ?? new Date();

            const evaluateCurrent = () => isEligible({ instance, profile: identity.profile });
            const currentEligibility = evaluateCurrent();
            if (!currentEligibility.ok) return { ok: false, statusCode: 403, error: "not-eligible" };

            const restrictionsConfigured =
                instance.allow.usersAllowlist.length > 0 ||
                instance.allow.emailDomains.length > 0 ||
                instance.allow.groupsAny.length > 0 ||
                instance.allow.groupsAll.length > 0;

            const shouldRefresh =
                Boolean(params.policy.offboarding.enabled) &&
                Boolean(instance.storeRefreshToken) &&
                Boolean(identity.token) &&
                (!identity.eligibilityNextCheckAt || identity.eligibilityNextCheckAt.getTime() <= now.getTime());

            if (!shouldRefresh) return { ok: true };

            let refreshedProfile: unknown | null = null;
            let refreshedLogin: string | null = null;
            let refreshedTokenBytes: any = null;

            try {
                const refreshToken = decryptString(["user", accountId, providerId, "refresh_token"], identity.token as any);
                const cfg = await discoverOidcConfiguration(instance);

                const tokens = await oidcClient.refreshTokenGrant(cfg, refreshToken);
                const accessToken = (tokens as any).access_token?.toString?.() ?? "";
                const idTokenClaims = (tokens as any).claims?.() ?? undefined;
                if (idTokenClaims && typeof idTokenClaims === "object") {
                    refreshedProfile = idTokenClaims;
                    if (instance.fetchUserInfo) {
                        const expectedSubject = (idTokenClaims as any)?.sub?.toString?.().trim?.() ?? "";
                        if (!expectedSubject) {
                            throw new Error("invalid_profile");
                        }
                        const userinfo = await oidcClient.fetchUserInfo(cfg, accessToken, expectedSubject);
                        refreshedProfile = { ...(idTokenClaims as any), ...(userinfo as any) };
                    }
                }

                const newRefreshToken = (tokens as any).refresh_token?.toString?.() ?? "";
                if (newRefreshToken) {
                    refreshedTokenBytes = encryptString(["user", accountId, providerId, "refresh_token"], newRefreshToken) as any;
                } else {
                    refreshedTokenBytes = identity.token as any;
                }

                if (refreshedProfile) {
                    refreshedLogin = extractLogin(refreshedProfile, instance.claims);
                }
            } catch (err) {
                const code = extractOAuthErrorCode(err);
                const isInvalidGrant = code === "invalid_grant" || code === "invalid_token";

                if (restrictionsConfigured && isInvalidGrant) {
                    await db.accountIdentity.update({
                        where: { id: identity.id },
                        data: {
                            eligibilityStatus: "ineligible",
                            eligibilityReason: "eligibility-refresh-invalid-grant",
                            eligibilityCheckedAt: now,
                            eligibilityNextCheckAt: new Date(now.getTime() + params.policy.offboarding.intervalSeconds * 1000),
                        },
                    });
                    return { ok: false, statusCode: 403, error: "not-eligible" };
                }

                if (restrictionsConfigured && params.policy.offboarding.strict) {
                    await db.accountIdentity.update({
                        where: { id: identity.id },
                        data: {
                            eligibilityStatus: "unknown",
                            eligibilityReason: "eligibility-refresh-error",
                            eligibilityCheckedAt: now,
                            eligibilityNextCheckAt: new Date(now.getTime() + params.policy.offboarding.intervalSeconds * 1000),
                        },
                    });
                    return { ok: false, statusCode: 403, error: "not-eligible" };
                }

                // Best-effort refresh failures: preserve current profile and eligibility.
                await db.accountIdentity.update({
                    where: { id: identity.id },
                    data: {
                        eligibilityCheckedAt: now,
                        eligibilityNextCheckAt: new Date(now.getTime() + params.policy.offboarding.intervalSeconds * 1000),
                    },
                });
                return { ok: true };
            }

            if (!refreshedProfile) {
                await db.accountIdentity.update({
                    where: { id: identity.id },
                    data: {
                        eligibilityCheckedAt: now,
                        eligibilityNextCheckAt: new Date(now.getTime() + params.policy.offboarding.intervalSeconds * 1000),
                    },
                });
                return { ok: true };
            }

            const refreshedProviderUserId = extractSub(refreshedProfile);
            const linkedProviderUserId = identity.providerUserId?.toString?.().trim?.() ?? "";
            if (!refreshedProviderUserId || refreshedProviderUserId !== linkedProviderUserId) {
                await db.accountIdentity.update({
                    where: { id: identity.id },
                    data: {
                        eligibilityStatus: "ineligible",
                        eligibilityReason: "eligibility-refresh-sub-mismatch",
                        eligibilityCheckedAt: now,
                        eligibilityNextCheckAt: new Date(now.getTime() + params.policy.offboarding.intervalSeconds * 1000),
                    },
                });
                return { ok: false, statusCode: 403, error: "not-eligible" };
            }

            const refreshedEligibility = isEligible({ instance, profile: refreshedProfile });
            await db.accountIdentity.update({
                where: { id: identity.id },
                data: {
                    providerLogin: refreshedLogin ?? identity.providerLogin,
                    profile: refreshedProfile as any,
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
