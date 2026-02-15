import { z } from "zod";

import { type Fastify } from "../../types";
import { claimAutomationRun, heartbeatAutomationRun } from "@/app/automations/automationClaimService";
import { listDaemonAssignments } from "@/app/automations/automationAssignmentService";
import { toAutomationRunApiDto } from "@/app/automations/automationTypes";

export function registerAutomationDaemonRoutes(app: Fastify): void {
    app.post('/v2/automations/runs/claim', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                machineId: z.string().trim().min(1),
                leaseDurationMs: z.number().int().min(5_000).max(15 * 60_000).optional(),
            }),
        },
    }, async (request) => {
        const result = await claimAutomationRun({
            accountId: request.userId,
            machineId: request.body.machineId,
            leaseDurationMs: request.body.leaseDurationMs ?? 30_000,
        });
        const runWithAutomation = result.run as (typeof result.run & { automation?: any }) | null;

        return {
            run: result.run ? toAutomationRunApiDto(result.run) : null,
            automation: runWithAutomation?.automation
                ? {
                    id: runWithAutomation.automation.id,
                    name: runWithAutomation.automation.name,
                    enabled: runWithAutomation.automation.enabled,
                    targetType: runWithAutomation.automation.targetType,
                    templateCiphertext: runWithAutomation.automation.templateCiphertext,
                }
                : null,
        };
    });

    app.post('/v2/automations/runs/:runId/heartbeat', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ runId: z.string() }),
            body: z.object({
                machineId: z.string().trim().min(1),
                leaseDurationMs: z.number().int().min(5_000).max(15 * 60_000).optional(),
            }),
        },
    }, async (request, reply) => {
        const result = await heartbeatAutomationRun({
            accountId: request.userId,
            runId: request.params.runId,
            machineId: request.body.machineId,
            leaseDurationMs: request.body.leaseDurationMs ?? 30_000,
        });

        if (!result.ok) {
            return reply.code(404).send({ error: 'automation_run_not_found_or_not_claimed' });
        }

        return reply.send({
            ok: true,
            leaseExpiresAt: result.leaseExpiresAt ? result.leaseExpiresAt.getTime() : null,
        });
    });

    app.get('/v2/automations/daemon/assignments', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                machineId: z.string().trim().min(1),
            }),
        },
    }, async (request) => {
        const rows = await listDaemonAssignments({
            accountId: request.userId,
            machineId: request.query.machineId,
        });

        return {
            assignments: rows.map((row) => ({
                machineId: row.machineId,
                enabled: row.enabled,
                priority: row.priority,
                updatedAt: row.updatedAt.getTime(),
                automation: {
                    id: row.automation.id,
                    name: row.automation.name,
                    enabled: row.automation.enabled,
                    schedule: {
                        kind: row.automation.scheduleKind,
                        scheduleExpr: row.automation.scheduleExpr,
                        everyMs: row.automation.everyMs,
                        timezone: row.automation.timezone,
                    },
                    targetType: row.automation.targetType,
                    templateCiphertext: row.automation.templateCiphertext,
                    templateVersion: row.automation.templateVersion,
                    nextRunAt: row.automation.nextRunAt ? row.automation.nextRunAt.getTime() : null,
                    lastRunAt: row.automation.lastRunAt ? row.automation.lastRunAt.getTime() : null,
                    updatedAt: row.automation.updatedAt.getTime(),
                },
            })),
        };
    });
}
