import { z } from 'zod';
import { ServerRetentionPolicyV2Schema } from '@happier-dev/protocol';
import { type Fastify } from '../../types';

import { featuresSchema } from '@/app/features/types';
import { resolveFeaturesFromEnv } from '@/app/features/registry';
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { readCachedServerIdentityIdForHotPath } from "@/app/serverIdentity/serverIdentity";
import { readRetentionPolicyFromEnv } from '@/app/retention/config/readRetentionPolicyFromEnv';
import { retentionPolicyToPublicPolicy } from '@/app/retention/config/retentionPolicyToPublicPolicy';

export function featuresRoutes(app: Fastify) {
    app.get(
        '/v2/retention-policy',
        {
            schema: {
                response: {
                    200: ServerRetentionPolicyV2Schema,
                },
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, 'features'),
            },
        },
        async (_request, reply) => reply.send(
            retentionPolicyToPublicPolicy(readRetentionPolicyFromEnv(process.env)),
        ),
    );

    app.get(
        '/v1/features',
        {
            schema: {
                querystring: z.object({ retentionNotice: z.string().optional() }).optional(),
                response: {
                    200: featuresSchema,
                },
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "features"),
            },
        },
        async (request, reply) => {
            const payload = resolveFeaturesFromEnv(process.env);
            const server = payload.capabilities.server;
            let retention = server.retention;
            // Released readers validate this nested object strictly. The existing request can
            // opt into the additive notice fields without a second read.
            if (retention && request.query?.retentionNotice !== '1') {
                const { startsAt: _startsAt, noticeDays: _noticeDays, ...legacy } = retention;
                retention = legacy;
            }
            const serverIdentityId = readCachedServerIdentityIdForHotPath(process.env);
            return reply.send({
                ...payload,
                capabilities: {
                    ...payload.capabilities,
                    server: { ...server, retention },
                    serverIdentity: { serverIdentityId },
                },
            });
        }
    );
}
