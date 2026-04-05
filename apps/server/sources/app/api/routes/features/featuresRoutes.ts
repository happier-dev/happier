import { type Fastify } from '../../types';

import { resolveFeaturesFromEnv } from '@/app/features/registry';
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { buildLegacyCompatibleFeaturesResponse } from "./buildLegacyCompatibleFeaturesResponse";

export function featuresRoutes(app: Fastify) {
    app.get(
        '/v1/features',
        {
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "features"),
            },
        },
        async (_request, reply) => {
            const payload = resolveFeaturesFromEnv(process.env);
            return reply.send(buildLegacyCompatibleFeaturesResponse(payload));
        }
    );
}
