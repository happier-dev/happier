import { z } from 'zod/mini';
import { SessionMessageReplyMachinePendingPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { isSessionMessageReplyMachineCurrentInTx, listSessionMessageRepliesPendingForMachineInTx, readSessionMessageRepliesInTx } from '@/app/session/messages/sessionMessageReply';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { inReadSnapshot } from '@/storage/inTx';
import type { Fastify } from '../../types';

/** A finite page over existing original custody, not transcript or a second delivery queue. */
export function registerMachineSessionMessageReplyRoutes(app: Fastify): void {
    app.get('/v2/machines/:machineId/session-message-replies/pending', {
        preHandler: app.authenticate,
        schema: { params: z.strictObject({ machineId: z.string().check(z.minLength(1)) }),
            querystring: z.strictObject({ afterSessionId: z.optional(z.string().check(z.minLength(1))),
                afterLocalId: z.optional(z.string().check(z.minLength(1))) }).check(z.refine(value =>
                    (value.afterSessionId === undefined) === (value.afterLocalId === undefined), 'Both cursor fields are required')),
            response: { 200: SessionMessageReplyMachinePendingPageV1Schema, 404: z.strictObject({ error: z.literal('Machine not found') }) } },
    }, async (request, reply) => {
        const params = { accountId: request.userId, machineId: request.params.machineId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
            ...(request.query.afterSessionId && request.query.afterLocalId ? {
                after: { sessionId: request.query.afterSessionId, localId: request.query.afterLocalId } } : {}) };
        const result = await inReadSnapshot(async tx => !await isSessionMessageReplyMachineCurrentInTx(tx, params) ? null
            : listSessionMessageRepliesPendingForMachineInTx(tx, params));
        if (!result || !await inReadSnapshot(tx => isSessionMessageReplyMachineCurrentInTx(tx, params))) {
            return reply.code(404).send({ error: 'Machine not found' });
        }
        const entries = await inReadSnapshot(async tx => {
            const current = await readSessionMessageRepliesInTx(tx, { ...params, recoveryMachineId: params.machineId,
                requests: result.entries.map(entry => ({ sessionId: entry.requestSessionId, localId: entry.requestLocalId })) });
            return result.entries.filter((_entry, index) => {
                const visible = current[index]!.reply;
                return visible.status === 'available' && visible.progress.disposition === 'return_pending';
            });
        });
        return reply.send({ ...result, entries });
    });
}
