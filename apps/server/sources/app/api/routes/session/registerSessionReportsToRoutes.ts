import { z } from 'zod';
import { SessionReportsToSetRequestV1Schema, SessionReportsToSetResultV1Schema,
    SessionReportsToOptionsRequestV1Schema, SessionReportsToOptionsV1Schema } from '@happier-dev/protocol';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { setSessionReportsTo, readSessionReportsToOptions } from '@/app/session/relations/sessionReportsToService';
import type { Fastify } from '../../types';

const paramsSchema = z.object({ sessionId: z.string().min(1) }).strict();

/** The resource and every Action delegate authority/CAS/cycles to one transactional owner. */
export function registerSessionReportsToRoutes(app: Fastify): void {
    app.post('/v1/sessions/:sessionId/reports-to/options', {
        preHandler: app.authenticate,
        schema: { params: paramsSchema, body: SessionReportsToOptionsRequestV1Schema,
            response: { 200: SessionReportsToOptionsV1Schema } },
    }, async (request) => readSessionReportsToOptions({
        accountId: request.userId, sessionId: request.params.sessionId,
        ...request.body, authentication: readSessionAccessAuthenticationFromRequest(request),
    }));
    app.post('/v1/sessions/:sessionId/reports-to', {
        preHandler: app.authenticate,
        schema: {
            params: paramsSchema,
            body: SessionReportsToSetRequestV1Schema,
            response: { 200: SessionReportsToSetResultV1Schema, 400: SessionReportsToSetResultV1Schema,
                403: SessionReportsToSetResultV1Schema, 409: SessionReportsToSetResultV1Schema },
        },
    }, async (request, reply) => {
        const result = await setSessionReportsTo({
            accountId: request.userId, sessionId: request.params.sessionId,
            ...request.body, authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        const status = result.ok ? 200 : result.error === 'reports_to_cas_conflict' ? 409 : result.error === 'reports_to_cycle' ? 400 : 403;
        return reply.code(status).send(result);
    });
}
