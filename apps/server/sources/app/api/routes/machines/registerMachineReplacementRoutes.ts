import { applyMachineReplacement, clearMachineReplacement } from "@/app/machines/applyMachineReplacement";
import {
    enforceCurrentAccountStoredContentCompatibilityForHttpRequest,
    readAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { serializeMachineRow } from "@/app/machines/machineSerialization";
import { hasExactMachineReadiness } from "@/app/machines/machineSocketReadiness";
import { validateMachineReplacement } from "@/app/machines/validateMachineReplacement";
import { inTx } from "@/storage/inTx";
import { isPlainMachineDataKeyMarker } from "@happier-dev/protocol";
import { z } from "zod";
import type { Fastify } from "../../types";

export function registerMachineReplacementRoutes(app: Fastify): void {
    app.post('/v1/machines/:oldMachineId/replacement', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                oldMachineId: z.string(),
            }),
            body: z.object({
                replacementMachineId: z.string(),
                confirmActiveOldMachine: z.boolean().optional(),
            }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { oldMachineId } = request.params;
        const { replacementMachineId, confirmActiveOldMachine } = request.body;
        const supportsCurrentStoredContentProtocol =
            readAccountStoredContentCompatibilityForHttpRequest(request)
                .supportsCurrentProtocol;

        if (!(await hasExactMachineReadiness(userId, replacementMachineId))) {
            return reply.code(409).send({ error: "machine_not_ready", reason: "replacement_machine_not_connected" });
        }

        const result = await inTx(async (tx) => {
            const oldMachine = await tx.machine.findFirst({
                where: { accountId: userId, id: oldMachineId },
            });
            const replacementMachine = await tx.machine.findFirst({
                where: { accountId: userId, id: replacementMachineId },
            });
            if (
                isPlainMachineDataKeyMarker(oldMachine?.dataEncryptionKey)
                && !supportsCurrentStoredContentProtocol
            ) {
                return { kind: "upgrade_required" as const };
            }

            const validation = validateMachineReplacement({
                accountId: userId,
                oldMachine,
                replacementMachine,
                replacementMachineId,
                source: "manual",
                confirmActiveOldMachine,
            });
            if (!validation.ok) {
                return { kind: "error" as const, validation };
            }

            await applyMachineReplacement({
                tx,
                accountId: userId,
                oldMachineId,
                replacementMachineId,
                reason: "manual_repair",
                source: "manual",
                actorUserId: userId,
            });

            const updatedOldMachine = await tx.machine.findFirst({
                where: { accountId: userId, id: oldMachineId },
            });

            return { kind: "ok" as const, machine: updatedOldMachine };
        });

        if (result.kind === "error") {
            return reply.code(result.validation.statusCode).send({ error: "invalid-params", reason: result.validation.reason });
        }
        if (result.kind === "upgrade_required") {
            await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(request, reply);
            return;
        }
        if (!result.machine) {
            return reply.code(404).send({ error: "machine_not_found" });
        }

        return reply.send({ machine: serializeMachineRow(result.machine) });
    });

    app.delete('/v1/machines/:oldMachineId/replacement', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                oldMachineId: z.string(),
            }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { oldMachineId } = request.params;
        const supportsCurrentStoredContentProtocol =
            readAccountStoredContentCompatibilityForHttpRequest(request)
                .supportsCurrentProtocol;

        const result = await inTx(async (tx) => {
            const machine = await tx.machine.findFirst({
                where: { accountId: userId, id: oldMachineId },
            });
            if (!machine) {
                return { kind: "not_found" as const };
            }
            if (
                isPlainMachineDataKeyMarker(machine.dataEncryptionKey)
                && !supportsCurrentStoredContentProtocol
            ) {
                return { kind: "upgrade_required" as const };
            }

            await clearMachineReplacement({ tx, accountId: userId, oldMachineId });

            const updatedMachine = await tx.machine.findFirst({
                where: { accountId: userId, id: oldMachineId },
            });

            return { kind: "ok" as const, machine: updatedMachine };
        });

        if (result.kind === "upgrade_required") {
            await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(request, reply);
            return;
        }
        if (result.kind === "not_found" || !result.machine) {
            return reply.code(404).send({ error: "machine_not_found" });
        }

        return reply.send({ machine: serializeMachineRow(result.machine) });
    });
}
