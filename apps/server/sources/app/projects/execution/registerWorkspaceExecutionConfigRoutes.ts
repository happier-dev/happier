import type { Fastify } from '@/app/api/types';
import { z } from 'zod';
import {
    WORKSPACE_EXECUTION_CONFIG_ROUTE_V1,
    WorkspaceExecutionConfigReadRequestV1Schema,
    WorkspaceExecutionConfigReadResponseV1Schema,
    WorkspaceExecutionConfigMutationRequestV1Schema,
    WorkspaceExecutionConfigMutationResponseV1Schema,
    WorkspaceExecutionConfigListResponseV1Schema,
    WorkspaceExecutionConfigStorageUnavailableV1Schema,
} from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { asServerProtocolZod } from '@/app/api/utils/protocolComposableZodAdapter';
import { inTx } from '@/storage/inTx';
import { listWorkspaceExecutionConfigRowsInTx, mutateWorkspaceExecutionConfigRowInTx, readWorkspaceExecutionConfigRowInTx } from './workspaceExecutionConfigRowService';

const failureResponses = {
    400: z.object({ error: z.literal('invalid-params') }).strict(),
    503: asServerProtocolZod(WorkspaceExecutionConfigStorageUnavailableV1Schema),
};
const unavailable = { error: 'workspace_execution_config_storage_unavailable' as const };

/** Authenticated Account scope owns private row transport; semantic merge stays client-side. */
export function registerWorkspaceExecutionConfigRoutes(app: Fastify): void {
    app.post(`${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`, {
        preHandler: app.authenticate,
        schema: { body: asServerProtocolZod(WorkspaceExecutionConfigReadRequestV1Schema), response: { 200: asServerProtocolZod(WorkspaceExecutionConfigReadResponseV1Schema), ...failureResponses } },
    }, async (request, reply) => {
        const result = await inTx(tx => readWorkspaceExecutionConfigRowInTx(tx, { accountId: request.userId, address: request.body.address }), { readOnly: true });
        if (result.status === 'absent' || result.status === 'deleted') return reply.send(result);
        if (result.status !== 'present') return reply.code(503).send(unavailable);
        return reply.send({ status: 'present', revision: result.revision, content: result.envelope });
    });
    app.post(`${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/mutate`, {
        preHandler: app.authenticate,
        schema: { body: asServerProtocolZod(WorkspaceExecutionConfigMutationRequestV1Schema), response: { 200: asServerProtocolZod(WorkspaceExecutionConfigMutationResponseV1Schema), ...failureResponses } },
    }, async (request, reply) => {
        const result = await inTx(tx => mutateWorkspaceExecutionConfigRowInTx(tx, { accountId: request.userId, ...request.body }));
        if (result.status === 'updated' || result.status === 'conflict') return reply.send(result);
        return reply.code(503).send(unavailable);
    });
    app.get(WORKSPACE_EXECUTION_CONFIG_ROUTE_V1, {
        preHandler: app.authenticate,
        schema: { response: { 200: asServerProtocolZod(WorkspaceExecutionConfigListResponseV1Schema), ...failureResponses } },
    }, async (request, reply) => {
        const result = await inTx(tx => listWorkspaceExecutionConfigRowsInTx(tx, { accountId: request.userId }), { readOnly: true });
        return result.status === 'listed' ? reply.send({ rows: [...result.rows] }) : reply.code(503).send(unavailable);
    });
}
