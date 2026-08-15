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
                response: {
                    200: featuresSchema,
                },
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "features"),
            },
        },
        async (_request, reply) => {
            const payload = resolveFeaturesFromEnv(process.env);
            const serverIdentityId = readCachedServerIdentityIdForHotPath(process.env);
            return reply.send({
                ...payload,
                capabilities: {
                    ...payload.capabilities,
                    serverIdentity: { serverIdentityId },
                },
            });
        }
    );
}
