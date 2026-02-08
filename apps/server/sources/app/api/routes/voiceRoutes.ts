import { z } from "zod";
import { type Fastify } from "../types";
import { log } from "@/utils/log";
import { db } from "@/storage/db";
import { parseBooleanEnv, parseIntEnv } from "@/config/env";
import { resolveElevenLabsAgentId } from "@/voice/elevenLabsEnv";

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

function hasRevenueCatVoiceEntitlement(payload: any): boolean {
    const active = payload?.subscriber?.entitlements?.active ?? null;
    if (!active || typeof active !== "object") return false;
    // Prefer explicit "voice" entitlement but keep "pro" as a compatibility fallback.
    return Boolean((active as any).voice) || Boolean((active as any).pro);
}

function extractConversationAgentId(payload: any): string | null {
    const direct =
        (typeof payload?.agent_id === "string" && payload.agent_id.trim()) ||
        (typeof payload?.agentId === "string" && payload.agentId.trim()) ||
        (typeof payload?.agent?.id === "string" && payload.agent.id.trim()) ||
        (typeof payload?.metadata?.agent_id === "string" && payload.metadata.agent_id.trim()) ||
        (typeof payload?.metadata?.agentId === "string" && payload.metadata.agentId.trim()) ||
        "";
    return direct || null;
}

function extractConversationStartUnixSecs(payload: any): number | null {
    const raw = Number(payload?.metadata?.start_time_unix_secs);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return Math.floor(raw);
}

