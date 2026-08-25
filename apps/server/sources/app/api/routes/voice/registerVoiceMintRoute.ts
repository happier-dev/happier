import { randomBytes } from "node:crypto";
import { z } from "zod";
import { log } from "@/utils/logging/log";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { parseIntEnv } from "@/config/env";
import { createHostedElevenLabsService } from "@/voice/providers/elevenLabs";
import { readVoiceFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { isResolvedServerFeatureEnabledForGating, resolveServerFeaturesForGating } from "@/app/features/catalog/serverFeatureGate";
import { pruneExpiredVoiceSessionLeases } from "@/app/voice/pruneExpiredVoiceSessionLeases";
import type { VoiceMintRateLimitHandler } from "./voiceMintRateLimit";
import { createVoiceRouteAbortScope } from "./voiceRouteAbortScope";
import { voiceSessionCorrelationIdSchema } from "./voiceSessionLifecycleSchemas";
import { type Fastify } from "../../types";

type VoiceDenyReason =
    | "voice_disabled"
    | "subscription_required"
    | "quota_exceeded"
    | "too_many_sessions"
    | "misconfigured"
    | "upstream_error";

function getPeriodKey(date: Date): string {
    // YYYY-MM in UTC
    return date.toISOString().slice(0, 7);
}

function createVoiceProviderBindingNonce(): string {
    return randomBytes(32).toString("base64url");
}

/**
 * Serializes concurrent mint transactions for one account so the
 * concurrency/quota "winners" reads cannot race under Postgres READ COMMITTED.
 *
 * Postgres: takes a transaction-scoped advisory lock keyed by the account id so
 * every concurrent mint for the same account is ordered, while different
 * accounts proceed in parallel. The lock auto-releases at commit/rollback.
 *
 * SQLite: writes are already globally serialized by the single-writer model, so
 * no extra lock is required.
 */
async function lockAccountForMint(tx: Tx, accountId: string): Promise<void> {
    const provider = getDbProviderFromEnv(process.env, "postgres");
    if (provider !== "postgres") return;
    const raw = tx as { $executeRawUnsafe?: (query: string, ...values: unknown[]) => Promise<unknown> };
    if (typeof raw.$executeRawUnsafe !== "function") return;
    // Hash the account id into the bigint transaction-lock key. The fixed seed
    // scopes that hash to Voice minting without narrowing it to PostgreSQL's
    // incompatible two-int4 advisory-lock overload.
    await raw.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($2, $1::bigint))`,
        0x766f6963, // "voic"
        accountId,
    );
}

function hasRevenueCatVoiceEntitlement(payload: any): boolean {
    const active = payload?.subscriber?.entitlements?.active ?? null;
    if (!active || typeof active !== "object") return false;
    // Prefer explicit "voice" entitlement but keep "pro" as a compatibility fallback.
    return Boolean((active as any).voice) || Boolean((active as any).pro);
}

type RevenueCatDiagnosticCode = "http_4xx" | "http_5xx" | "timeout" | "aborted" | "network_error";

function revenueCatHttpDiagnosticCode(status: number): RevenueCatDiagnosticCode {
    return status >= 500 ? "http_5xx" : "http_4xx";
}

function revenueCatExceptionDiagnosticCode(error: unknown, didTimeout: boolean): RevenueCatDiagnosticCode {
    if (didTimeout) return "timeout";
    if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError") {
        return "aborted";
    }
    return "network_error";
}

export function registerVoiceMintRoute(
    app: Fastify,
    path: "/v1/voice/token" | "/v1/voice/lease/mint",
    mintRateLimit: VoiceMintRateLimitHandler | undefined,
): void {
    app.post(path, {
        ...(mintRateLimit ? { onRequest: mintRateLimit } : null),
        preHandler: app.authenticate,
        config: {
            // The shared handler is installed explicitly by `voiceRoutes`.
            // Disable Fastify's automatic per-route limiter so these aliases
            // cannot acquire separate child stores.
            rateLimit: false,
        },
        schema: {
            body: z
                .object({
                    sessionId: voiceSessionCorrelationIdSchema.optional(),
                })
                .passthrough(),
            response: {
                200: z.object({
                    allowed: z.boolean(),
                    token: z.string(),
                    leaseId: z.string(),
                    bindingNonce: z.string(),
                    expiresAtMs: z.number(),
                }),
                403: z.object({
                    allowed: z.boolean(),
                    reason: z.string(),
                }),
                429: z.object({
                    allowed: z.boolean(),
                    reason: z.string(),
                }),
                503: z.object({
                    allowed: z.boolean(),
                    reason: z.string(),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId; // CUID from JWT
        const { sessionId: rawSessionId } = (request.body ?? {}) as { sessionId?: string };
        const sessionId = typeof rawSessionId === "string" ? rawSessionId : null;

        log({ module: "voice" }, "Voice token request");

        const env = process.env;

        const serverFeatures = resolveServerFeaturesForGating(env);
        const voiceCaps = serverFeatures.capabilities.voice;
        const happierVoiceEnabled = isResolvedServerFeatureEnabledForGating(serverFeatures, "voice.happierVoice");
        if (!happierVoiceEnabled) {
            if (voiceCaps.disabledByBuildPolicy === true) {
                return reply.code(403).send({ allowed: false, reason: "voice_disabled" satisfies VoiceDenyReason });
            }
            if (voiceCaps.requested === true && voiceCaps.configured !== true) {
                return reply.code(503).send({ allowed: false, reason: "misconfigured" satisfies VoiceDenyReason });
            }
            return reply.code(403).send({ allowed: false, reason: "voice_disabled" satisfies VoiceDenyReason });
        }

        const elevenLabsService = createHostedElevenLabsService(env);
        const elevenLabsAgentId = elevenLabsService.configuredAgentId;
        if (!elevenLabsService.isApiConfigured || !elevenLabsAgentId) {
            log({ module: "voice" }, "Voice is misconfigured (missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID)");
            return reply.code(503).send({ allowed: false, reason: "misconfigured" satisfies VoiceDenyReason });
        }

        const voiceFeatureEnv = readVoiceFeatureEnv(env);
        const requireSubscription = voiceFeatureEnv.requireSubscription;
        const freeSessionsPerMonth = Math.max(0, parseIntEnv(env.VOICE_FREE_SESSIONS_PER_MONTH, 0));
        const freeMinutesPerMonth = Math.max(0, parseIntEnv(env.VOICE_FREE_MINUTES_PER_MONTH, 0));
        const maxConcurrentSessions = Math.max(1, parseIntEnv(env.VOICE_MAX_CONCURRENT_SESSIONS, 1));
        const maxSessionSeconds = Math.max(30, parseIntEnv(env.VOICE_MAX_SESSION_SECONDS, 20 * 60));

        const now = new Date();
        const expiresAt = new Date(now.getTime() + maxSessionSeconds * 1000);
        const periodKey = getPeriodKey(now);
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));

        // Global cost guardrail: cap voice minutes per day (UTC). The daily/monthly minute reads
        // run INSIDE the per-account advisory lock + Serializable tx below (alongside the durable
        // monthly free-session quota), counting the candidate lease, so concurrent mints cannot all
        // observe the same pre-burst budget and over-grant (FIND-019 / X-L3).
        const maxMinutesPerDay = Math.max(0, parseIntEnv(env.VOICE_MAX_MINUTES_PER_DAY, 0));
        const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));

        // Opportunistic per-user cleanup to avoid unbounded growth for long-running servers.
        // Best-effort only: never block token minting on cleanup failures.
        try {
            const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            await pruneExpiredVoiceSessionLeases({ accountId: userId, cutoff });
        } catch {
            // ignore
        }

        // Subscription / quota check (production by default).
        let grantedBy: "subscription" | "free" = "subscription";
        if (requireSubscription) {
            const revenueCatSecret = env.REVENUECAT_SECRET_KEY?.trim() ?? "";
            if (!revenueCatSecret) {
                log({ module: "voice" }, "Missing REVENUECAT_SECRET_KEY");
                return reply.code(503).send({ allowed: false, reason: "misconfigured" satisfies VoiceDenyReason });
            }

            let subscribed = false;
            let revenueCatRequestTimedOut = false;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => {
                    revenueCatRequestTimedOut = true;
                    controller.abort();
                }, 10_000);
                let rcRes: Response;
                try {
                    rcRes = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`, {
                        method: "GET",
                        headers: {
                            Authorization: `Bearer ${revenueCatSecret}`,
                            "Content-Type": "application/json",
                        },
                        signal: controller.signal,
                    });
                } finally {
                    clearTimeout(timeoutId);
                }

                if (rcRes.ok) {
                    const rcData = (await rcRes.json()) as any;
                    subscribed = hasRevenueCatVoiceEntitlement(rcData);
                } else {
                    log(
                        { module: "voice", provider: "revenuecat", diagnosticCode: revenueCatHttpDiagnosticCode(rcRes.status) },
                        "RevenueCat check failed",
                    );
                    if (rcRes.status >= 500 || rcRes.status === 401 || rcRes.status === 403) {
                        return reply.code(503).send({ allowed: false, reason: "upstream_error" satisfies VoiceDenyReason });
                    }
                    // 404 (subscriber not found) falls through as not subscribed.
                }
            } catch (error) {
                log(
                    {
                        module: "voice",
                        provider: "revenuecat",
                        diagnosticCode: revenueCatExceptionDiagnosticCode(error, revenueCatRequestTimedOut),
                    },
                    "RevenueCat check failed",
                );
                return reply.code(503).send({ allowed: false, reason: "upstream_error" satisfies VoiceDenyReason });
            }

            if (!subscribed) {
                // No free path at all: deny before opening the mint transaction. Free-minute and
                // free-session quota reads are enforced inside the locked tx below (counting the
                // candidate lease) so they cannot race concurrent mints.
                if (freeMinutesPerMonth <= 0 && freeSessionsPerMonth <= 0) {
                    return reply.code(403).send({ allowed: false, reason: "subscription_required" satisfies VoiceDenyReason });
                }
                grantedBy = "free";
            }
        } else {
            grantedBy = "free";
        }

        // Whether the free-minutes-per-month cap must be enforced for this mint. Subscribers
        // (grantedBy === "subscription") are not minute-capped; only free grants are.
        const enforceFreeMinutesPerMonth = grantedBy === "free" && freeMinutesPerMonth > 0;

        let leaseId: string | null = null;
        let bindingNonce: string | null = null;
        // Persist the session lease + enforce concurrency / quota within one
        // serializable transaction so the read-then-decide checks cannot race under Postgres
        // READ COMMITTED. A per-account advisory lock orders concurrent mints for the same
        // account; `inTx` adds Serializable isolation + retry on serialization failures.
        try {
            const result = await inTx(async (tx) => {
                await lockAccountForMint(tx, userId);

                const lease = await tx.voiceSessionLease.create({
                    data: {
                        accountId: userId,
                        sessionId,
                        periodKey,
                        grantedBy,
                        elevenLabsAgentId,
                        providerBindingNonce: createVoiceProviderBindingNonce(),
                        expiresAt,
                    },
                    select: { id: true, providerBindingNonce: true },
                });
                if (!lease.providerBindingNonce) {
                    throw new Error("voice_provider_binding_nonce_missing");
                }

                const activeWinners = await tx.voiceSessionLease.findMany({
                    where: { accountId: userId, expiresAt: { gt: now }, conversation: null },
                    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                    take: maxConcurrentSessions,
                    select: { id: true },
                });
                const isWithinConcurrency = activeWinners.some((l) => l.id === lease.id);
                if (!isWithinConcurrency) {
                    await tx.voiceSessionLease.delete({ where: { id: lease.id } }).catch(() => {});
                    return { ok: false as const, statusCode: 429 as const, reason: "too_many_sessions" satisfies VoiceDenyReason };
                }

                // Minute caps (daily cost guardrail + free-tier monthly minutes). Both are read inside
                // the locked tx so the candidate lease is already counted as a full-duration pending
                // session — concurrent mints serialize through the lock and each re-reads the budget
                // including prior winners, preventing over-grant. The daily all-grant guardrail uses
                // observation time; the monthly free allowance uses the exact lease grant period.
                const countLeaseMinutesSince = async (
                    since: Date,
                    options: Readonly<{
                        freeGrantsOnly: boolean;
                        grantPeriodKey?: string;
                    }>,
                ): Promise<number> => {
                    const completedGrantFilter = options.freeGrantsOnly
                        ? {
                              OR: [
                                  {
                                      grantedBy: "free",
                                      ...(options.grantPeriodKey
                                          ? { grantPeriodKey: options.grantPeriodKey }
                                          : {}),
                                  },
                                  // During a rolling deployment, an older completion writer can
                                  // omit the additive field. Use the still-present lease only when
                                  // it supplies exact provenance; a pruned NULL row remains unknown.
                                  {
                                      grantedBy: null,
                                      ...(options.grantPeriodKey ? { grantPeriodKey: null } : {}),
                                      lease: {
                                          grantedBy: "free",
                                          ...(options.grantPeriodKey
                                              ? { periodKey: options.grantPeriodKey }
                                              : {}),
                                      },
                                  },
                              ],
                          }
                        : {};
                    const pendingGrantFilter = options.freeGrantsOnly
                        ? { grantedBy: "free" }
                        : {};
                    const [agg, pendingLeaseCount] = await Promise.all([
                        tx.voiceConversation.aggregate({
                            where: {
                                accountId: userId,
                                ...(options.grantPeriodKey
                                    ? {}
                                    : { createdAt: { gte: since } }),
                                ...completedGrantFilter,
                            },
                            _sum: { durationSeconds: true },
                        }),
                        // Conservative accounting: count in-flight (uncompleted) sessions — including
                        // the candidate lease created above — as full max duration. This prevents users
                        // from bypassing minute caps by simply never reporting completion.
                        tx.voiceSessionLease.count({
                            where: {
                                accountId: userId,
                                ...(options.grantPeriodKey
                                    ? { periodKey: options.grantPeriodKey }
                                    : { createdAt: { gte: since } }),
                                conversation: null,
                                ...pendingGrantFilter,
                            },
                        }),
                    ]);
                    const usedSeconds = Number(agg._sum.durationSeconds ?? 0);
                    const pendingSeconds = Math.max(0, Number(pendingLeaseCount ?? 0)) * maxSessionSeconds;
                    return usedSeconds + pendingSeconds;
                };

                if (maxMinutesPerDay > 0) {
                    const effectiveSeconds = await countLeaseMinutesSince(dayStart, { freeGrantsOnly: false });
                    if (Number.isFinite(effectiveSeconds) && effectiveSeconds > maxMinutesPerDay * 60) {
                        await tx.voiceSessionLease.delete({ where: { id: lease.id } }).catch(() => {});
                        return { ok: false as const, statusCode: 403 as const, reason: "quota_exceeded" satisfies VoiceDenyReason };
                    }
                }

                if (enforceFreeMinutesPerMonth) {
                    const effectiveSeconds = await countLeaseMinutesSince(monthStart, {
                        freeGrantsOnly: true,
                        grantPeriodKey: periodKey,
                    });
                    if (Number.isFinite(effectiveSeconds) && effectiveSeconds > freeMinutesPerMonth * 60) {
                        await tx.voiceSessionLease.delete({ where: { id: lease.id } }).catch(() => {});
                        return { ok: false as const, statusCode: 403 as const, reason: "quota_exceeded" satisfies VoiceDenyReason };
                    }
                }

                if (requireSubscription && grantedBy === "free" && freeSessionsPerMonth > 0) {
                    // Count consumed free sessions independent of lease-cleanup timing.
                    // Completed sessions persist as VoiceConversation rows (which survive the
                    // 24h opportunistic cleanup and the retention rule that prune leases), so
                    // a user can no longer reset the monthly quota by waiting for old leases
                    // to be deleted. In-flight (not-yet-completed) free leases for the period
                    // are added so concurrent pending sessions still count toward the quota.
                    const [completedThisPeriod, pendingThisPeriod] = await Promise.all([
                        tx.voiceConversation.count({
                            where: {
                                accountId: userId,
                                OR: [
                                    {
                                        grantedBy: "free",
                                        grantPeriodKey: periodKey,
                                    },
                                    {
                                        grantedBy: null,
                                        grantPeriodKey: null,
                                        lease: {
                                            grantedBy: "free",
                                            periodKey,
                                        },
                                    },
                                ],
                            },
                        }),
                        tx.voiceSessionLease.count({
                            where: { accountId: userId, periodKey, grantedBy: "free", conversation: null },
                        }),
                    ]);
                    const consumedFreeSessions = completedThisPeriod + pendingThisPeriod;
                    if (consumedFreeSessions > freeSessionsPerMonth) {
                        await tx.voiceSessionLease.delete({ where: { id: lease.id } }).catch(() => {});
                        return { ok: false as const, statusCode: 403 as const, reason: "quota_exceeded" satisfies VoiceDenyReason };
                    }
                }

                return { ok: true as const, leaseId: lease.id, bindingNonce: lease.providerBindingNonce };
            });

            if (!result.ok) {
                return reply.code(result.statusCode).send({ allowed: false, reason: result.reason });
            }
            leaseId = result.leaseId;
            bindingNonce = result.bindingNonce;
        } catch {
            log({ module: "voice" }, "Failed to create/enforce voice session lease");
            return reply.code(503).send({ allowed: false, reason: "upstream_error" satisfies VoiceDenyReason });
        }

        const providerAbortScope = createVoiceRouteAbortScope(reply);
        const mintResult = await elevenLabsService
            .mintConversationToken({ signal: providerAbortScope.signal })
            .finally(() => providerAbortScope.dispose());
        if (!mintResult.ok) {
            if (leaseId) {
                await db.voiceSessionLease.delete({ where: { id: leaseId } }).catch(() => {});
            }
            log(
                { module: "voice", provider: "elevenlabs", diagnosticCode: mintResult.diagnosticCode },
                "Hosted voice token mint failed",
            );
            return reply.code(503).send({ allowed: false, reason: "upstream_error" satisfies VoiceDenyReason });
        }

        log({ module: "voice" }, "Voice token issued");
        return reply.send({
            allowed: true,
            token: mintResult.token,
            leaseId: leaseId!,
            bindingNonce: bindingNonce!,
            expiresAtMs: expiresAt.getTime(),
        });
    });
}
