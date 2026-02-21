import { z } from 'zod';
import { type Fastify } from '../../types';

import { featuresSchema } from '@/app/features/types';
import { resolveFeaturesFromEnv } from '@/app/features/registry';
import { resolveRouteRateLimit } from "@/app/api/utils/apiRateLimitPolicy";

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
                rateLimit: resolveRouteRateLimit(process.env, {
                    maxEnvKey: "HAPPIER_FEATURES_RATE_LIMIT_MAX",
                    windowEnvKey: "HAPPIER_FEATURES_RATE_LIMIT_WINDOW",
                    defaultMax: 120,
                    defaultWindow: "1 minute",
                }),
            },
        },
        async (_request, reply) => {
            return reply.send(resolveFeaturesFromEnv(process.env));
        }
    );
}
