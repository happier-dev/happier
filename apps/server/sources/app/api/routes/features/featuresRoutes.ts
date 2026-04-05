import { z } from 'zod';
import { type Fastify } from '../../types';

import { featuresSchema } from '@/app/features/types';
import { resolveFeaturesFromEnv } from '@/app/features/registry';
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";

export function featuresRoutes(app: Fastify) {
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
            return reply.send(resolveFeaturesFromEnv(process.env));
        }
    );
}
