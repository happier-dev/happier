import { MachinePoolCreateInputV1Schema, MachinePoolDeleteInputV1Schema, MachinePoolDeleteOutputV1Schema, MachinePoolErrorV1Schema, MachinePoolGetInputV1Schema, MachinePoolListInputV1Schema, MachinePoolListOutputV1Schema, MachinePoolResolveInputV1Schema, MachinePoolResolveResultV1Schema, MachinePoolUpdateInputV1Schema, MachinePoolViewV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { z } from "zod/mini";

import { createServerFeatureGatePreHandler } from "@/app/features/catalog/serverFeatureGate";
import type { MachineDaemonPresenceSocketServer } from "@/app/machines/machineDaemonPresence";
import {
    createMachinePool,
    deleteMachinePool,
    getMachinePool,
    listMachinePools,
    resolveMachinePool,
    updateMachinePool,
} from "@/app/machines/pools/machinePoolService";
import type { Fastify } from "../../../types";
import { getMachinePoolMemberEligibility } from '@/app/machines/pools/machinePoolMemberAdmission';

function statusForError(code: string): 400 | 404 | 409 {
    if (code === "pool_not_found") return 404;
    if (code === "pool_changed") return 409;
    return 400;
}

export function registerMachinePoolRoutes(
    app: Fastify,
    deps: Readonly<{ io: MachineDaemonPresenceSocketServer }>,
): void {
    const preHandler = [app.authenticate, createServerFeatureGatePreHandler("machines.pools")];
    const errors = {
        400: MachinePoolErrorV1Schema,
        404: z.union([MachinePoolErrorV1Schema, z.strictObject({ error: z.literal("not_found") })]),
        409: MachinePoolErrorV1Schema,
    };

    app.post(machinePoolActionEndpointPathV1("machines.pools.list"), {
        preHandler,
        attachValidation: true,
        schema: { body: MachinePoolListInputV1Schema, response: { 200: MachinePoolListOutputV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return await reply.code(400).send({ code: "invalid_request", message: "Invalid Machine Pool request." });
        const [pools, memberEligibility] = await Promise.all([
            listMachinePools({ accountId: request.userId, io: deps.io }),
            request.body.memberMachineIds === undefined ? undefined : getMachinePoolMemberEligibility({
                accountId: request.userId, machineIds: request.body.memberMachineIds,
            }),
        ]);
        return await reply.send({ pools: [...pools], ...(memberEligibility === undefined ? {} : { memberEligibility: [...memberEligibility] }) });
    });

    app.post(machinePoolActionEndpointPathV1("machines.pools.get"), {
        preHandler,
        attachValidation: true,
        schema: { body: MachinePoolGetInputV1Schema, response: { 200: MachinePoolViewV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return await reply.code(400).send({ code: "invalid_request", message: "Invalid Machine Pool request." });
        const result = await getMachinePool({ accountId: request.userId, poolId: request.body.poolId, io: deps.io });
        return result.ok ? await reply.send(result.value) : await reply.code(statusForError(result.error.code)).send(result.error);
    });

    app.post(machinePoolActionEndpointPathV1("machines.pools.create"), {
        preHandler,
        attachValidation: true,
        schema: { body: MachinePoolCreateInputV1Schema, response: { 200: MachinePoolViewV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return await reply.code(400).send({ code: "invalid_request", message: "Invalid Machine Pool request." });
        const result = await createMachinePool({ accountId: request.userId, input: request.body, io: deps.io });
        return result.ok ? await reply.send(result.value) : await reply.code(statusForError(result.error.code)).send(result.error);
    });

    app.post(machinePoolActionEndpointPathV1("machines.pools.update"), {
        preHandler,
        attachValidation: true,
        schema: { body: MachinePoolUpdateInputV1Schema, response: { 200: MachinePoolViewV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return await reply.code(400).send({ code: "invalid_request", message: "Invalid Machine Pool request." });
        const result = await updateMachinePool({ accountId: request.userId, input: request.body, io: deps.io });
        return result.ok ? await reply.send(result.value) : await reply.code(statusForError(result.error.code)).send(result.error);
    });

    app.post(machinePoolActionEndpointPathV1("machines.pools.delete"), {
        preHandler,
        attachValidation: true,
        schema: { body: MachinePoolDeleteInputV1Schema, response: { 200: MachinePoolDeleteOutputV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return await reply.code(400).send({ code: "invalid_request", message: "Invalid Machine Pool request." });
        const result = await deleteMachinePool({ accountId: request.userId, input: request.body, io: deps.io });
        return result.ok ? await reply.send(result.value) : await reply.code(statusForError(result.error.code)).send(result.error);
    });

    app.post(machinePoolActionEndpointPathV1("machines.pools.resolve"), {
        preHandler,
        attachValidation: true,
        schema: { body: MachinePoolResolveInputV1Schema, response: { 200: MachinePoolResolveResultV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return await reply.code(400).send({ code: "invalid_request", message: "Invalid Machine Pool request." });
        const result = await resolveMachinePool({ accountId: request.userId, input: request.body, io: deps.io });
        return result.ok ? await reply.send(result.value) : await reply.code(statusForError(result.error.code)).send(result.error);
    });
}
