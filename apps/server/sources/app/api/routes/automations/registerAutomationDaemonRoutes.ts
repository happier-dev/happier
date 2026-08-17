import { z } from "zod";

import { type Fastify } from "../../types";
import { claimAutomationRun, heartbeatAutomationRun } from "@/app/automations/automationClaimService";
import { listDaemonAssignments } from "@/app/automations/automationAssignmentService";
import { toAutomationRunV2ApiDto } from "@/app/automations/automationApiProjection";
import { readRetainedAutomationRunExecutionInputV2ForMode } from "@/app/automations/automationStoredContentRead";
import { resolveAutomationRunAttemptV2 } from "./automationRunAttemptV2Compatibility";

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
            expectedTriggerKind: "schedule",
            requireV2RunRepresentability: true,
        });
        const frozenInput = result.run?.executionInputEnvelope && result.accountCurrentness
            ? readRetainedAutomationRunExecutionInputV2ForMode({
                raw: result.run.executionInputEnvelope,
                mode: result.accountCurrentness.mode,
                originKind: result.run.originKind,
            })
            : null;

        return {
            run: result.run && frozenInput ? toAutomationRunV2ApiDto(result.run) : null,
            automation: result.run && frozenInput
                ? {
                    id: result.run.automation.id,
                    name: result.run.automation.name,
                    enabled: result.run.automation.enabled,
                    targetType: frozenInput.targetType,
                    templateCiphertext: frozenInput.templateCiphertext,
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
                attempt: z.number().int().min(1).optional(),
                leaseDurationMs: z.number().int().min(5_000).max(15 * 60_000).optional(),
            }),
        },
    }, async (request, reply) => {
        const result = await heartbeatAutomationRun({
            accountId: request.userId,
            runId: request.params.runId,
            machineId: request.body.machineId,
            attempt: resolveAutomationRunAttemptV2(request.body.attempt),
            leaseDurationMs: request.body.leaseDurationMs ?? 30_000,
            expectedTriggerKind: "schedule",
            requireV2RunRepresentability: true,
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
            expectedTriggerKind: "schedule",
            requireV2DefinitionRepresentability: true,
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
