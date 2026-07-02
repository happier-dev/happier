import { type Fastify } from '../../types';

import { featuresSchema } from '@/app/features/types';
import { resolveFeaturesFromEnv } from '@/app/features/registry';
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import {
    applyPublicSignupProvisioningRestrictionsToFeaturesPayload,
} from "@/app/integrations/publicUrl/publicSignupProvisioningPolicy";
import { readCachedServerIdentityIdForHotPath } from "@/app/serverIdentity/serverIdentity";

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
            const serverIdentityId = readCachedServerIdentityIdForHotPath(process.env);
            reply.header("Cache-Control", "no-store");
            return reply.send(applyPublicSignupProvisioningRestrictionsToFeaturesPayload({
                payload: {
                    ...payload,
                    capabilities: {
                        ...payload.capabilities,
                        serverIdentity: { serverIdentityId },
                    },
                },
                env: process.env,
                requestIp: request.ip,
            }));
        }
    );
}
