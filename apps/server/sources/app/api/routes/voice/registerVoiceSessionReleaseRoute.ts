import { z } from "zod";
import { isResolvedServerFeatureEnabledForGating, resolveServerFeaturesForGating } from "@/app/features/catalog/serverFeatureGate";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { db } from "@/storage/db";
import { type VoiceSessionReleaseBody, voiceSessionReleaseBodySchema } from "./voiceSessionLifecycleSchemas";
import { type Fastify } from "../../types";

export function registerVoiceSessionReleaseRoute(app: Fastify): void {
    app.post("/v1/voice/session/release", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "voice.sessionComplete"),
        },
        schema: {
            body: voiceSessionReleaseBodySchema,
            response: {
                200: z.object({ ok: z.literal(true) }),
                404: z.object({ ok: z.literal(false), reason: z.literal("not_found") }),
                503: z.object({ ok: z.literal(false), reason: z.literal("upstream_error") }),
            },
        },
    }, async (request, reply) => {
        const serverFeatures = resolveServerFeaturesForGating(process.env);
        if (!isResolvedServerFeatureEnabledForGating(serverFeatures, "voice.happierVoice")) {
            return reply.code(404).send({ ok: false, reason: "not_found" as const });
        }

        const { leaseId } = request.body as VoiceSessionReleaseBody;
        try {
            await db.voiceSessionLease.updateMany({
                where: { id: leaseId, accountId: request.userId },
                data: { expiresAt: new Date() },
            });
        } catch {
            return reply.code(503).send({ ok: false, reason: "upstream_error" as const });
        }

        // Deliberately existence-oblivious: release is idempotent and must not
        // disclose whether another Account owns the supplied lease id.
        return reply.send({ ok: true as const });
    });
}
