import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { TaskResourcesListQueryV1Schema, TaskResourceSelectionV1Schema, type TaskResourceSelectionV1 } from '@happier-dev/protocol/actions/internalTaskActions';
import { TaskResourceAddressV1Schema, TaskResourceV1Schema, TaskResourcesListResponseV1Schema,
    TaskResourceMutateRequestV1Schema, TaskAccessGrantSetRequestV1Schema, TaskAccessGrantRemoveRequestV1Schema,
    TaskAccessGrantsListResponseV1Schema, TaskAccessGrantMutationResponseV1Schema,
    TaskAccessRecipientCensusRequestV1Schema, TaskAccessRecipientCensusResponseV1Schema,
    TaskRecipientKeyEnvelopeCommitInputV1Schema, TaskRecipientKeyEnvelopeCommitResponseV1Schema,
    TaskResourceErrorResponseV1Schema, type TaskResourceErrorV1 } from '@happier-dev/protocol/actions/internalTaskActions';
import type { Fastify } from '@/app/api/types';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { readTaskResource, listTaskResources, mutateTaskResource, type TaskResult } from '@/app/todos/taskResourceService';
import { listTaskGrants, setTaskGrant, removeTaskGrant, readTaskRecipientCensus,
    commitTaskRecipientKeyEnvelopes } from '@/app/todos/taskAccessService';

function failureStatus(error: TaskResourceErrorV1): 400 | 403 | 404 | 409 {
    if (error === 'task_not_found') return 404;
    if (error === 'task_access_forbidden') return 403;
    if (error === 'task_version_conflict' || error === 'task_content_unavailable'
        || error === 'task_data_key_changed') return 409;
    return 400;
}
function sendResult(reply: FastifyReply, result: TaskResult<unknown>) {
    return result.ok ? reply.send(result.value) : reply.code(failureStatus(result.error)).send({ error: result.error });
}
function taskRouteErrorHandler(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
    return error.validation ? reply.code(400).send({ error: 'task_invalid_content' }) : reply.send(error);
}
const failures = { 400: TaskResourceErrorResponseV1Schema, 403: TaskResourceErrorResponseV1Schema,
    404: TaskResourceErrorResponseV1Schema, 409: TaskResourceErrorResponseV1Schema };
const taskPath = '/v1/tasks/:ownerAccountId/:taskId';

/** Account credentials locate tasks by owner; only the resource service decides grants, mode and key readiness. */
export function taskRoutes(app: Fastify): void {
    const options = { preHandler: app.authenticate, errorHandler: taskRouteErrorHandler };
    app.get('/v1/tasks', { ...options,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'kv.list') },
        schema: { querystring: TaskResourcesListQueryV1Schema, response: { 200: TaskResourcesListResponseV1Schema, ...failures } },
    }, async (request, reply) => {
        let selection: TaskResourceSelectionV1 | undefined;
        if (request.query.selection !== undefined) {
            try {
                const parsed = TaskResourceSelectionV1Schema.safeParse(JSON.parse(request.query.selection));
                if (!parsed.success) return reply.code(400).send({ error: 'task_invalid_content' });
                selection = parsed.data;
            } catch { return reply.code(400).send({ error: 'task_invalid_content' }); }
        }
        return sendResult(reply, await listTaskResources(request.userId, selection));
    });
    app.get(taskPath, { ...options,
        schema: { params: TaskResourceAddressV1Schema, response: { 200: TaskResourceV1Schema, ...failures } },
    }, async (request, reply) => sendResult(reply, await readTaskResource({ actorAccountId: request.userId, ...request.params })));
    app.put(taskPath, { ...options,
        schema: { params: TaskResourceAddressV1Schema, body: TaskResourceMutateRequestV1Schema,
            response: { 200: TaskResourceV1Schema, ...failures } },
    }, async (request, reply) => sendResult(reply, await mutateTaskResource({ actorAccountId: request.userId, ...request.params, request: request.body })));
    app.get(`${taskPath}/grants`, { ...options,
        schema: { params: TaskResourceAddressV1Schema, response: { 200: TaskAccessGrantsListResponseV1Schema, ...failures } },
    }, async (request, reply) => sendResult(reply, await listTaskGrants({ actorAccountId: request.userId, ...request.params })));
    app.put(`${taskPath}/grants`, { ...options,
        schema: { params: TaskResourceAddressV1Schema, body: TaskAccessGrantSetRequestV1Schema,
            response: { 200: TaskAccessGrantMutationResponseV1Schema, ...failures } },
    }, async (request, reply) => sendResult(reply, await setTaskGrant({ actorAccountId: request.userId, ...request.params, request: request.body })));
    app.delete(`${taskPath}/grants`, { ...options,
        schema: { params: TaskResourceAddressV1Schema, body: TaskAccessGrantRemoveRequestV1Schema,
            response: { 200: TaskAccessGrantMutationResponseV1Schema, ...failures } },
    }, async (request, reply) => sendResult(reply, await removeTaskGrant({ actorAccountId: request.userId, ...request.params, request: request.body })));
    app.post(`${taskPath}/recipients/census`, { ...options,
        schema: { params: TaskResourceAddressV1Schema, body: TaskAccessRecipientCensusRequestV1Schema,
            response: { 200: TaskAccessRecipientCensusResponseV1Schema, ...failures } },
    }, async (request, reply) => sendResult(reply, await readTaskRecipientCensus({ actorAccountId: request.userId, ...request.params, ...request.body })));
    app.post(`${taskPath}/recipients/commit`, { ...options,
        schema: { params: TaskResourceAddressV1Schema, body: TaskRecipientKeyEnvelopeCommitInputV1Schema,
            response: { 200: TaskRecipientKeyEnvelopeCommitResponseV1Schema, ...failures } },
    }, async (request, reply) => sendResult(reply, await commitTaskRecipientKeyEnvelopes({ actorAccountId: request.userId, ...request.params, request: request.body })));
}
