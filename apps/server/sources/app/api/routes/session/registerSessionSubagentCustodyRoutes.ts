import { z } from 'zod';

import {
    MAX_SESSION_SUBAGENT_CUSTODY_RECORDS,
    MAX_SESSION_SUBAGENT_CUSTODY_RECEIPTS,
    SESSION_SUBAGENT_CUSTODY_CAPABILITY_V1,
    SESSION_SUBAGENT_CUSTODY_RECEIPT_RETENTION_MS,
    SessionSubagentCustodyCapabilityV1Schema,
    SessionSubagentCustodyListQueryV1Schema,
    SessionSubagentCustodyMutationRequestV1Schema,
    SessionSubagentCustodyMutationResponseV1Schema,
    SessionSubagentCustodyPageV1Schema,
    SessionSubagentCustodyRetirementRequestV1Schema,
    SessionSubagentCustodyRetirementResponseV1Schema,
} from '@happier-dev/protocol';
import {
    listSessionSubagentCustody,
    mutateSessionSubagentCustody,
    retireSessionSubagentCustodyGeneration,
} from '@/app/session/subagents/sessionSubagentCustodyService';
import { checkSessionAccess } from '@/app/share/accessControl';
import type { Fastify } from '../../types';

const ParamsSchema = z.object({ sessionId: z.string().trim().min(1) }).strict();
const ErrorSchema = z.object({ error: z.string(), code: z.string().optional() }).strict();

function mutationErrorStatus(error: string): 400 | 404 | 409 | 500 {
    if (error === 'session-not-found') return 404;
    if (error === 'generation-retired' || error === 'idempotency-conflict' || error === 'capacity-exceeded' || error === 'cas-conflict' || error === 'terminal-regression') return 409;
    if (error === 'invalid-params') return 400;
    return 500;
}

export function registerSessionSubagentCustodyRoutes(app: Fastify) {
    app.get('/v2/sessions/:sessionId/subagents/custody/capability', {
        preHandler: app.authenticate,
        schema: {
            params: ParamsSchema,
            response: { 200: SessionSubagentCustodyCapabilityV1Schema, 404: ErrorSchema },
        },
    }, async (request, reply) => {
        if (!await checkSessionAccess(request.userId, request.params.sessionId)) {
            return reply.code(404).send({ error: 'Session not found' });
        }
        return reply.send({
            capability: SESSION_SUBAGENT_CUSTODY_CAPABILITY_V1,
            maxRecords: MAX_SESSION_SUBAGENT_CUSTODY_RECORDS,
            maxReceipts: MAX_SESSION_SUBAGENT_CUSTODY_RECEIPTS,
            receiptRetentionMs: SESSION_SUBAGENT_CUSTODY_RECEIPT_RETENTION_MS,
        });
    });

    app.get('/v2/sessions/:sessionId/subagents/custody', {
        preHandler: app.authenticate,
        schema: {
            params: ParamsSchema,
            querystring: SessionSubagentCustodyListQueryV1Schema,
            response: { 200: SessionSubagentCustodyPageV1Schema, 400: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 500: ErrorSchema },
        },
    }, async (request, reply) => {
        const parsed = SessionSubagentCustodyListQueryV1Schema.safeParse(request.query);
        if (!parsed.success) return reply.code(400).send({ error: 'Invalid parameters' });
        const result = await listSessionSubagentCustody({
            actorUserId: request.userId,
            sessionId: request.params.sessionId,
            query: parsed.data,
        });
        if (!result.ok) {
            const status = result.error === 'invalid-params' ? 400 : result.error === 'session-not-found' ? 404 : result.error === 'generation-retired' ? 409 : 500;
            return reply.code(status).send({ error: result.error });
        }
        return reply.send({ records: result.records });
    });

    app.post('/v2/sessions/:sessionId/subagents/custody/mutations', {
        preHandler: app.authenticate,
        schema: {
            params: ParamsSchema,
            body: SessionSubagentCustodyMutationRequestV1Schema,
            response: { 200: SessionSubagentCustodyMutationResponseV1Schema, 400: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 500: ErrorSchema },
        },
    }, async (request, reply) => {
        const parsed = SessionSubagentCustodyMutationRequestV1Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Invalid parameters' });
        const result = await mutateSessionSubagentCustody({
            actorUserId: request.userId,
            sessionId: request.params.sessionId,
            request: parsed.data,
        });
        if (!result.ok) {
            return reply.code(mutationErrorStatus(result.error)).send({ error: result.error, ...(result.code ? { code: result.code } : {}) });
        }
        return reply.send({ record: result.record, replayed: result.replayed });
    });

    app.post('/v2/session-subagents/custody/generation-retirements', {
        preHandler: app.authenticate,
        schema: {
            body: SessionSubagentCustodyRetirementRequestV1Schema,
            response: { 200: SessionSubagentCustodyRetirementResponseV1Schema, 400: ErrorSchema, 409: ErrorSchema, 500: ErrorSchema },
        },
    }, async (request, reply) => {
        const parsed = SessionSubagentCustodyRetirementRequestV1Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Invalid parameters' });
        const result = await retireSessionSubagentCustodyGeneration({
            actorUserId: request.userId,
            request: parsed.data,
        });
        if (!result.ok) {
            const status = result.error === 'invalid-params'
                ? 400
                : result.error === 'retirement-capacity-exceeded'
                        ? 409
                        : 500;
            return reply.code(status).send({ error: result.error });
        }
        return reply.send({ retired: true });
    });
}
