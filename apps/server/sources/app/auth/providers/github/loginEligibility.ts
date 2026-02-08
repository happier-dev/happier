import { decryptString } from "@/modules/encrypt";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import type { AuthPolicy } from "@/app/auth/authPolicy";
import type { LoginEligibilityResult } from "@/app/auth/loginEligibilityResult";
import { isGithubOrgMemberViaApp, isGithubOrgMemberViaUserToken } from "./orgMembership";
import { resolveGitHubAuthRestrictionsFromEnv } from "./restrictions";
import { resolveGitHubHttpTimeoutMs } from "./httpTimeout";

export async function enforceGitHubLoginEligibility(params: {
    accountId: string;
    env: NodeJS.ProcessEnv;
    policy: AuthPolicy;
    now?: Date;
}): Promise<LoginEligibilityResult> {
    const accountId = params.accountId.toString().trim();
    if (!accountId) return { ok: false, statusCode: 401, error: "invalid-token" };

    const policy = params.policy;
    const restrictions = resolveGitHubAuthRestrictionsFromEnv(params.env);

    const identity = await db.accountIdentity.findFirst({
        where: { accountId, provider: "github" },
        select: {
            id: true,
            providerLogin: true,
            token: true,
            eligibilityStatus: true,
            eligibilityCheckedAt: true,
            eligibilityNextCheckAt: true,
        },
    });
    if (!identity) return { ok: false, statusCode: 403, error: "provider-required", provider: "github" };

    const login = identity.providerLogin?.toString().trim().toLowerCase() || null;

    if (restrictions.allowedUsers.length > 0) {
        if (!login || !restrictions.allowedUsers.includes(login)) {
            return { ok: false, statusCode: 403, error: "not-eligible" };
        }
    }

    if (restrictions.allowedOrgs.length === 0) {
        return { ok: true };
    }

    if (!login) {
        return { ok: false, statusCode: 403, error: "not-eligible" };
    }

    const now = params.now ?? new Date();
    const shouldCheck = policy.offboarding.enabled
        ? !identity.eligibilityNextCheckAt || identity.eligibilityNextCheckAt.getTime() <= now.getTime()
        : !identity.eligibilityCheckedAt;

    if (!shouldCheck) {
        if (identity.eligibilityStatus === "ineligible") {
            return { ok: false, statusCode: 403, error: "not-eligible" };
        }
        return { ok: true };
    }

    let memberFlags: boolean[] = [];
    try {
        const timeoutMs = resolveGitHubHttpTimeoutMs(params.env);
        if (restrictions.orgMembershipSource === "oauth_user_token") {
            const tokenBytes = identity.token as any;
            if (!tokenBytes) {
                memberFlags = restrictions.allowedOrgs.map(() => false);
            } else {
                const accessToken = decryptString(["user", accountId, "github", "token"], tokenBytes);
                memberFlags = await Promise.all(
                    restrictions.allowedOrgs.map((org) =>
                        isGithubOrgMemberViaUserToken({ org, username: login, accessToken, timeoutMs }),
                    ),
                );
            }
        } else {
            memberFlags = await Promise.all(
                restrictions.allowedOrgs.map((org) =>
                    isGithubOrgMemberViaApp({ org, username: login, env: params.env }),
                ),
            );
        }
    } catch (error) {
        log({ module: "auth-policy", level: "warn" }, "GitHub org membership check failed", error);

        const nextCheckAt = policy.offboarding.enabled
            ? new Date(now.getTime() + policy.offboarding.intervalSeconds * 1000)
            : null;

        if (policy.offboarding.strict) {
            await db.accountIdentity.update({
                where: { id: identity.id },
                data: {
                    eligibilityStatus: "unknown",
                    eligibilityReason: "eligibility-check-upstream-error",
                    eligibilityCheckedAt: now,
                    eligibilityNextCheckAt: nextCheckAt,
                },
            });
            return { ok: false, statusCode: 403, error: "not-eligible" };
        }

        if (identity.eligibilityStatus === "eligible") {
            await db.accountIdentity.update({
                where: { id: identity.id },
                data: {
                    eligibilityStatus: "eligible",
                    eligibilityReason: "eligibility-check-upstream-error",
                    eligibilityCheckedAt: now,
                    eligibilityNextCheckAt: nextCheckAt,
                },
            });
            return { ok: true };
        }

        await db.accountIdentity.update({
            where: { id: identity.id },
            data: {
                eligibilityCheckedAt: now,
                eligibilityNextCheckAt: nextCheckAt,
            },
        });

        if (identity.eligibilityStatus === "ineligible") {
            return { ok: false, statusCode: 403, error: "not-eligible" };
        }

        return { ok: false, statusCode: 503, error: "upstream_error" };
    }

    const orgEligible = restrictions.orgMatch === "all" ? memberFlags.every(Boolean) : memberFlags.some(Boolean);

    await db.accountIdentity.update({
        where: { id: identity.id },
        data: {
            eligibilityStatus: orgEligible ? "eligible" : "ineligible",
            eligibilityReason: orgEligible ? null : "org-not-allowed",
            eligibilityCheckedAt: now,
            eligibilityNextCheckAt: policy.offboarding.enabled
                ? new Date(now.getTime() + policy.offboarding.intervalSeconds * 1000)
                : null,
        },
    });

    if (!orgEligible) {
        return { ok: false, statusCode: 403, error: "not-eligible" };
    }

    return { ok: true };
}
