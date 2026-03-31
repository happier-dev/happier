import { type Fastify } from '../../types';

import { featuresSchema } from '@/app/features/types';
import { resolveFeaturesFromEnv } from '@/app/features/registry';
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import {
    applyPublicSignupProvisioningRestrictionsToFeaturesPayload,
} from "@/app/integrations/publicUrl/publicSignupProvisioningPolicy";

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
        async (request, reply) => {
            const payload = resolveFeaturesFromEnv(process.env);
            reply.header("Cache-Control", "no-store");
            return reply.send(applyPublicSignupProvisioningRestrictionsToFeaturesPayload({
                payload,
                env: process.env,
                requestIp: request.ip,
            }));
        }
    );
}
