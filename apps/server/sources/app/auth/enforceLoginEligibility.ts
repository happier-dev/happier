import { LRUTtlMap } from "@/utils/collections/lru";
import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import type { LoginEligibilityResult } from "@/app/auth/loginEligibilityResult";
import { isActiveHomeAccountStatus, type AccountStatusV1 } from '@happier-dev/protocol/home/governance';
import { resolveIdentityRuntimeById } from "@/app/auth/providers/identityProviderCatalog";
import { observeLoginEligibilityStage, recordLoginEligibilityCache } from "@/app/monitoring/metrics/authMetrics";
import { inTx } from "@/storage/inTx";
import { log } from "@/utils/logging/log";
import { advanceSignInPolicyGeneration, readEnvSignInPolicyGeneration, readSignInPolicyGeneration } from "@/app/auth/signInPolicyGeneration";
import type { VerifiedAuthToken } from "@/app/auth/auth";

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

/** Drops one Account's cached positive result (an offboarding verdict elsewhere revoked it). */
export function dropLoginEligibilityPositiveCacheEntry(accountId: string): void {
    loginEligibilityPositiveCache?.delete(accountId);
}

/**
 * A Home sign-in policy change re-decides eligibility at once: cached positive results were
 * decided under the previous policy, and a decision still in flight cannot cache its result.
 */
export function invalidateLoginEligibilityPositiveCache(): void {
    advanceSignInPolicyGeneration();
    loginEligibilityPositiveCache?.clear();
    loginEligibilityInflight = new Map();
}

export async function enforceLoginEligibility(params: {
    accountId: string;
    /**
     * Reads the sign-in policy env: the Home overlay of the request (`readRequestHomeEnv`) or socket
     * (`readHomeConfigEnv`), because the policy keys are live Home settings. Called only when the
     * positive cache misses, so a hot result costs no Home read; a Home change applies at the next miss.
     */
    readEnv: () => Promise<NodeJS.ProcessEnv>;
    now?: Date;
    /** The canonical verifier result from this admission only; never a cached caller projection. */
    verifiedCredential?: VerifiedAuthToken;
}): Promise<LoginEligibilityResult> {
    const startedAt = Date.now();
    const accountId = params.accountId.toString().trim();
    // Captured before the policy is read: a result decided under an older policy is never cached.
    // An env a Home configuration reader built earlier carries the generation it was read under.
    let generation = readSignInPolicyGeneration();
    const cachePositive = (cache: LRUTtlMap<string, true> | null): void => {
        if (generation === readSignInPolicyGeneration()) cache?.set(accountId, true);
    };
    if (!accountId || (params.verifiedCredential && params.verifiedCredential.userId !== accountId)) {
        observeLoginEligibilityStage({
            stage: "total",
            result: "error",
            durationMs: Date.now() - startedAt,
        });
        return { ok: false, statusCode: 401, error: "invalid-token" };
    }

    // Token verification already reads current Account lifecycle (and signed-token epoch).
    // Reuse that same-admission fact; standalone login callers still read lifecycle even
    // while the provider result is hot. Neither path caches Account lifecycle.
    if (!params.verifiedCredential) {
        let account: { id: string; status: AccountStatusV1 } | null = null;
        const accountLookupStartedAt = Date.now();
        try {
            account = await inTx(tx => tx.account.findUnique({
                where: { id: accountId },
                select: { id: true, status: true },
            }), { readOnly: true, singleStatementRead: true });
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
    }

    // The cache TTL and size are deployment keys, never live Home settings.
    const positiveCache = getLoginEligibilityPositiveCache(process.env);
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
        let env: NodeJS.ProcessEnv;
        try {
            env = await params.readEnv();
        } catch (error) {
            log(
                { module: "auth-login-eligibility", level: "error" },
                "Failed to read the sign-in policy for eligibility enforcement",
                { accountId, error },
            );
            observeLoginEligibilityStage({
                stage: "total",
                result: "error",
                durationMs: Date.now() - startedAt,
            });
            return { ok: false, statusCode: 503, error: "upstream_error" };
        }
        generation = Math.min(generation, readEnvSignInPolicyGeneration(env) ?? generation);
        const policy = resolveAuthPolicyFromEnv(env);
        if (policy.requiredLoginProviders.length === 0) {
            cachePositive(positiveCache);
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
                const provider = (await resolveIdentityRuntimeById(env, providerId))?.provider;
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
                    env,
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
        cachePositive(positiveCache);
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
