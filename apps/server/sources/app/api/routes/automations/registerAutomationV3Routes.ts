import { z } from "zod";

import {
    AutomationV3AssignmentUpdateRequestSchema,
    AutomationV3SettingsSchema,
    AutomationV3SettingsUpdateRequestSchema,
    AutomationV3WorkerClaimRequestSchema,
    AutomationV3WorkerClaimResponseSchema,
    AutomationV3WorkerAssignmentsResponseSchema,
    AutomationV3WorkerExecutionDispatchSettlementRequestSchema,
    AutomationV3WorkerFailRequestSchema,
    AutomationV3WorkerHeartbeatRequestSchema,
    AutomationV3WorkerHeartbeatResponseSchema,
    AutomationV3WorkerStartRequestSchema,
    AutomationV3WorkerStartResponseSchema,
    AutomationV3WorkerSucceedRequestSchema,
    AutomationV3ClearRunHistoryResponseSchema,
    AutomationV3DeleteResponseSchema,
    AutomationV3DefinitionListResponseSchema,
    AutomationV3RunMutationResponseSchema,
    AutomationV3RunListResponseSchema,
    AutomationV3PluginEventDefinitionCreateRequestSchema,
    AutomationV3PluginEventDefinitionPatchRequestSchema,
    AutomationV3ManualDefinitionCreateRequestSchema,
    AutomationV3ManualDefinitionPatchRequestSchema,
    AutomationV3ScheduleDefinitionCreateRequestSchema,
    AutomationV3ScheduleDefinitionPatchRequestSchema,
    AutomationManualIdempotencyKeyV1Schema,
    type AutomationAccountCurrentnessWitnessV1,
    type AutomationV3ScheduleTrigger,
} from "@happier-dev/protocol";
import { type Fastify } from "../../types";
import { db } from "@/storage/db";
import {
    automationAccountCurrentnessSelect,
    deriveAutomationAccountCurrentnessWitness,
} from "@/app/automations/automationAccountCurrentness";
import {
    clearAutomationRunHistory,
    createAutomation,
    deleteAutomation,
    getAutomation,
    getAutomationRun,
    listAutomationRuns,
    listAutomations,
    runAutomationNow,
    setAutomationEnabled,
    updateAutomation,
    AutomationDisabledError,
    AutomationTemplateMutationConflictError,
} from "@/app/automations/automationCrudService";
import {
    claimAutomationRun,
    heartbeatAutomationRun,
} from "@/app/automations/automationClaimService";
import { listDaemonAssignments } from "@/app/automations/automationAssignmentService";
import {
    getAutomationSettings,
    updateAutomationSettings,
} from "@/app/automations/automationSettingsService";
import {
    toAutomationRunV3DetailApiDto,
    toAutomationRunV3ListApiDto,
    toAutomationRunV3OriginApiDto,
    toAutomationV3DefinitionDetailApiDto,
    toAutomationV3DefinitionListItemApiDto,
} from "@/app/automations/automationApiProjection";
import { loadAutomationV3EventStatusProjections } from "@/app/automations/automationV3EventStatusProjection";
import { AutomationStoredContentReadError } from "@/app/automations/automationStoredContentRead";
import {
    AutomationValidationError,
    parseAutomationScheduleInput,
} from "@/app/automations/automationValidation";
import {
    cancelAutomationRun,
    failAutomationRun,
    settleAutomationExecutionDispatch,
    startAutomationRun,
    succeedAutomationRun,
} from "@/app/automations/automationRunService";
import type { AutomationScheduleInput } from "@/app/automations/automationTypes";
import type { AutomationListItem } from "@/app/automations/automationTypes";
import { requirePresentUser } from "../../utils/requirePresentUser";
import {
    DEFAULT_AUTOMATION_WORKER_PUBLISHER_DEPENDENCIES,
    hasExactAutomationWorkerPublisher,
    type AutomationWorkerPublisherDependencies,
} from "./automationWorkerPublisher";

