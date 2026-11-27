import { createHash } from 'node:crypto';
import type { Fastify } from '@/app/api/types';
import {
    PROJECT_ACCOUNT_ROWS_ROUTE_V1,
    ProjectAccountRowInvalidParamsResponseV1Schema, ProjectAccountRowInternalErrorResponseV1Schema,
    ProjectAccountRowReadRequestV1Schema, ProjectAccountRowReadResponseV1Schema,
    ProjectAccountRowListRequestV1Schema, ProjectAccountRowListResponseV1Schema,
    ProjectAccountRowMutationRequestV1Schema, ProjectAccountRowMutationResponseV1Schema,
    ProjectAccountRowAuthoringSessionRequestV1Schema, ProjectAccountRowAuthoringSessionResponseV1Schema,
} from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { asServerProtocolZod } from '@/app/api/utils/protocolComposableZodAdapter';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { listProjectAccountRowsInTx, mutateProjectAccountRows, readProjectAccountRowInTx } from '@/app/projects/projectAccountRowService';
import { inReadSnapshot } from '@/storage/inTx';
import { recordProjectAccountRowAuthoringSession } from '@/app/projects/projectAccountRowAuthoringSession';

/** All private rows use the authenticated Account, never a caller-supplied owner. */
export function registerProjectAccountRowRoutes(app: Fastify): void {
    const config = { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'account.settings') };
    const errors = {
        400: asServerProtocolZod(ProjectAccountRowInvalidParamsResponseV1Schema),
        500: asServerProtocolZod(ProjectAccountRowInternalErrorResponseV1Schema),
    };
    app.post(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`, {
        preHandler: app.authenticate, config,
        schema: { body: asServerProtocolZod(ProjectAccountRowReadRequestV1Schema), response: { 200: asServerProtocolZod(ProjectAccountRowReadResponseV1Schema), ...errors } },
    }, async (request, reply) => {
        try { return reply.send(await inReadSnapshot(tx => readProjectAccountRowInTx(tx, { accountId: request.userId, ...request.body }))); }
        catch { return reply.code(500).send({ error: 'internal' }); }
    });
    app.post(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, {
        preHandler: app.authenticate, config,
        schema: { body: asServerProtocolZod(ProjectAccountRowListRequestV1Schema), response: { 200: asServerProtocolZod(ProjectAccountRowListResponseV1Schema), ...errors } },
    }, async (request, reply) => {
        try {
            const { validator, ...selection } = request.body;
            const result = await inReadSnapshot(tx => listProjectAccountRowsInTx(tx, { accountId: request.userId, ...selection }));
            if (result.status === 'listed') {
                const etag = `W/"project-rows-v1-${createHash('sha256').update(
                    JSON.stringify([request.userId, selection, result]),
                ).digest('hex')}"`;
                reply.header('ETag', etag).header('Cache-Control', 'private, no-store');
                if (validator === etag) return reply.code(204).send();
            }
            return reply.send(result);
        } catch { return reply.code(500).send({ error: 'internal' }); }
    });
    app.post(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`, {
        preHandler: app.authenticate, config,
        schema: { body: asServerProtocolZod(ProjectAccountRowMutationRequestV1Schema), response: { 200: asServerProtocolZod(ProjectAccountRowMutationResponseV1Schema), ...errors } },
    }, async (request, reply) => {
        try { return reply.send(await mutateProjectAccountRows({ accountId: request.userId, request: request.body })); }
        catch { return reply.code(500).send({ error: 'internal' }); }
    });
    app.post(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/authoring-session`, {
        preHandler: app.authenticate, config,
        schema: { body: asServerProtocolZod(ProjectAccountRowAuthoringSessionRequestV1Schema), response: { 200: asServerProtocolZod(ProjectAccountRowAuthoringSessionResponseV1Schema), ...errors } },
    }, async (request, reply) => {
        try { return reply.send(await recordProjectAccountRowAuthoringSession({ accountId: request.userId, request: request.body })); }
        catch { return reply.code(500).send({ error: 'internal' }); }
    });
}
