import { z } from "zod";

import { type Fastify } from "../../types";
import { claimAutomationRun, heartbeatAutomationRun } from "@/app/automations/automationClaimService";
import { listDaemonAssignments } from "@/app/automations/automationAssignmentService";
import { toAutomationRunV2ApiDto } from "@/app/automations/automationApiProjection";
import { readRetainedAutomationRunExecutionInputV2ForMode } from "@/app/automations/automationStoredContentRead";
import { decodeAutomationRunCause } from "@/app/automations/automationRunCauseCodec";
import {
    DEFAULT_AUTOMATION_WORKER_PUBLISHER_DEPENDENCIES,
    resolveExactAutomationWorkerPublisher,
    type AutomationWorkerPublisherDependencies,
} from "./automationWorkerPublisher";

export function registerAutomationDaemonRoutes(
    app: Fastify,
    dependencies: AutomationWorkerPublisherDependencies = DEFAULT_AUTOMATION_WORKER_PUBLISHER_DEPENDENCIES,
): void {
    app.post('/v2/automations/runs/claim', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                machineId: z.string().trim().min(1),
                leaseDurationMs: z.number().int().min(5_000).max(15 * 60_000).optional(),
            }),
        },
    }, async (request, reply) => {
        if (!await resolveExactAutomationWorkerPublisher({
            dependencies,
            accountId: request.userId,
            request,
            path: "/v2/automations/runs/claim",
            machineId: request.body.machineId,
            allowReleasedV2MissingProof: true,
        })) return reply.code(401).send(null);
        const result = await claimAutomationRun({
            accountId: request.userId,
            machineId: request.body.machineId,
            leaseDurationMs: request.body.leaseDurationMs ?? 30_000,
            requireV2RunRepresentability: true,
        });
        const cause = result.run ? decodeAutomationRunCause(result.run) : null;
        const retainedV2OriginKind = cause?.kind === "manual"
            ? "manual" as const
            : cause?.kind === "trigger" && cause.triggerKind === "schedule"
                ? "scheduled" as const
                : undefined;
        const frozenInput = result.run?.executionInputEnvelope && result.accountCurrentness
            ? readRetainedAutomationRunExecutionInputV2ForMode({
                raw: result.run.executionInputEnvelope,
                mode: result.accountCurrentness.mode,
                retainedV2OriginKind,
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
        if (!await resolveExactAutomationWorkerPublisher({
            dependencies,
            accountId: request.userId,
            request,
            path: `/v2/automations/runs/${encodeURIComponent(request.params.runId)}/heartbeat`,
            machineId: request.body.machineId,
            allowReleasedV2MissingProof: true,
        })) return reply.code(401).send(null);
        const result = await heartbeatAutomationRun({
            accountId: request.userId,
            runId: request.params.runId,
            machineId: request.body.machineId,
            ...(request.body.attempt === undefined ? {} : { attempt: request.body.attempt }),
            leaseDurationMs: request.body.leaseDurationMs ?? 30_000,
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
    }, async (request, reply) => {
        if (!await resolveExactAutomationWorkerPublisher({
            dependencies,
            accountId: request.userId,
            request,
            path: "/v2/automations/daemon/assignments",
            machineId: request.query.machineId,
            allowReleasedV2MissingProof: true,
        })) return reply.code(401).send(null);
        const rows = await listDaemonAssignments({
            accountId: request.userId,
            machineId: request.query.machineId,
            requireV2DefinitionRepresentability: true,
        });

        return {
            assignments: rows.map((row) => {
                const trigger = row.automation.triggers[0];
                if (!trigger || trigger.kind !== "schedule" || trigger.scheduleKind === null) {
                    throw new Error("V2 assignment is missing its sole schedule trigger");
                }
                return {
                    machineId: row.machineId,
                    enabled: row.enabled,
                    priority: row.priority,
                    updatedAt: row.updatedAt.getTime(),
                    automation: {
                        id: row.automation.id,
                        name: row.automation.name,
                        enabled: row.automation.enabled,
                        schedule: {
                            kind: trigger.scheduleKind,
                            scheduleExpr: trigger.scheduleExpr,
                            everyMs: trigger.everyMs,
                            timezone: trigger.timezone,
                        },
                        targetType: row.automation.targetType,
                        templateCiphertext: row.automation.templateCiphertext,
                        templateVersion: row.automation.templateVersion,
                        // Released V2 workers use this field as their assignment wake cursor.
                        // The assignment owner already folds schedule, queued-Run, lease, and
                        // retirement wakes into nextClaimAt; projecting mutable trigger state
                        // here would make a worker sleep past an earlier canonical wake.
                        nextRunAt: row.nextClaimAt?.getTime() ?? null,
                        lastRunAt: row.automation.lastRunAt ? row.automation.lastRunAt.getTime() : null,
                        updatedAt: row.automation.updatedAt.getTime(),
                    },
                };
            }),
        };
    });
}
