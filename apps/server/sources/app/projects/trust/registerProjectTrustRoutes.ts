import {
    PROJECT_TRUST_ROUTE_V1, ProjectTrustReadRequestV1Schema, ProjectTrustReadResponseV1Schema,
    ProjectTrustListRequestV1Schema, ProjectTrustListResponseV1Schema, ProjectTrustMutationRequestV1Schema,
    ProjectTrustMutationResponseV1Schema, ProjectTrustStorageUnavailableV1Schema,
} from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { z } from 'zod';

import type { Fastify } from '@/app/api/types';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { asServerProtocolZod } from '@/app/api/utils/protocolComposableZodAdapter';
import { PresentUserRequiredResponseSchema, requirePresentUser } from '@/app/api/utils/requirePresentUser';
import { listProjectTrust, mutateProjectTrust, readProjectTrust } from './projectTrustRowService';

const errors = { 400: z.object({ error: z.literal('invalid-params') }).strict(),
    503: asServerProtocolZod(ProjectTrustStorageUnavailableV1Schema), 500: z.object({ error: z.literal('internal') }).strict() };
const rateLimit = () => ({ rateLimit: resolveApiHotEndpointRateLimit(process.env, 'account.settings') });
const unavailable = (reason: 'account-not-found' | 'account-inconsistent' | 'account-mode-mismatch' | 'invalid-stored-content') => ({ error: 'project_trust_storage_unavailable' as const, reason });

/** Authenticated requester Account owns consent, including shared Projects. No grant Action or automatic decision lives here. */
export function registerProjectTrustRoutes(app: Fastify): void {
    app.post(`${PROJECT_TRUST_ROUTE_V1}/read`, { preHandler: app.authenticate, config: rateLimit(),
        schema: { body: asServerProtocolZod(ProjectTrustReadRequestV1Schema), response: { ...errors, 200: asServerProtocolZod(ProjectTrustReadResponseV1Schema) } },
    }, async (request, reply) => {
        try {
            const result = await readProjectTrust({ accountId: request.userId, project: request.body.project });
            if (result.status === 'present') return reply.send({ status: result.status, revision: result.revision, content: result.envelope });
            if (result.status === 'absent' || result.status === 'deleted') return reply.send(result);
            return reply.code(503).send(unavailable(result.status));
        } catch { return reply.code(500).send({ error: 'internal' }); }
    });
    app.post(`${PROJECT_TRUST_ROUTE_V1}/list`, { preHandler: app.authenticate, config: rateLimit(),
        schema: { body: asServerProtocolZod(ProjectTrustListRequestV1Schema), response: { ...errors, 200: asServerProtocolZod(ProjectTrustListResponseV1Schema) } },
    }, async (request, reply) => {
        try {
            const result = await listProjectTrust({ accountId: request.userId, project: request.body.project });
            return result.status === 'listed' ? reply.send({ rows: [...result.rows] }) : reply.code(503).send(unavailable(result.status));
        } catch { return reply.code(500).send({ error: 'internal' }); }
    });
    app.post(`${PROJECT_TRUST_ROUTE_V1}/mutate`, { preHandler: [app.authenticate, async (request, reply) => {
        // A grant is a human decision; revocation remains the ordinary Account mutation port.
        if (request.body.content !== null) return requirePresentUser(request, reply);
    }], config: rateLimit(),
        schema: { body: asServerProtocolZod(ProjectTrustMutationRequestV1Schema), response: { ...errors, 403: PresentUserRequiredResponseSchema, 200: asServerProtocolZod(ProjectTrustMutationResponseV1Schema) } },
    }, async (request, reply) => {
        try {
            const result = await mutateProjectTrust({ accountId: request.userId, ...request.body });
            return result.status === 'updated' || result.status === 'conflict' ? reply.send(result) : reply.code(503).send(unavailable(result.status));
        } catch { return reply.code(500).send({ error: 'internal' }); }
    });
}