async function getCurrentAutomationAccountCurrentness(accountId: string) {
    const account = await db.account.findUnique({
        where: { id: accountId },
        select: automationAccountCurrentnessSelect,
    });
    return account ? deriveAutomationAccountCurrentnessWitness(account) : null;
}

function sendStoredContentFailure(reply: { code(code: number): { send(body: unknown): unknown } }) {
    return reply.code(409).send({ error: "automation_stored_content_unavailable" });
}

function toAutomationServiceSchedule(
    schedule: AutomationV3ScheduleTrigger["schedule"],
): AutomationScheduleInput {
    return parseAutomationScheduleInput(schedule.kind === "interval"
        ? {
            kind: "interval" as const,
            everyMs: schedule.everyMs,
            timezone: schedule.timezone,
        }
        : {
            kind: "cron" as const,
            scheduleExpr: schedule.scheduleExpr,
            timezone: schedule.timezone,
        });
}

function isAutomationV3ValidationError(error: unknown): error is AutomationValidationError | z.ZodError {
    return error instanceof AutomationValidationError || error instanceof z.ZodError;
}

async function toAutomationV3DefinitionDetailWithCurrentEventStatus(
    automation: AutomationListItem,
    accountCurrentness: AutomationAccountCurrentnessWitnessV1,
) {
    const projections = await loadAutomationV3EventStatusProjections({
        automations: [automation],
    });
    return toAutomationV3DefinitionDetailApiDto(
        automation,
        accountCurrentness,
        projections.get(automation.id),
    );
}

function automationV3ValidationMessage(error: AutomationValidationError | z.ZodError): string {
    if (error instanceof AutomationValidationError) return error.message;
    const issue = error.issues[0];
    const path = issue?.path.join(".") || "payload";
    return `${path}: ${issue?.message ?? "Invalid automation payload"}`;
}

const AutomationV3DefinitionCreateRequestSchema = z.union([
    AutomationV3ScheduleDefinitionCreateRequestSchema,
    AutomationV3ManualDefinitionCreateRequestSchema,
    AutomationV3PluginEventDefinitionCreateRequestSchema,
]);

const AutomationV3DefinitionPatchRequestSchema = z.union([
    AutomationV3ScheduleDefinitionPatchRequestSchema,
    AutomationV3ManualDefinitionPatchRequestSchema,
    AutomationV3PluginEventDefinitionPatchRequestSchema,
]);

const AutomationRunNowHeadersSchema = z.object({
    "idempotency-key": AutomationManualIdempotencyKeyV1Schema.optional(),
}).passthrough();

