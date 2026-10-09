import {
    MachinePresetActionInputSchemasV1, MachinePresetActionOutputSchemasV1,
    machinePresetActionEndpointPathV1, type MachinePresetActionIdV1,
} from "@happier-dev/protocol";
import type { z } from "zod";

import type { Fastify } from "../../../types";
import { readTeamOperationAuthenticationFromRequest, type TeamOperationAuthenticationContext } from "@/app/teams/actorContext";
import {
    createMachinePreset, getMachinePreset, listMachinePresets, updateMachinePreset,
    archiveMachinePreset, restoreMachinePreset,
} from "@/app/machines/managed/machinePresetService";

function register<Id extends MachinePresetActionIdV1>(
    app: Fastify, id: Id,
    execute: (params: Readonly<{
        accountId: string; authentication: TeamOperationAuthenticationContext;
        input: z.infer<(typeof MachinePresetActionInputSchemasV1)[Id]>;
    }>) => Promise<z.infer<(typeof MachinePresetActionOutputSchemasV1)[Id]>>,
): void {
    const output = MachinePresetActionOutputSchemasV1[id];
    app.post<{ Body: z.infer<(typeof MachinePresetActionInputSchemasV1)[Id]> }>(machinePresetActionEndpointPathV1(id), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: MachinePresetActionInputSchemasV1[id],
            response: { 200: output, 400: output, 403: output, 404: output, 409: output },
        },
    }, async (request, reply) => {
        if (request.validationError) return await reply.code(400).send({ kind: "refused", code: "invalid_request" });
        // Fastify validated this body with the id-specific schema above; its generic Body inference widens indexed schemas to unknown.
        const input = request.body as z.infer<(typeof MachinePresetActionInputSchemasV1)[Id]>;
        const result = await execute({ accountId: request.userId, authentication: readTeamOperationAuthenticationFromRequest(request), input });
        const status = result.kind === "conflict" ? 409
            : result.kind !== "refused" ? 200
            : result.code === "preset_not_found" ? 404
            : result.code === "permission_denied" ? 403 : 400;
        return await reply.code(status).send(result);
    });
}

/** One authenticated Machine registrar carries all preset Action transports. */
export function registerMachinePresetRoutes(app: Fastify): void {
    register(app, "machines.presets.list", listMachinePresets);
    register(app, "machines.presets.get", getMachinePreset);
    register(app, "machines.presets.create", createMachinePreset);
    register(app, "machines.presets.update", updateMachinePreset);
    register(app, "machines.presets.archive", archiveMachinePreset);
    register(app, "machines.presets.restore", restoreMachinePreset);
}
