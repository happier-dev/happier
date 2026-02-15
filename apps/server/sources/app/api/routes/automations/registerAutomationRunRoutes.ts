import { z } from "zod";

import { type Fastify } from "../../types";
import {
    cancelAutomationRun,
    failAutomationRun,
    startAutomationRun,
    succeedAutomationRun,
} from "@/app/automations/automationRunService";
import { toAutomationRunApiDto } from "@/app/automations/automationTypes";

export function registerAutomationRunRoutes(app: Fastify): void {
    app.post('/v2/automations/runs/:runId/start', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ runId: z.string() }),
            body: z.object({ machineId: z.string().trim().min(1) }),
        },
    }, async (request, reply) => {
        const run = await startAutomationRun({
            accountId: request.userId,
            runId: request.params.runId,
            machineId: request.body.machineId,
        });
        if (!run) {
            return reply.code(404).send({ error: 'automation_run_not_found_or_not_claimed' });
        }
        return reply.send({ run: toAutomationRunApiDto(run) });
    });

    app.post('/v2/automations/runs/:runId/succeed', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ runId: z.string() }),
            body: z.object({
                machineId: z.string().trim().min(1),
                producedSessionId: z.string().optional().nullable(),
                summaryCiphertext: z.string().optional().nullable(),
            }),
        },
    }, async (request, reply) => {
        const run = await succeedAutomationRun({
            accountId: request.userId,
            runId: request.params.runId,
            machineId: request.body.machineId,
            producedSessionId: request.body.producedSessionId,
            summaryCiphertext: request.body.summaryCiphertext,
        });
        if (!run) {
            return reply.code(404).send({ error: 'automation_run_not_found_or_not_claimed' });
        }
        return reply.send({ run: toAutomationRunApiDto(run) });
    });

    app.post('/v2/automations/runs/:runId/fail', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ runId: z.string() }),
            body: z.object({
                machineId: z.string().trim().min(1),
                errorCode: z.string().optional().nullable(),
                errorMessage: z.string().optional().nullable(),
            }),
        },
    }, async (request, reply) => {
        const run = await failAutomationRun({
            accountId: request.userId,
            runId: request.params.runId,
            machineId: request.body.machineId,
            errorCode: request.body.errorCode,
            errorMessage: request.body.errorMessage,
        });
        if (!run) {
            return reply.code(404).send({ error: 'automation_run_not_found_or_not_claimed' });
        }
        return reply.send({ run: toAutomationRunApiDto(run) });
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
        });
        if (!run) {
            return reply.code(404).send({ error: 'automation_run_not_found' });
        }
        return reply.send({ run: toAutomationRunApiDto(run) });
    });
}
