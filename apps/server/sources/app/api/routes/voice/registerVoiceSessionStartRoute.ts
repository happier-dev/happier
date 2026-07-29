import { z } from "zod";
import { isResolvedServerFeatureEnabledForGating, resolveServerFeaturesForGating } from "@/app/features/catalog/serverFeatureGate";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { db } from "@/storage/db";
import { type VoiceSessionLifecycleBody, voiceSessionLifecycleBodySchema } from "./voiceSessionLifecycleSchemas";
import { type Fastify } from "../../types";

async function ownsUnexpiredVoiceSessionLease(params: Readonly<{
    accountId: string;
    leaseId: string;
}>): Promise<boolean> {
    const lease = await db.voiceSessionLease.findFirst({
        where: {
            id: params.leaseId,
            accountId: params.accountId,
            expiresAt: { gt: new Date() },
        },
        select: { id: true },
    });
    return lease !== null;
}

export function registerVoiceSessionStartRoute(app: Fastify): void {
    // Read-only compatibility endpoint. Delete it once the server's minimum supported client
    // version is at or beyond the first release that removed bindHappierVoiceSessionStart.
    // Until then it validates ownership/expiry but must never mint provider billing identity.
    app.post("/v1/voice/session/start", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "voice.sessionComplete"),
        },
        schema: {
            body: voiceSessionLifecycleBodySchema,
            response: {
                200: z.object({
                    ok: z.literal(true),
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
        const serverFeatures = resolveServerFeaturesForGating(process.env);
        if (!isResolvedServerFeatureEnabledForGating(serverFeatures, "voice.happierVoice")) {
            return reply.code(404).send({ ok: false, reason: "not_found" as const });
        }

        const { leaseId } = request.body as VoiceSessionLifecycleBody;

        try {
            const ownsLease = await ownsUnexpiredVoiceSessionLease({
                accountId: request.userId,
                leaseId,
            });
            if (!ownsLease) {
                return reply.code(404).send({ ok: false, reason: "not_found" as const });
            }
        } catch {
            return reply.code(503).send({ ok: false, reason: "upstream_error" as const });
        }

        return reply.send({ ok: true as const });
    });
}