export function voiceRoutes(app: Fastify) {
    app.post('/v1/voice/token', {
        preHandler: app.authenticate,
        config: (() => {
            const maxPerMinute = Math.max(0, parseIntEnv(process.env.VOICE_TOKEN_MAX_PER_MINUTE, 10));
            return {
                rateLimit:
                    maxPerMinute <= 0
                        ? false
                        : {
                              max: maxPerMinute,
                              timeWindow: "1 minute",
                              // Rate limit per authenticated user when possible.
                              keyGenerator: (req: any) =>
                                  req && typeof (req as any).userId === "string"
                                      ? (req as any).userId
                                      : req.ip,
                          },
            };
        })(),
        schema: {
            body: z.object({
                sessionId: z.string().optional(),
            }).passthrough(),
            response: {
                200: z.object({
                    allowed: z.boolean(),
                    token: z.string(),
                    leaseId: z.string(),
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
            }
        }
    }, async (request, reply) => {
        const userId = request.userId; // CUID from JWT
        const { sessionId } = request.body as { sessionId?: string };

        log({ module: 'voice' }, `Voice token request from user ${userId}`);

        const env = process.env;
        const isProduction = env.NODE_ENV === "production";

        const voiceEnabled = parseBooleanEnv(env.VOICE_ENABLED, true);
        if (!voiceEnabled) {
            return reply.code(403).send({ allowed: false, reason: "voice_disabled" satisfies VoiceDenyReason });
        }

        // Check if 11Labs API key is configured
        const elevenLabsApiKey = env.ELEVENLABS_API_KEY?.trim() ?? "";
        const elevenLabsAgentId = resolveElevenLabsAgentId(env);
        if (!elevenLabsApiKey || !elevenLabsAgentId) {
            log({ module: "voice" }, "Voice is misconfigured (missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID)");
            return reply
                .code(503)
                .send({ allowed: false, reason: "misconfigured" satisfies VoiceDenyReason });
        }

        const requireSubscription = parseBooleanEnv(env.VOICE_REQUIRE_SUBSCRIPTION, isProduction);
        const freeSessionsPerMonth = Math.max(0, parseIntEnv(env.VOICE_FREE_SESSIONS_PER_MONTH, 0));
        const freeMinutesPerMonth = Math.max(0, parseIntEnv(env.VOICE_FREE_MINUTES_PER_MONTH, 0));
        const maxConcurrentSessions = Math.max(1, parseIntEnv(env.VOICE_MAX_CONCURRENT_SESSIONS, 1));
        const maxSessionSeconds = Math.max(30, parseIntEnv(env.VOICE_MAX_SESSION_SECONDS, 20 * 60));

        const now = new Date();
        const expiresAt = new Date(now.getTime() + maxSessionSeconds * 1000);
        const periodKey = getPeriodKey(now);

        // Global cost guardrail: cap voice minutes per day (UTC).
        const maxMinutesPerDay = Math.max(0, parseIntEnv(env.VOICE_MAX_MINUTES_PER_DAY, 0));
        if (maxMinutesPerDay > 0) {
            const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
            try {
                const [agg, pendingLeaseCount] = await Promise.all([
                    db.voiceConversation.aggregate({
                        where: {
                            accountId: userId,
                            createdAt: { gte: dayStart },
                        },
                        _sum: { durationSeconds: true },
                    }),
                    // Conservative accounting: count in-flight (uncompleted) sessions as full max duration.
                    // This prevents users from bypassing minute caps by simply never reporting completion.
                    db.voiceSessionLease.count({
                        where: {
                            accountId: userId,
                            createdAt: { gte: dayStart },
                            conversation: null,
                        },
                    }),
                ]);

                const usedSeconds = Number(agg._sum.durationSeconds ?? 0);
                const pendingSeconds = Math.max(0, Number(pendingLeaseCount ?? 0)) * maxSessionSeconds;
                const effectiveSeconds = usedSeconds + pendingSeconds;
                if (Number.isFinite(effectiveSeconds) && effectiveSeconds >= maxMinutesPerDay * 60) {
                    return reply.code(403).send({ allowed: false, reason: "quota_exceeded" satisfies VoiceDenyReason });
                }
            } catch (e) {
                log({ module: "voice" }, "Failed to enforce VOICE_MAX_MINUTES_PER_DAY", e);
                return reply.code(503).send({ allowed: false, reason: "upstream_error" satisfies VoiceDenyReason });
            }
        }

        // Opportunistic per-user cleanup to avoid unbounded growth for long-running servers.
        // Best-effort only: never block token minting on cleanup failures.
        try {
            const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            await db.voiceSessionLease.deleteMany({
                where: {
                    accountId: userId,
                    expiresAt: { lt: cutoff },
                },
            });
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
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10_000);
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
                    log({ module: "voice" }, `RevenueCat check failed for user ${userId}: ${rcRes.status}`);
                    if (rcRes.status >= 500 || rcRes.status === 401 || rcRes.status === 403) {
                        return reply.code(503).send({ allowed: false, reason: "upstream_error" satisfies VoiceDenyReason });
                    }
                    // 404 (subscriber not found) falls through as not subscribed.
                }
            } catch (e) {
                log({ module: "voice" }, "RevenueCat check threw", e);
                return reply.code(503).send({ allowed: false, reason: "upstream_error" satisfies VoiceDenyReason });
            }

            if (!subscribed) {
                if (freeMinutesPerMonth > 0) {
                    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
                    try {
                        const [agg, pendingLeaseCount] = await Promise.all([
                            db.voiceConversation.aggregate({
                                where: {
                                    accountId: userId,
                                    createdAt: { gte: monthStart },
                                },
                                _sum: { durationSeconds: true },
                            }),
                            db.voiceSessionLease.count({
                                where: {
                                    accountId: userId,
                                    createdAt: { gte: monthStart },
                                    conversation: null,
                                },
                            }),
                        ]);
                        const usedSeconds = Number(agg._sum.durationSeconds ?? 0);
                        const pendingSeconds = Math.max(0, Number(pendingLeaseCount ?? 0)) * maxSessionSeconds;
                        const effectiveSeconds = usedSeconds + pendingSeconds;
                        if (Number.isFinite(effectiveSeconds) && effectiveSeconds >= freeMinutesPerMonth * 60) {
                            return reply.code(403).send({ allowed: false, reason: "quota_exceeded" satisfies VoiceDenyReason });
                        }
                    } catch (e) {
                        log({ module: "voice" }, "Failed to enforce VOICE_FREE_MINUTES_PER_MONTH", e);
                        return reply.code(503).send({ allowed: false, reason: "upstream_error" satisfies VoiceDenyReason });
                    }
                } else if (freeSessionsPerMonth <= 0) {
                    return reply.code(403).send({ allowed: false, reason: "subscription_required" satisfies VoiceDenyReason });
                }
                grantedBy = "free";
            }
        } else {
            grantedBy = "free";
        }

        // Persist a session lease before minting to close race windows.
        let leaseId: string | null = null;
        try {
            const lease = await db.voiceSessionLease.create({
                data: {
                    accountId: userId,
                    sessionId: sessionId ?? null,
                    periodKey,
                    grantedBy,
                    elevenLabsAgentId,
                    expiresAt,
                },
                select: { id: true },
            });
            leaseId = lease.id;
        } catch (e) {
            log({ module: "voice" }, "Failed to create voice session lease", e);
            return reply.code(503).send({ allowed: false, reason: "upstream_error" satisfies VoiceDenyReason });
        }

        // Enforce concurrency/quota after creating a lease to close TOCTOU race windows under concurrent requests.
        try {
            const activeWinners = await db.voiceSessionLease.findMany({
                where: { accountId: userId, expiresAt: { gt: now }, conversation: null },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                take: maxConcurrentSessions,
                select: { id: true },
            });
            const isWithinConcurrency = activeWinners.some((l) => l.id === leaseId);
            if (!isWithinConcurrency) {
                await db.voiceSessionLease.delete({ where: { id: leaseId } }).catch(() => {});
                return reply.code(429).send({ allowed: false, reason: "too_many_sessions" satisfies VoiceDenyReason });
            }

            if (requireSubscription && grantedBy === "free" && freeSessionsPerMonth > 0) {
                const quotaWinners = await db.voiceSessionLease.findMany({
                    where: { accountId: userId, periodKey, grantedBy: "free" },
                    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                    take: freeSessionsPerMonth,
                    select: { id: true },
                });
                const isWithinQuota = quotaWinners.some((l) => l.id === leaseId);
                if (!isWithinQuota) {
                    await db.voiceSessionLease.delete({ where: { id: leaseId } }).catch(() => {});
                    return reply.code(403).send({ allowed: false, reason: "quota_exceeded" satisfies VoiceDenyReason });
                }
            }
        } catch (e) {
            log({ module: "voice" }, "Failed to enforce voice concurrency/quota", e);
            await db.voiceSessionLease.delete({ where: { id: leaseId } }).catch(() => {});
            return reply.code(503).send({ allowed: false, reason: "upstream_error" satisfies VoiceDenyReason });
        }

        // Get 11Labs conversation token
        let response: Response;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10_000);
            try {
                response = await fetch(
                    `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(elevenLabsAgentId)}`,
                    {
                        method: "GET",
                        headers: {
                            "xi-api-key": elevenLabsApiKey,
                            Accept: "application/json",
                        },
                        signal: controller.signal,
                    }
                );
            } finally {
                clearTimeout(timeoutId);
            }
        } catch (e) {
            if (leaseId) {
                await db.voiceSessionLease.delete({ where: { id: leaseId } }).catch(() => {});
            }
            log({ module: "voice" }, `Failed to get 11Labs token for user ${userId}`, e);
            return reply.code(503).send({ allowed: false, reason: "upstream_error" satisfies VoiceDenyReason });
        }
        
        if (!response.ok) {
            if (leaseId) {
                await db.voiceSessionLease.delete({ where: { id: leaseId } }).catch(() => {});
            }
            log({ module: 'voice' }, `Failed to get 11Labs token for user ${userId}`);
            return reply.code(503).send({ allowed: false, reason: "upstream_error" satisfies VoiceDenyReason });
        }

        const data = await response.json().catch(() => null) as any;
        const token = data && typeof data === "object" ? (data as any).token : null;
        if (!token || typeof token !== "string") {
            if (leaseId) {
                await db.voiceSessionLease.delete({ where: { id: leaseId } }).catch(() => {});
            }
            return reply.code(503).send({ allowed: false, reason: "upstream_error" satisfies VoiceDenyReason });
        }

        log({ module: 'voice' }, `Voice token issued for user ${userId}`);
        return reply.send({
            allowed: true,
            token,
            leaseId: leaseId!,
            expiresAtMs: expiresAt.getTime(),
        });
    });

    app.post('/v1/voice/session/complete', {
        preHandler: app.authenticate,
        config: (() => {
            const maxPerMinute = Math.max(0, parseIntEnv(process.env.VOICE_COMPLETE_MAX_PER_MINUTE, 60));
            return {
                rateLimit:
                    maxPerMinute <= 0
                        ? false
                        : {
                              max: maxPerMinute,
                              timeWindow: "1 minute",
                              keyGenerator: (req: any) =>
                                  req && typeof (req as any).userId === "string"
                                      ? (req as any).userId
                                      : req.ip,
                          },
            };
        })(),
        schema: {
            body: z.object({
                leaseId: z.string(),
                providerConversationId: z.string(),
            }),
            response: {
                200: z.object({
                    ok: z.literal(true),
                    durationSeconds: z.number().int().min(0),
                }),
                404: z.object({
                    ok: z.literal(false),
                    reason: z.literal("not_found"),
                }),
                503: z.object({
                    ok: z.literal(false),
                    reason: z.literal("upstream_error"),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { leaseId, providerConversationId } = request.body as { leaseId: string; providerConversationId: string };

        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY?.trim() ?? "";
        if (!elevenLabsApiKey) {
            return reply.code(503).send({ ok: false, reason: "upstream_error" as const });
        }

        const lease = await db.voiceSessionLease.findFirst({
            where: { id: leaseId, accountId: userId },
            select: { id: true, accountId: true, elevenLabsAgentId: true, createdAt: true, expiresAt: true },
        });
        if (!lease) {
            // Fail closed without leaking whether the lease exists for other users.
            return reply.code(404).send({ ok: false, reason: "not_found" as const });
        }

        let durationSeconds = 0;
        let startedAt: Date | null = null;
        let endedAt: Date | null = null;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10_000);
            let res: Response;
            try {
                res = await fetch(
                    `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(providerConversationId)}`,
                    {
                        method: "GET",
                        headers: {
                            "xi-api-key": elevenLabsApiKey,
                            Accept: "application/json",
                        },
                        signal: controller.signal,
                    },
                );
            } finally {
                clearTimeout(timeoutId);
            }
            if (!res.ok) {
                return reply.code(503).send({ ok: false, reason: "upstream_error" as const });
            }
            const json = (await res.json().catch(() => null)) as any;
            const dur = Number(json?.metadata?.call_duration_secs);
            if (!Number.isFinite(dur) || dur < 0) {
                return reply.code(503).send({ ok: false, reason: "upstream_error" as const });
            }
            durationSeconds = Math.floor(dur);

            const conversationAgentId = extractConversationAgentId(json);
            if (!conversationAgentId || conversationAgentId !== lease.elevenLabsAgentId) {
                // Do not disclose cross-lease/cross-user existence details.
                return reply.code(404).send({ ok: false, reason: "not_found" as const });
            }

            const startUnix = extractConversationStartUnixSecs(json);
            if (startUnix !== null) {
                const candidateStartedAt = new Date(startUnix * 1000);
                const lowerBound = lease.createdAt.getTime() - 5 * 60 * 1000;
                const upperBound = lease.expiresAt.getTime() + 5 * 60 * 1000;
                if (candidateStartedAt.getTime() < lowerBound || candidateStartedAt.getTime() > upperBound) {
                    return reply.code(404).send({ ok: false, reason: "not_found" as const });
                }
                startedAt = candidateStartedAt;
                endedAt = new Date(startedAt.getTime() + durationSeconds * 1000);
            } else {
                return reply.code(404).send({ ok: false, reason: "not_found" as const });
            }
        } catch (e) {
            return reply.code(503).send({ ok: false, reason: "upstream_error" as const });
        }

        try {
            const existingForConversation = await db.voiceConversation.findUnique({
                where: {
                    providerId_providerConversationId: {
                        providerId: "elevenlabs_agents",
                        providerConversationId,
                    },
                },
                select: { accountId: true, leaseId: true },
            });
            if (
                existingForConversation &&
                (existingForConversation.accountId !== lease.accountId ||
                    (existingForConversation.leaseId && existingForConversation.leaseId !== lease.id))
            ) {
                return reply.code(404).send({ ok: false, reason: "not_found" as const });
            }

            const existingForLease = await db.voiceConversation.findUnique({
                where: { leaseId: lease.id },
                select: { providerConversationId: true },
            });
            if (existingForLease && existingForLease.providerConversationId !== providerConversationId) {
                return reply.code(404).send({ ok: false, reason: "not_found" as const });
            }

            await db.voiceConversation.upsert({
                where: {
                    providerId_providerConversationId: {
                        providerId: "elevenlabs_agents",
                        providerConversationId,
                    },
                },
                create: {
                    accountId: lease.accountId,
                    leaseId: lease.id,
                    providerId: "elevenlabs_agents",
                    providerConversationId,
                    startedAt,
                    endedAt,
                    durationSeconds,
                    billedUnits: null,
                },
                update: {
                    leaseId: lease.id,
                    startedAt,
                    endedAt,
                    durationSeconds,
                },
            });
        } catch (e) {
            log({ module: "voice" }, "Failed to persist voice conversation", {
                providerConversationId,
                leaseId: lease.id,
                err: e,
            });
            return reply.code(503).send({ ok: false, reason: "upstream_error" as const });
        }

        return reply.send({ ok: true, durationSeconds });
    });
}
