import { z } from 'zod';
import {
    MachineAccessGrantSetInputV1Schema,
    MachineAccessGrantRemoveInputV1Schema,
    MachineAccessGrantsListResultV1Schema,
    MachineAccessMutationResultV1Schema,
    MachineAccessRecipientCensusResponseV1Schema,
    MachineAccessRefusalV1Schema,
    MachineRecipientKeyEnvelopeCommitInputV1Schema,
    MachineRecipientKeyEnvelopeCommitResponseV1Schema,
    MachineRecipientKeyEnvelopePageQueryV1Schema,
} from '@happier-dev/protocol';
import {
    commitMachineRecipientKeyEnvelopesInTx,
    listMachineAccessGrantsInTx,
    readMachineRecipientCensusInTx,
    removeMachineAccessGrantInTx,
    setMachineAccessGrantInTx,
} from '@/app/machines/machineAccess';
import { inTx } from '@/storage/inTx';
import type { Fastify } from '../../types';

const params = z.object({ id: z.string().min(1) }).strict();
const setBody = MachineAccessGrantSetInputV1Schema.omit({ serverId: true, machineId: true });
const removeBody = z.union([
    MachineAccessGrantRemoveInputV1Schema.omit({ serverId: true, machineId: true }),
    z.object({}).strict(),
]);

/** Strict HTTP adapters; the Machine owner decides membership, readiness and mutation effects. */
export function registerMachineAccessRoutes(app: Fastify) {
    app.get('/v1/machines/:id/access', {
        preHandler: app.authenticate,
        schema: { params, response: { 200: MachineAccessGrantsListResultV1Schema } },
    }, async (request) => inTx((tx) => listMachineAccessGrantsInTx(tx, {
        actorAccountId: request.userId, machineId: request.params.id,
    })));

    app.put('/v1/machines/:id/access', {
        preHandler: app.authenticate,
        schema: { params, body: setBody, response: { 200: MachineAccessMutationResultV1Schema } },
    }, async (request) => inTx((tx) => setMachineAccessGrantInTx(tx, {
        actorAccountId: request.userId, machineId: request.params.id, ...request.body,
    })));

    app.delete('/v1/machines/:id/access', {
        preHandler: app.authenticate,
        schema: { params, body: removeBody, response: { 200: MachineAccessMutationResultV1Schema } },
    }, async (request) => inTx((tx) => removeMachineAccessGrantInTx(tx, {
        actorAccountId: request.userId,
        machineId: request.params.id,
        ...('principal' in request.body
            ? { principal: request.body.principal }
            : { principal: { kind: 'account' as const, accountId: request.userId }, leave: true as const }),
    })));

    app.get('/v1/machines/:id/data-key-envelopes', {
        preHandler: app.authenticate,
        schema: {
            params,
            querystring: MachineRecipientKeyEnvelopePageQueryV1Schema,
            response: { 200: z.union([MachineAccessRecipientCensusResponseV1Schema, MachineAccessRefusalV1Schema]) },
        },
    }, async (request) => inTx((tx) => readMachineRecipientCensusInTx(tx, {
        actorAccountId: request.userId, machineId: request.params.id, query: request.query,
    })));

    app.patch('/v1/machines/:id/data-key-envelopes', {
        preHandler: app.authenticate,
        schema: {
            params,
            body: MachineRecipientKeyEnvelopeCommitInputV1Schema.omit({ machineId: true }),
            response: { 200: z.union([MachineRecipientKeyEnvelopeCommitResponseV1Schema, MachineAccessRefusalV1Schema]) },
        },
    }, async (request) => inTx((tx) => commitMachineRecipientKeyEnvelopesInTx(tx, {
        actorAccountId: request.userId, machineId: request.params.id, ...request.body,
    })));
}