export function registerAutomationV3Routes(
    app: Fastify,
    workerPublisherDependencies: AutomationWorkerPublisherDependencies = DEFAULT_AUTOMATION_WORKER_PUBLISHER_DEPENDENCIES,
): void {
    app.get("/v3/automations", {
        preHandler: [app.authenticate, requirePresentUser],
    }, async (request) => {
        const rows = await listAutomations({ accountId: request.userId });
        const projections = await loadAutomationV3EventStatusProjections({ automations: rows });
        return AutomationV3DefinitionListResponseSchema.parse({
            automations: rows.map((row) => toAutomationV3DefinitionListItemApiDto(
                row,
                projections.get(row.id),
            )),
        });
    });

    app.get("/v3/automations/settings", {
        preHandler: [app.authenticate, requirePresentUser],
    }, async (request, reply) => {
        const settings = await getAutomationSettings({ accountId: request.userId });
        if (!settings) return reply.code(404).send({ error: "automation_settings_not_found" });
        return AutomationV3SettingsSchema.parse(settings);
    });

    app.put("/v3/automations/settings", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: { body: AutomationV3SettingsUpdateRequestSchema },
    }, async (request, reply) => {
        const settings = await updateAutomationSettings({
            accountId: request.userId,
            settings: AutomationV3SettingsUpdateRequestSchema.parse(request.body),
        });
        if (!settings) return reply.code(404).send({ error: "automation_settings_not_found" });
        return AutomationV3SettingsSchema.parse(settings);
    });

    app.post("/v3/automations/:id/runs/clear-history", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: { params: z.object({ id: z.string() }) },
    }, async (request, reply) => {
        const result = await clearAutomationRunHistory({
            accountId: request.userId,
            automationId: request.params.id,
        });
        if (result.status === "not_found") {
            return reply.code(404).send({ error: "automation_not_found" });
        }
        return AutomationV3ClearRunHistoryResponseSchema.parse({
            clearedRuns: result.clearedRuns,
        });
    });

    app.post("/v3/automations", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            body: AutomationV3DefinitionCreateRequestSchema,
        },
    }, async (request, reply) => {
        const accountCurrentness = await getCurrentAutomationAccountCurrentness(request.userId);
        if (!accountCurrentness) return sendStoredContentFailure(reply);
        try {
            const body = AutomationV3DefinitionCreateRequestSchema.parse(request.body);
            if (accountCurrentness.mode !== "plain") return sendStoredContentFailure(reply);
            const automation = await createAutomation({
                accountId: request.userId,
                input: {
                    name: body.name,
                    ...(body.description !== undefined ? { description: body.description } : {}),
                    enabled: body.enabled,
                    ...(body.trigger.kind === "schedule"
                        ? { schedule: toAutomationServiceSchedule(body.trigger.schedule) }
                        : body.trigger.kind === "manual"
                            ? { manual: true as const }
                            : { pluginEvent: body.trigger }),
                    executionRecipe: body.executionRecipe,
                    ...(body.assignments !== undefined ? { assignments: body.assignments } : {}),
                },
            });
            return reply.send(await toAutomationV3DefinitionDetailWithCurrentEventStatus(
                automation,
                accountCurrentness,
            ));
        } catch (error) {
            if (error instanceof AutomationStoredContentReadError) {
                return sendStoredContentFailure(reply);
            }
            if (!isAutomationV3ValidationError(error)) throw error;
            return reply.code(400).send({ error: automationV3ValidationMessage(error) });
        }
    });

    app.patch("/v3/automations/:id", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ id: z.string() }),
            body: AutomationV3DefinitionPatchRequestSchema,
        },
    }, async (request, reply) => {
        const accountCurrentness = await getCurrentAutomationAccountCurrentness(request.userId);
        if (!accountCurrentness) return sendStoredContentFailure(reply);
        try {
            const body = AutomationV3DefinitionPatchRequestSchema.parse(request.body);
            if (body.executionRecipe !== undefined && accountCurrentness.mode !== "plain") {
                return sendStoredContentFailure(reply);
            }
            const input = {
                ...(body.name !== undefined ? { name: body.name } : {}),
                ...(body.description !== undefined ? { description: body.description } : {}),
                ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
                ...(body.trigger !== undefined && body.trigger.kind === "schedule"
                    ? { schedule: toAutomationServiceSchedule(body.trigger.schedule) }
                    : {}),
                ...(body.trigger !== undefined && body.trigger.kind === "pluginEvent"
                    ? { pluginEvent: body.trigger }
                    : {}),
                ...(body.trigger !== undefined && body.trigger.kind === "manual"
                    ? { manual: true as const }
                    : {}),
                ...(body.executionRecipe !== undefined
                    ? { executionRecipe: body.executionRecipe }
                    : {}),
                ...(body.assignments !== undefined ? { assignments: body.assignments } : {}),
            };
            const automation = await updateAutomation({
                accountId: request.userId,
                automationId: request.params.id,
                input,
                expectedTriggerKind: body.trigger?.kind === "manual"
                    ? "manual"
                    : "expectedTemplateVersion" in body
                        ? "pluginEvent"
                        : "schedule",
                ...("expectedTemplateVersion" in body
                    ? { expectedTemplateVersion: body.expectedTemplateVersion }
                    : {}),
            });
            if (!automation) return reply.code(404).send({ error: "automation_not_found" });
            return reply.send(await toAutomationV3DefinitionDetailWithCurrentEventStatus(
                automation,
                accountCurrentness,
            ));
        } catch (error) {
            if (error instanceof AutomationStoredContentReadError) {
                return sendStoredContentFailure(reply);
            }
            if (error instanceof AutomationTemplateMutationConflictError) {
                return reply.code(409).send({ error: "automation_template_version_conflict" });
            }
            if (!isAutomationV3ValidationError(error)) throw error;
            return reply.code(400).send({ error: automationV3ValidationMessage(error) });
        }
    });

    app.delete("/v3/automations/:id", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: { params: z.object({ id: z.string() }) },
    }, async (request, reply) => {
        const deleted = await deleteAutomation({
            accountId: request.userId,
            automationId: request.params.id,
        });
        if (!deleted) return reply.code(404).send({ error: "automation_not_found" });
        return reply.send(AutomationV3DeleteResponseSchema.parse({ ok: true }));
    });

    app.post("/v3/automations/:id/pause", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: { params: z.object({ id: z.string() }) },
    }, async (request, reply) => {
        const accountCurrentness = await getCurrentAutomationAccountCurrentness(request.userId);
        if (!accountCurrentness) return sendStoredContentFailure(reply);
        const automation = await setAutomationEnabled({
            accountId: request.userId,
            automationId: request.params.id,
            enabled: false,
        });
        if (!automation) return reply.code(404).send({ error: "automation_not_found" });
        return reply.send(await toAutomationV3DefinitionDetailWithCurrentEventStatus(
            automation,
            accountCurrentness,
        ));
    });

    app.post("/v3/automations/:id/resume", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: { params: z.object({ id: z.string() }) },
    }, async (request, reply) => {
        const accountCurrentness = await getCurrentAutomationAccountCurrentness(request.userId);
        if (!accountCurrentness) return sendStoredContentFailure(reply);
        const automation = await setAutomationEnabled({
            accountId: request.userId,
            automationId: request.params.id,
            enabled: true,
        });
        if (!automation) return reply.code(404).send({ error: "automation_not_found" });
        return reply.send(await toAutomationV3DefinitionDetailWithCurrentEventStatus(
            automation,
            accountCurrentness,
        ));
    });

    app.post("/v3/automations/:id/assignments", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ id: z.string() }),
            body: AutomationV3AssignmentUpdateRequestSchema,
        },
    }, async (request, reply) => {
        const accountCurrentness = await getCurrentAutomationAccountCurrentness(request.userId);
        if (!accountCurrentness) return sendStoredContentFailure(reply);
        try {
            const body = AutomationV3AssignmentUpdateRequestSchema.parse(request.body);
            const automation = await updateAutomation({
                accountId: request.userId,
                automationId: request.params.id,
                input: { assignments: body.assignments },
            });
            if (!automation) return reply.code(404).send({ error: "automation_not_found" });
            return reply.send(await toAutomationV3DefinitionDetailWithCurrentEventStatus(
                automation,
                accountCurrentness,
            ));
        } catch (error) {
            if (!isAutomationV3ValidationError(error)) throw error;
            return reply.code(400).send({ error: automationV3ValidationMessage(error) });
        }
    });

    app.post("/v3/automations/:id/run-now", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ id: z.string() }),
            headers: AutomationRunNowHeadersSchema,
        },
    }, async (request, reply) => {
        try {
            const headers = AutomationRunNowHeadersSchema.parse(request.headers);
            const run = await runAutomationNow({
                accountId: request.userId,
                automationId: request.params.id,
                ...(headers["idempotency-key"]
                    ? { idempotencyKey: headers["idempotency-key"] }
                    : {}),
            });
            if (!run) return reply.code(404).send({ error: "automation_not_found" });
            return reply.send(AutomationV3RunMutationResponseSchema.parse({
                run: toAutomationRunV3ListApiDto(run),
            }));
        } catch (error) {
            if (error instanceof AutomationDisabledError) {
                return reply.code(409).send({ error: "automation_disabled" });
            }
            if (!isAutomationV3ValidationError(error)) throw error;
            return reply.code(400).send({ error: automationV3ValidationMessage(error) });
        }
    });

    app.get("/v3/automations/worker/assignments", {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({ machineId: z.string().trim().min(1) }),
        },
    }, async (request, reply) => {
        if (!await hasExactAutomationWorkerPublisher({
            dependencies: workerPublisherDependencies,
            accountId: request.userId,
            request,
            path: "/v3/automations/worker/assignments",
            machineId: request.query.machineId,
        })) return reply.code(401).send(null);
        const assignments = await listDaemonAssignments({
            accountId: request.userId,
            machineId: request.query.machineId,
        });
        const settings = await getAutomationSettings({ accountId: request.userId });
        if (!settings) return reply.code(404).send(null);
        return AutomationV3WorkerAssignmentsResponseSchema.parse({
            assignments: assignments.map((assignment) => ({
                machineId: assignment.machineId,
                automationId: assignment.automation.id,
                nextClaimAt: assignment.nextClaimAt?.getTime() ?? null,
            })),
            settings: {
                maxActiveRunsPerMachine: settings.maxActiveRunsPerMachine,
            },
        });
    });

    app.post("/v3/automations/runs/claim", {
        preHandler: app.authenticate,
        schema: { body: AutomationV3WorkerClaimRequestSchema },
    }, async (request, reply) => {
        const body = AutomationV3WorkerClaimRequestSchema.parse(request.body);
        if (!await hasExactAutomationWorkerPublisher({
            dependencies: workerPublisherDependencies,
            accountId: request.userId,
            request,
            path: "/v3/automations/runs/claim",
            machineId: body.machineId,
        })) return reply.code(401).send(null);
        const result = await claimAutomationRun({
            accountId: request.userId,
            machineId: body.machineId,
            leaseDurationMs: body.leaseDurationMs ?? 30_000,
        });
        if (!result.run || !result.accountCurrentness) {
            return AutomationV3WorkerClaimResponseSchema.parse({
                run: null,
                automation: null,
                accountCurrentness: null,
            });
        }
        return AutomationV3WorkerClaimResponseSchema.parse({
            run: {
                id: result.run.id,
                automationId: result.run.automationId,
                attempt: result.run.attempt,
                executionInputEnvelope: result.run.executionInputEnvelope,
                // Reuse the incumbent immutable Run-origin projector rather
                // than deriving origin from the mutable Automation definition.
                origin: toAutomationRunV3OriginApiDto(result.run),
                ...(result.run.originKind === "conversation"
                    && result.run.replyHandoffState === "awaitingResult"
                    && typeof result.run.replyHandoffId === "string"
                    && result.run.replyHandoffId.trim().length > 0
                    ? {
                        resultDelivery: {
                            kind: "finalResult" as const,
                            accountId: request.userId,
                            handoffId: result.run.replyHandoffId,
                        },
                    }
                    : {}),
            },
            automation: {
                id: result.run.automation.id,
                name: result.run.automation.name,
                enabled: result.run.automation.enabled,
            },
            accountCurrentness: result.accountCurrentness,
        });
    });

    app.post("/v3/automations/runs/:runId/heartbeat", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ runId: z.string() }),
            body: AutomationV3WorkerHeartbeatRequestSchema,
        },
    }, async (request, reply) => {
        const body = AutomationV3WorkerHeartbeatRequestSchema.parse(request.body);
        if (!await hasExactAutomationWorkerPublisher({
            dependencies: workerPublisherDependencies,
            accountId: request.userId,
            request,
            path: `/v3/automations/runs/${encodeURIComponent(request.params.runId)}/heartbeat`,
            machineId: body.machineId,
        })) return reply.code(401).send(null);
        const result = await heartbeatAutomationRun({
            accountId: request.userId,
            runId: request.params.runId,
            machineId: body.machineId,
            attempt: body.attempt,
            leaseDurationMs: body.leaseDurationMs ?? 30_000,
        });
        if (!result.ok) {
            return reply.code(404).send({ error: "automation_run_not_found_or_not_claimed" });
        }
        return reply.send(AutomationV3WorkerHeartbeatResponseSchema.parse({
            ok: true,
            leaseExpiresAt: result.leaseExpiresAt?.getTime() ?? null,
        }));
    });

    app.post("/v3/automations/runs/:runId/start", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ runId: z.string() }),
            body: AutomationV3WorkerStartRequestSchema,
        },
    }, async (request, reply) => {
        const body = AutomationV3WorkerStartRequestSchema.parse(request.body);
        if (!await hasExactAutomationWorkerPublisher({
            dependencies: workerPublisherDependencies,
            accountId: request.userId,
            request,
            path: `/v3/automations/runs/${encodeURIComponent(request.params.runId)}/start`,
            machineId: body.machineId,
        })) return reply.code(401).send(null);
        const started = await startAutomationRun({
            accountId: request.userId,
            runId: request.params.runId,
            machineId: body.machineId,
            attempt: body.attempt,
            accountCurrentness: body.accountCurrentness,
        });
        if (!started) return reply.code(404).send({ error: "automation_run_not_found_or_not_claimed" });
        return reply.send(AutomationV3WorkerStartResponseSchema.parse({
            run: toAutomationRunV3ListApiDto(started.run),
            accountCurrentness: started.accountCurrentness,
        }));
    });

    app.post("/v3/automations/runs/:runId/execution-dispatch/settle", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ runId: z.string() }),
            body: AutomationV3WorkerExecutionDispatchSettlementRequestSchema,
        },
    }, async (request, reply) => {
        const body = AutomationV3WorkerExecutionDispatchSettlementRequestSchema.parse(request.body);
        if (!await hasExactAutomationWorkerPublisher({
            dependencies: workerPublisherDependencies,
            accountId: request.userId,
            request,
            path: `/v3/automations/runs/${encodeURIComponent(request.params.runId)}/execution-dispatch/settle`,
            machineId: body.machineId,
        })) return reply.code(401).send(null);
        const run = await settleAutomationExecutionDispatch({
            accountId: request.userId,
            runId: request.params.runId,
            machineId: body.machineId,
            attempt: body.attempt,
            accountCurrentness: body.accountCurrentness,
            outcome: body.outcome,
        });
        if (!run) return reply.code(404).send({ error: "automation_run_not_found_or_not_dispatching" });
        return reply.send(AutomationV3RunMutationResponseSchema.parse({
            run: toAutomationRunV3ListApiDto(run),
        }));
    });

    app.post("/v3/automations/runs/:runId/succeed", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ runId: z.string() }),
            body: AutomationV3WorkerSucceedRequestSchema,
        },
    }, async (request, reply) => {
        const body = AutomationV3WorkerSucceedRequestSchema.parse(request.body);
        if (!await hasExactAutomationWorkerPublisher({
            dependencies: workerPublisherDependencies,
            accountId: request.userId,
            request,
            path: `/v3/automations/runs/${encodeURIComponent(request.params.runId)}/succeed`,
            machineId: body.machineId,
        })) return reply.code(401).send(null);
        const run = await succeedAutomationRun({
            accountId: request.userId,
            runId: request.params.runId,
            machineId: body.machineId,
            attempt: body.attempt,
            accountCurrentness: body.accountCurrentness,
            producedSessionId: body.producedSessionId ?? null,
            resultEnvelope: body.resultEnvelope ?? null,
        });
        if (!run) return reply.code(404).send({ error: "automation_run_not_found_or_not_claimed" });
        return reply.send(AutomationV3RunMutationResponseSchema.parse({
            run: toAutomationRunV3ListApiDto(run),
        }));
    });

    app.post("/v3/automations/runs/:runId/fail", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ runId: z.string() }),
            body: AutomationV3WorkerFailRequestSchema,
        },
    }, async (request, reply) => {
        const body = AutomationV3WorkerFailRequestSchema.parse(request.body);
        if (!await hasExactAutomationWorkerPublisher({
            dependencies: workerPublisherDependencies,
            accountId: request.userId,
            request,
            path: `/v3/automations/runs/${encodeURIComponent(request.params.runId)}/fail`,
            machineId: body.machineId,
        })) return reply.code(401).send(null);
        const run = await failAutomationRun({
            accountId: request.userId,
            runId: request.params.runId,
            machineId: body.machineId,
            attempt: body.attempt,
            accountCurrentness: body.accountCurrentness,
            producedSessionId: body.producedSessionId ?? null,
            errorCode: body.errorCode ?? null,
            errorDetailEnvelope: body.errorDetailEnvelope ?? null,
        });
        if (!run) return reply.code(404).send({ error: "automation_run_not_found_or_not_claimed" });
        return reply.send(AutomationV3RunMutationResponseSchema.parse({
            run: toAutomationRunV3ListApiDto(run),
        }));
    });

    app.post("/v3/automations/runs/:runId/cancel", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: { params: z.object({ runId: z.string() }) },
    }, async (request, reply) => {
        const run = await cancelAutomationRun({
            accountId: request.userId,
            runId: request.params.runId,
        });
        if (!run) return reply.code(404).send({ error: "automation_run_not_found" });
        return reply.send(AutomationV3RunMutationResponseSchema.parse({
            run: toAutomationRunV3ListApiDto(run),
        }));
    });

    app.get("/v3/automations/:id", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: { params: z.object({ id: z.string() }) },
    }, async (request, reply) => {
        const row = await getAutomation({
            accountId: request.userId,
            automationId: request.params.id,
        });
        if (!row) {
            return reply.code(404).send({ error: "automation_not_found" });
        }
        const accountCurrentness = await getCurrentAutomationAccountCurrentness(request.userId);
        if (!accountCurrentness) {
            return sendStoredContentFailure(reply);
        }
        try {
            return reply.send(await toAutomationV3DefinitionDetailWithCurrentEventStatus(
                row,
                accountCurrentness,
            ));
        } catch (error) {
            if (error instanceof AutomationStoredContentReadError) {
                return sendStoredContentFailure(reply);
            }
            throw error;
        }
    });

    app.get("/v3/automations/:id/runs", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ id: z.string() }),
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(100).optional(),
                cursor: z.string().optional(),
            }).optional(),
        },
    }, async (request, reply) => {
        const result = await listAutomationRuns({
            accountId: request.userId,
            automationId: request.params.id,
            limit: request.query?.limit ?? 20,
            cursor: request.query?.cursor,
        });
        if (!result) return reply.code(404).send({ error: "automation_not_found" });
        return AutomationV3RunListResponseSchema.parse({
            runs: result.runs.map(toAutomationRunV3ListApiDto),
            nextCursor: result.nextCursor,
        });
    });

    app.get("/v3/automations/:id/runs/:runId", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ id: z.string(), runId: z.string() }),
        },
    }, async (request, reply) => {
        const run = await getAutomationRun({
            accountId: request.userId,
            automationId: request.params.id,
            runId: request.params.runId,
        });
        if (!run) {
            return reply.code(404).send({ error: "automation_run_not_found" });
        }
        const accountCurrentness = await getCurrentAutomationAccountCurrentness(request.userId);
        if (!accountCurrentness) {
            return sendStoredContentFailure(reply);
        }
        try {
            return reply.send(toAutomationRunV3DetailApiDto(run, accountCurrentness.mode));
        } catch (error) {
            if (error instanceof AutomationStoredContentReadError) {
                return sendStoredContentFailure(reply);
            }
            throw error;
        }
    });
}
