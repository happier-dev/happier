import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import { registerArtifactSignedInLinkRoutes } from './registerArtifactSignedInLinkRoutes';

describe('signed-in link authentication', () => {
    it('refuses logged-out management and reads before accessing content', async () => {
        // Exercise unauthenticated HTTP admission without the Account/database fixture graph.
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        app.decorate('authenticate', async (_request: FastifyRequest, reply: FastifyReply) => reply.code(401).send({ error: 'Unauthorized' }));
        registerArtifactSignedInLinkRoutes(app);
        await app.ready();
        try {
            for (const request of [
                { method: 'POST' as const, url: '/v1/artifact-signed-in-links', payload: { artifactId: 'artifact', lookupId: 'lookup' } },
                { method: 'GET' as const, url: '/v1/artifact-signed-in-links/lookup/join' },
                { method: 'POST' as const, url: '/v1/artifact-signed-in-links/lookup/join', payload: {} },
                { method: 'GET' as const, url: '/v1/artifact-signed-in-links?artifactId=artifact' },
                { method: 'DELETE' as const, url: '/v1/artifact-signed-in-links/artifact' },
            ]) expect((await app.inject(request)).statusCode).toBe(401);
        } finally { await app.close(); }
    });
});
