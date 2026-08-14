import { z } from "zod";
import { type Fastify } from "../../types";

const LegacyClientVersionCheckRequestSchema = z.object({
    platform: z.string(),
    version: z.string(),
    app_id: z.string(),
});

const LegacyClientVersionCheckResponseSchema = z.object({
    update_required: z.boolean(),
    update_url: z.string().nullable(),
});

/**
 * Registers the client version endpoints. The deployed native request and
 * response remain legacy-shaped. Session protocol support is negotiated
 * independently through `/v1/features`.
 */
export function versionRoutes(app: Fastify) {
    app.get('/v1/version', {
        schema: {
            response: {
                200: z.object({
                    ok: z.literal(true),
                    source_sha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
                }),
            },
        },
    }, async () => {
        const sourceSha = String(process.env.HAPPIER_RELEASE_SOURCE_SHA ?? '').trim();
        return {
            ok: true as const,
            ...(/^[a-f0-9]{40}$/.test(sourceSha) ? { source_sha: sourceSha } : {}),
        };
    });

    app.post('/v1/version', {
        schema: {
            body: LegacyClientVersionCheckRequestSchema,
            response: {
                200: LegacyClientVersionCheckResponseSchema,
            }
        }
    }, async () => {
        return { update_required: false, update_url: null } as const;
    });
}
