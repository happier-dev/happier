import { z } from 'zod';
import { type Fastify } from '../types';

import { featuresSchema } from '@/app/features/types';
import { resolveFeaturesFromEnv } from '@/app/features/registry';

export function featuresRoutes(app: Fastify) {
    app.get(
        '/v1/features',
        {
            schema: {
                response: {
                    200: featuresSchema,
                },
            },
        },
        async (_request, reply) => {
            return reply.send(resolveFeaturesFromEnv(process.env));
        }
    );
}
