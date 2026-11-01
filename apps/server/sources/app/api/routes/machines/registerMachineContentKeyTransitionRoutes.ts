import { z } from 'zod';
import { MachineContentKeyTransitionInputV1Schema } from '@happier-dev/protocol';
import type { Fastify } from '../../types';
import { transitionMachineContentKey } from '@/app/machines/transitionMachineContentKey';
import { createServerFeatureGatePreHandler } from '@/app/features/catalog/serverFeatureGate';

export function registerMachineContentKeyTransitionRoutes(app: Fastify): void {
    app.post('/v1/machines/:id/content-key/transition', {
        preHandler: [app.authenticate, createServerFeatureGatePreHandler('encryption.plaintextMachine')],
        schema: {
            params: z.object({ id: z.string().min(1) }),
            body: MachineContentKeyTransitionInputV1Schema,
        },
    }, async (request, reply) => {
        if (request.params.id !== request.body.machineId) {
            return reply.code(400).send({ error: 'invalid-params', reason: 'machine_id_mismatch' });
        }
        return transitionMachineContentKey(request.userId, request.body);
    });
}
