import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import type { LoginEligibilityResult } from "@/app/auth/loginEligibilityResult";
import { isAccountDisabled } from "@/app/auth/accountDisable";
import { findIdentityProviderById } from "@/app/auth/providers/identityProviders/registry";
import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";

export async function enforceLoginEligibility(params: {
    accountId: string;
    env: NodeJS.ProcessEnv;
    now?: Date;
}): Promise<LoginEligibilityResult> {
    const accountId = params.accountId.toString().trim();
    if (!accountId) return { ok: false, statusCode: 401, error: "invalid-token" };

    const policy = resolveAuthPolicyFromEnv(params.env);
    const account = await db.account.findUnique({
        where: { id: accountId },
        select: { id: true },
    });
    if (!account) return { ok: false, statusCode: 401, error: "invalid-token" };
    const disabled = await isAccountDisabled({ accountId: account.id });
    if (disabled) return { ok: false, statusCode: 403, error: "account-disabled" };

    if (policy.requiredLoginProviders.length === 0) {
        return { ok: true };
    }

    const now = params.now ?? new Date();
    for (const providerIdRaw of policy.requiredLoginProviders) {
        const providerId = providerIdRaw.toString().trim().toLowerCase();
        if (!providerId) continue;

        const provider = findIdentityProviderById(params.env, providerId);
        if (!provider?.enforceLoginEligibility) {
            log(
                { module: "auth-policy", level: "warn" },
                "Required login provider is not registered for eligibility enforcement",
                { providerId },
            );
            return { ok: false, statusCode: 503, error: "upstream_error" };
        }

        const result = await provider.enforceLoginEligibility({
            accountId: account.id,
            env: params.env,
            policy,
            now,
        });
        if (!result.ok) return result;
    }

    return { ok: true };
}
