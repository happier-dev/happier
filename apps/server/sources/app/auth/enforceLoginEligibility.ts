import { LRUTtlMap } from "@/utils/collections/lru";
import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import type { LoginEligibilityResult } from "@/app/auth/loginEligibilityResult";
import { isActiveHomeAccountStatus, type AccountStatusV1 } from "@happier-dev/protocol";
import { resolveIdentityRuntimeById } from "@/app/auth/providers/identityProviderCatalog";
import { observeLoginEligibilityStage, recordLoginEligibilityCache } from "@/app/monitoring/metrics/authMetrics";
import { inTx } from "@/storage/inTx";
import { log } from "@/utils/logging/log";

const DEFAULT_LOGIN_ELIGIBILITY_CACHE_TTL_MS = 1_000;
const DEFAULT_LOGIN_ELIGIBILITY_CACHE_MAX_ENTRIES = 20_000;

let loginEligibilityPositiveCache: LRUTtlMap<string, true> | null = null;
let loginEligibilityInflight = new Map<string, Promise<LoginEligibilityResult>>();

function resolveLoginEligibilityCacheTtlMsFromEnv(env: NodeJS.ProcessEnv): number {
    const raw = (env.AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS ?? "").toString().trim();
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 0) {
        return DEFAULT_LOGIN_ELIGIBILITY_CACHE_TTL_MS;
    }
    return Math.max(0, Math.min(60_000, parsed));
}

function resolveLoginEligibilityCacheMaxEntriesFromEnv(env: NodeJS.ProcessEnv): number {
    const raw = (env.AUTH_LOGIN_ELIGIBILITY_CACHE_MAX_ENTRIES ?? "").toString().trim();
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 0) {
        return DEFAULT_LOGIN_ELIGIBILITY_CACHE_MAX_ENTRIES;
    }
    return Math.max(0, Math.min(200_000, parsed));
}

function getLoginEligibilityPositiveCache(env: NodeJS.ProcessEnv): LRUTtlMap<string, true> | null {
    const ttlMs = resolveLoginEligibilityCacheTtlMsFromEnv(env);
    const maxEntries = resolveLoginEligibilityCacheMaxEntriesFromEnv(env);
    if (ttlMs <= 0 || maxEntries <= 0) {
        loginEligibilityPositiveCache = null;
        return null;
    }

    const existing = loginEligibilityPositiveCache;
    if (existing) {
        return existing;
    }

    loginEligibilityPositiveCache = new LRUTtlMap<string, true>({
        ttlMs,
        maxSize: maxEntries,
    });
    return loginEligibilityPositiveCache;
}

