import { z } from "zod";
import { type Fastify } from "../../types";
import {
    ClientVersionCheckRequestV1Schema,
    ClientVersionCheckResponseV1Schema,
} from '@happier-dev/protocol';

const LegacyClientVersionCheckRequestSchema = z.object({
    platform: z.string(),
    version: z.string(),
    app_id: z.string(),
}).strict();

const LegacyClientVersionCheckResponseSchema = z.object({
    update_required: z.boolean(),
    update_url: z.string().nullable(),
}).strict();

/**
 * Registers the client version endpoints: a `GET` reachability probe and a
 * `POST` upgrade check accepting both the v1 protocol body and the legacy
 * `{ platform, version, app_id }` shape still sent by deployed native builds.
 * This endpoint reports distribution update state only. Protocol capabilities
 * are negotiated independently through `/v1/features`.
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
            body: z.union([ClientVersionCheckRequestV1Schema, LegacyClientVersionCheckRequestSchema]),
            response: {
                200: z.union([ClientVersionCheckResponseV1Schema, LegacyClientVersionCheckResponseSchema]),
            }
        }
    }, async (request) => {
        if (!('v' in request.body)) {
            return { update_required: false, update_url: null } as const;
        }
        return { v: 1, status: 'current' } as const;
    });
}
