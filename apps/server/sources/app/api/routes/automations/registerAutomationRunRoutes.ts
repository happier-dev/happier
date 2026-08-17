import { z } from "zod";

import { type Fastify } from "../../types";
import {
    cancelAutomationRun,
    failAutomationRunFromV2,
    startAutomationRunFromV2,
    succeedAutomationRunFromV2,
} from "@/app/automations/automationRunService";
import { toAutomationRunV2ApiDto } from "@/app/automations/automationApiProjection";
import { resolveAutomationRunAttemptV2 } from "./automationRunAttemptV2Compatibility";

export function registerAutomationRunRoutes(app: Fastify): void {
    app.post('/v2/automations/runs/:runId/start', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ runId: z.string() }),
            body: z.object({
                machineId: z.string().trim().min(1),
                attempt: z.number().int().min(1).optional(),
            }),
        },
    }, async (request, reply) => {
        const run = await startAutomationRunFromV2({
            accountId: request.userId,
            runId: request.params.runId,
            machineId: request.body.machineId,
            attempt: resolveAutomationRunAttemptV2(request.body.attempt),
            expectedTriggerKind: "schedule",
        });
        if (!run) {
            return reply.code(404).send({ error: 'automation_run_not_found_or_not_claimed' });
        }
        return reply.send({ run: toAutomationRunV2ApiDto(run) });
    });

    app.post('/v2/automations/runs/:runId/succeed', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ runId: z.string() }),
            body: z.object({
                machineId: z.string().trim().min(1),
                attempt: z.number().int().min(1).optional(),
                producedSessionId: z.string().optional().nullable(),
                summaryCiphertext: z.string().optional().nullable(),
            }),
        },
    }, async (request, reply) => {
        const run = await succeedAutomationRunFromV2({
            accountId: request.userId,
            runId: request.params.runId,
            machineId: request.body.machineId,
            attempt: resolveAutomationRunAttemptV2(request.body.attempt),
            producedSessionId: request.body.producedSessionId,
            summaryCiphertext: request.body.summaryCiphertext,
            expectedTriggerKind: "schedule",
        });
        if (!run) {
            return reply.code(404).send({ error: 'automation_run_not_found_or_not_claimed' });
        }
        return reply.send({ run: toAutomationRunV2ApiDto(run) });
    });

    app.post('/v2/automations/runs/:runId/fail', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ runId: z.string() }),
            body: z.object({
                machineId: z.string().trim().min(1),
                attempt: z.number().int().min(1).optional(),
                producedSessionId: z.string().optional().nullable(),
                errorCode: z.string().optional().nullable(),
                errorMessage: z.string().optional().nullable(),
            }),
        },
    }, async (request, reply) => {
        const run = await failAutomationRunFromV2({
            accountId: request.userId,
            runId: request.params.runId,
            machineId: request.body.machineId,
            attempt: resolveAutomationRunAttemptV2(request.body.attempt),
            producedSessionId: request.body.producedSessionId,
            errorCode: request.body.errorCode,
            errorMessage: request.body.errorMessage,
            expectedTriggerKind: "schedule",
        });
        if (!run) {
            return reply.code(404).send({ error: 'automation_run_not_found_or_not_claimed' });
        }
        return reply.send({ run: toAutomationRunV2ApiDto(run) });
    });

    app.post('/v2/automations/runs/:runId/cancel', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ runId: z.string() }),
        },
    }, async (request, reply) => {
        const run = await cancelAutomationRun({
            accountId: request.userId,
            runId: request.params.runId,
            expectedTriggerKind: "schedule",
            requireV2RunRepresentability: true,
        });
        if (!run) {
            return reply.code(404).send({ error: 'automation_run_not_found' });
        }
        return reply.send({ run: toAutomationRunV2ApiDto(run) });
    });
}
