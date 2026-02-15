import { z } from "zod";
import { log } from "@/utils/logging/log";
import { db } from "@/storage/db";
import { parseIntEnv } from "@/config/env";
import { resolveElevenLabsApiBaseUrl } from "@/voice/elevenLabsEnv";
import { type Fastify } from "../../types";

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

export function registerVoiceSessionCompleteRoute(app: Fastify): void {
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
        const elevenLabsApiBaseUrl = resolveElevenLabsApiBaseUrl(process.env);
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
                    `${elevenLabsApiBaseUrl}/v1/convai/conversations/${encodeURIComponent(providerConversationId)}`,
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