export async function enforceLoginEligibility(params: {
    accountId: string;
    env: NodeJS.ProcessEnv;
    now?: Date;
}): Promise<LoginEligibilityResult> {
    const startedAt = Date.now();
    const accountId = params.accountId.toString().trim();
    if (!accountId) {
        observeLoginEligibilityStage({
            stage: "total",
            result: "error",
            durationMs: Date.now() - startedAt,
        });
        return { ok: false, statusCode: 401, error: "invalid-token" };
    }

    // Lifecycle facts are never cached: another replica may disable or erase
    // this Account while a provider eligibility result remains hot.
    let account: { id: string; status: AccountStatusV1 } | null = null;
    const accountLookupStartedAt = Date.now();
    try {
        account = await inTx(tx => tx.account.findUnique({
            where: { id: accountId },
            select: { id: true, status: true },
        }), { readOnly: true });
        observeLoginEligibilityStage({
            stage: "account_lookup",
            result: "ok",
            durationMs: Date.now() - accountLookupStartedAt,
        });
    } catch (error) {
        observeLoginEligibilityStage({
            stage: "account_lookup",
            result: "error",
            durationMs: Date.now() - accountLookupStartedAt,
        });
        log(
            { module: "auth-login-eligibility", level: "error" },
            "Failed to look up account for eligibility enforcement",
            { accountId, error },
        );
        observeLoginEligibilityStage({
            stage: "total",
            result: "error",
            durationMs: Date.now() - startedAt,
        });
        return { ok: false, statusCode: 503, error: "upstream_error" };
    }
    if (!account) {
        observeLoginEligibilityStage({
            stage: "total",
            result: "error",
            durationMs: Date.now() - startedAt,
        });
        return { ok: false, statusCode: 401, error: "invalid-token" };
    }

    if (!isActiveHomeAccountStatus(account.status)) {
        observeLoginEligibilityStage({
            stage: "total",
            result: "error",
            durationMs: Date.now() - startedAt,
        });
        return { ok: false, statusCode: 403, error: "account-disabled" };
    }

    const positiveCache = getLoginEligibilityPositiveCache(params.env);
    if (positiveCache?.get(accountId) === true) {
        recordLoginEligibilityCache({ cache: "positive_result", result: "hit" });
        observeLoginEligibilityStage({
            stage: "total",
            result: "ok",
            durationMs: Date.now() - startedAt,
        });
        return { ok: true };
    }
    recordLoginEligibilityCache({ cache: "positive_result", result: "miss" });

    const inflight = loginEligibilityInflight.get(accountId);
    if (inflight) {
        recordLoginEligibilityCache({ cache: "inflight", result: "hit" });
        return await inflight;
    }
    recordLoginEligibilityCache({ cache: "inflight", result: "miss" });

    const eligibilityPromise = (async (): Promise<LoginEligibilityResult> => {
        const policy = resolveAuthPolicyFromEnv(params.env);
        if (policy.requiredLoginProviders.length === 0) {
            positiveCache?.set(accountId, true);
            observeLoginEligibilityStage({
                stage: "total",
                result: "ok",
                durationMs: Date.now() - startedAt,
            });
            return { ok: true };
        }

        const providerChecksStartedAt = Date.now();
        const now = params.now ?? new Date();
        for (const providerIdRaw of policy.requiredLoginProviders) {
            const providerId = providerIdRaw.toString().trim().toLowerCase();
            if (!providerId) continue;

            let result: LoginEligibilityResult;
            try {
                const provider = (await resolveIdentityRuntimeById(params.env, providerId))?.provider;
                if (!provider?.enforceLoginEligibility) {
                    observeLoginEligibilityStage({
                        stage: "provider_checks",
                        result: "error",
                        durationMs: Date.now() - providerChecksStartedAt,
                    });
                    log(
                        { module: "auth-policy", level: "warn" },
                        "Required login provider is not registered for eligibility enforcement",
                        { providerId },
                    );
                    observeLoginEligibilityStage({
                        stage: "total",
                        result: "error",
                        durationMs: Date.now() - startedAt,
                    });
                    return { ok: false, statusCode: 503, error: "upstream_error" };
                }
                result = await provider.enforceLoginEligibility({
                    accountId: accountId,
                    env: params.env,
                    policy,
                    now,
                });
            } catch (error) {
                observeLoginEligibilityStage({
                    stage: "provider_checks",
                    result: "error",
                    durationMs: Date.now() - providerChecksStartedAt,
                });
                log(
                    { module: "auth-login-eligibility", level: "error" },
                    "Required login provider eligibility enforcement failed",
                    { accountId: accountId, providerId, error },
                );
                observeLoginEligibilityStage({
                    stage: "total",
                    result: "error",
                    durationMs: Date.now() - startedAt,
                });
                return { ok: false, statusCode: 503, error: "upstream_error" };
            }
            if (!result.ok) {
                observeLoginEligibilityStage({
                    stage: "provider_checks",
                    result: "error",
                    durationMs: Date.now() - providerChecksStartedAt,
                });
                observeLoginEligibilityStage({
                    stage: "total",
                    result: "error",
                    durationMs: Date.now() - startedAt,
                });
                return result;
            }
        }
        observeLoginEligibilityStage({
            stage: "provider_checks",
            result: "ok",
            durationMs: Date.now() - providerChecksStartedAt,
        });

        const result = { ok: true } satisfies LoginEligibilityResult;
        positiveCache?.set(accountId, true);
        observeLoginEligibilityStage({
            stage: "total",
            result: "ok",
            durationMs: Date.now() - startedAt,
        });
        return result;
    })();

    loginEligibilityInflight.set(accountId, eligibilityPromise);
    try {
        return await eligibilityPromise;
    } finally {
        if (loginEligibilityInflight.get(accountId) === eligibilityPromise) {
            loginEligibilityInflight.delete(accountId);
        }
    }
}
