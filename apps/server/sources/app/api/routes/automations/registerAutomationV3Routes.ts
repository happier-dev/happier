import { z } from "zod";

import {
    AUTOMATION_V3_RUN_LIST_MAX_ITEMS,
    AutomationAssignmentUpdateRequestSchema,
    AutomationV3SettingsSchema,
    AutomationV3SettingsUpdateRequestSchema,
    AutomationV3WorkerClaimRequestSchema,
    AutomationV3WorkerAssignmentsResponseSchema,
    AutomationV3WorkerExecutionDispatchSettlementRequestSchema,
    AutomationV3WorkerFailRequestSchema,
    AutomationV3WorkerHeartbeatRequestSchema,
    AutomationV3WorkerHeartbeatResponseSchema,
    AutomationV3WorkerStartRequestSchema,
    AutomationV3WorkerStartResponseSchema,
    AutomationV3WorkerSucceedRequestSchema,
    AutomationV3ClearRunHistoryResponseSchema,
    AutomationDeleteResponseSchema,
    AutomationDefinitionCreateRequestSchema,
    AutomationDefinitionReconcileRequestSchema,
    AutomationDefinitionPatchRequestSchema,
    AutomationDefinitionListRequestSchema,
    AutomationDefinitionListResponseSchema,
    AutomationTriggerCreateRequestSchema,
    AutomationTriggerDeleteRequestSchema,
    AutomationTriggerPatchRequestSchema,
    AutomationV3RunMutationResponseSchema,
    AutomationV3RunListResponseSchema,
    AutomationManualIdempotencyKeyV1Schema,
    type AutomationAccountCurrentnessWitnessV1,
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
    createAutomationTrigger,
    deleteAutomation,
    deleteAutomationTrigger,
    getAutomation,
    getAutomationRun,
    listAutomationRuns,
    listAutomationDefinitionsPage,
    reconcileAutomationDefinition,
    runAutomationNow,
    setAutomationEnabled,
    updateAutomation,
    updateAutomationTrigger,
    AutomationDefinitionCreateConflictError,
    AutomationDisabledError,
    AutomationTemplateMutationConflictError,
    AutomationTriggerCreateConflictError,
    AutomationTriggerMutationConflictError,
} from "@/app/automations/automationCrudService";
import {
    claimAutomationRun,
    heartbeatAutomationRun,
    toAutomationV3WorkerClaimResponse,
} from "@/app/automations/automationClaimService";
import { listDaemonAssignments } from "@/app/automations/automationAssignmentService";
import {
    getAutomationSettings,
    updateAutomationSettings,
} from "@/app/automations/automationSettingsService";
import {
    toAutomationRunV3DetailApiDto,
    toAutomationRunV3ListApiDto,
    toAutomationDefinitionDetailApiDto,
    toAutomationDefinitionListItemApiDto,
} from "@/app/automations/automationApiProjection";
import { loadAutomationEventStatusProjections } from "@/app/automations/automationEventStatusProjection";
import { loadAutomationSessionLifecycleStatusProjections } from "@/app/automations/automationSessionLifecycleStatusProjection";
import { AutomationStoredContentReadError } from "@/app/automations/automationStoredContentRead";
import { AutomationValidationError } from "@/app/automations/automationValidation";
import { AutomationSessionLifecycleRegistrationValidationError } from "@/app/automations/automationSessionLifecycleRegistration";
import {
    cancelAutomationRun,
    failAutomationRun,
    settleAutomationExecutionDispatch,
    startAutomationRun,
    succeedAutomationRun,
} from "@/app/automations/automationRunService";
import { retryBlockedAutomationReplyHandoff } from "@/app/automations/automationReplyHandoffService";
import type { AutomationListItem, AutomationRunItem } from "@/app/automations/automationTypes";
import { requirePresentUser } from "../../utils/requirePresentUser";
import {
    DEFAULT_AUTOMATION_WORKER_PUBLISHER_DEPENDENCIES,
    resolveExactAutomationWorkerPublisher,
    type AutomationWorkerPublisherDependencies,
} from "./automationWorkerPublisher";

async function getCurrentAutomationAccountCurrentness(accountId: string) {
    const account = await db.account.findUnique({
        where: { id: accountId },
        select: automationAccountCurrentnessSelect,
    });
    return account ? deriveAutomationAccountCurrentnessWitness(account) : null;
}

async function toCurrentAutomationRunListDto(
    accountId: string,
    run: AutomationRunItem,
) {
    if (run.triggerId === null) return toAutomationRunV3ListApiDto(run);
    const current = await getAutomationRun({
        accountId,
        automationId: run.automationId,
        runId: run.id,
    });
    if (!current) throw new Error("Automation Run disappeared during response projection");
    return toAutomationRunV3ListApiDto(current);
}

function sendStoredContentFailure(reply: { code(code: number): { send(body: unknown): unknown } }) {
    return reply.code(409).send({ error: "automation_stored_content_unavailable" });
}

function isAutomationDefinitionValidationError(error: unknown): error is AutomationValidationError | z.ZodError {
    return error instanceof AutomationValidationError || error instanceof z.ZodError;
}

async function toAutomationDefinitionDetailWithCurrentEventStatus(
    automation: AutomationListItem,
    accountCurrentness: AutomationAccountCurrentnessWitnessV1,
) {
    const [eventProjections, lifecycleProjections] = await Promise.all([
        loadAutomationEventStatusProjections({ automations: [automation] }),
        loadAutomationSessionLifecycleStatusProjections({ automations: [automation] }),
    ]);
    return toAutomationDefinitionDetailApiDto(
        automation,
        accountCurrentness,
        eventProjections,
        lifecycleProjections.get(automation.id),
    );
}

function automationDefinitionValidationMessage(error: AutomationValidationError | z.ZodError): string {
    if (error instanceof AutomationSessionLifecycleRegistrationValidationError) return error.code;
    if (error instanceof AutomationValidationError) return error.message;
    const issue = error.issues[0];
    const path = issue?.path.join(".") || "payload";
    return `${path}: ${issue?.message ?? "Invalid automation payload"}`;
}

const AutomationRunNowHeadersSchema = z.object({
    "idempotency-key": AutomationManualIdempotencyKeyV1Schema.optional(),
}).passthrough();

export function registerAutomationV3Routes(
    app: Fastify,
    workerPublisherDependencies: AutomationWorkerPublisherDependencies = DEFAULT_AUTOMATION_WORKER_PUBLISHER_DEPENDENCIES,
): void {
    app.get("/v3/automations", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: { querystring: AutomationDefinitionListRequestSchema },
    }, async (request, reply) => {
        try {
            const query = AutomationDefinitionListRequestSchema.parse(request.query);
            const page = await listAutomationDefinitionsPage({
                accountId: request.userId,
                limit: query.limit,
                ...(query.cursor ? { cursor: query.cursor } : {}),
            });
            const rows = page.automations;
            const [eventProjections, lifecycleProjections] = await Promise.all([
                loadAutomationEventStatusProjections({ automations: rows }),
                loadAutomationSessionLifecycleStatusProjections({ automations: rows }),
            ]);
            return AutomationDefinitionListResponseSchema.parse({
                automations: rows.map((row) => toAutomationDefinitionListItemApiDto(
                    row,
                    eventProjections,
                    lifecycleProjections.get(row.id),
                )),
                nextCursor: page.nextCursor,
            });
        } catch (error) {
            if (!isAutomationDefinitionValidationError(error)) throw error;
            return reply.code(400).send({ error: automationDefinitionValidationMessage(error) });
        }
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
            body: AutomationDefinitionCreateRequestSchema,
        },
    }, async (request, reply) => {
        const accountCurrentness = await getCurrentAutomationAccountCurrentness(request.userId);
        if (!accountCurrentness) return sendStoredContentFailure(reply);
        try {
            const body = AutomationDefinitionCreateRequestSchema.parse(request.body);
            if (accountCurrentness.mode !== "plain" && body.triggers.some(({ trigger }) =>
                trigger.kind === "pluginEvent"
                && !("triggerDefinitionEnvelope" in trigger)
            )) {
                return sendStoredContentFailure(reply);
            }
            const automation = await createAutomation({
                accountId: request.userId,
                input: {
                    automationId: body.automationId,
                    name: body.name,
                    ...(body.description !== undefined ? { description: body.description } : {}),
                    enabled: body.enabled,
                    executionRecipe: body.executionRecipe,
                    triggers: body.triggers,
                    ...(body.assignments !== undefined ? { assignments: body.assignments } : {}),
                },
            });
            return reply.send(await toAutomationDefinitionDetailWithCurrentEventStatus(
                automation,
                accountCurrentness,
            ));
        } catch (error) {
            if (error instanceof AutomationStoredContentReadError) {
                return sendStoredContentFailure(reply);
            }
            if (error instanceof AutomationDefinitionCreateConflictError) {
                return reply.code(409).send({ error: "automation_create_conflict" });
            }
            if (!isAutomationDefinitionValidationError(error)) throw error;
            return reply.code(400).send({ error: automationDefinitionValidationMessage(error) });
        }
    });

    app.patch("/v3/automations/:id", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ id: z.string() }),
            body: AutomationDefinitionPatchRequestSchema,
        },
    }, async (request, reply) => {
        const accountCurrentness = await getCurrentAutomationAccountCurrentness(request.userId);
        if (!accountCurrentness) return sendStoredContentFailure(reply);
        try {
            const body = AutomationDefinitionPatchRequestSchema.parse(request.body);
            const input = {
                ...(body.name !== undefined ? { name: body.name } : {}),
                ...(body.description !== undefined ? { description: body.description } : {}),
                ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
                ...(body.executionRecipe !== undefined
                    ? { executionRecipe: body.executionRecipe }
                    : {}),
                ...(body.assignments !== undefined ? { assignments: body.assignments } : {}),
            };
            const automation = await updateAutomation({
                accountId: request.userId,
                automationId: request.params.id,
                input,
                expectedTemplateVersion: body.expectedTemplateVersion,
            });
            if (!automation) return reply.code(404).send({ error: "automation_not_found" });
            return reply.send(await toAutomationDefinitionDetailWithCurrentEventStatus(
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
            if (!isAutomationDefinitionValidationError(error)) throw error;
            return reply.code(400).send({ error: automationDefinitionValidationMessage(error) });
        }
    });

    app.put("/v3/automations/:id", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ id: z.string() }),
            body: AutomationDefinitionReconcileRequestSchema,
        },
    }, async (request, reply) => {
        const accountCurrentness = await getCurrentAutomationAccountCurrentness(request.userId);
        if (!accountCurrentness) return sendStoredContentFailure(reply);
        try {
            const body = AutomationDefinitionReconcileRequestSchema.parse(request.body);
            if (accountCurrentness.mode !== "plain" && body.triggers.some((item) => {
                const trigger = item.kind === "new" ? item.trigger : item.trigger;
                return trigger?.kind === "pluginEvent"
                    && !("triggerDefinitionEnvelope" in trigger);
            })) {
                return sendStoredContentFailure(reply);
            }
            const automation = await reconcileAutomationDefinition({
                accountId: request.userId,
                automationId: request.params.id,
                input: body,
            });
            if (!automation) return reply.code(404).send({ error: "automation_not_found" });
            return reply.send(await toAutomationDefinitionDetailWithCurrentEventStatus(
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
            if (error instanceof AutomationTriggerMutationConflictError) {
                return reply.code(409).send({ error: "automation_trigger_revision_conflict" });
            }
            if (!isAutomationDefinitionValidationError(error)) throw error;
            return reply.code(400).send({ error: automationDefinitionValidationMessage(error) });
        }
    });

    app.post("/v3/automations/:id/triggers", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ id: z.string() }),
            body: AutomationTriggerCreateRequestSchema,
        },
    }, async (request, reply) => {
        const accountCurrentness = await getCurrentAutomationAccountCurrentness(request.userId);
        if (!accountCurrentness) return sendStoredContentFailure(reply);
        try {
            const body = AutomationTriggerCreateRequestSchema.parse(request.body);
            if (body.trigger.kind === "pluginEvent"
                && !("triggerDefinitionEnvelope" in body.trigger)
                && accountCurrentness.mode !== "plain") {
                return sendStoredContentFailure(reply);
            }
            const automation = await createAutomationTrigger({
                accountId: request.userId,
                automationId: request.params.id,
                triggerId: body.triggerId,
                trigger: body.trigger,
            });
            if (!automation) return reply.code(404).send({ error: "automation_not_found" });
            return reply.send(await toAutomationDefinitionDetailWithCurrentEventStatus(
                automation,
                accountCurrentness,
            ));
        } catch (error) {
            if (error instanceof AutomationStoredContentReadError) {
                return sendStoredContentFailure(reply);
            }
            if (error instanceof AutomationTriggerCreateConflictError) {
                return reply.code(409).send({ error: "automation_trigger_create_conflict" });
            }
            if (!isAutomationDefinitionValidationError(error)) throw error;
            return reply.code(400).send({ error: automationDefinitionValidationMessage(error) });
        }
    });

    app.patch("/v3/automations/:id/triggers", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ id: z.string() }),
            body: AutomationTriggerPatchRequestSchema,
        },
    }, async (request, reply) => {
        const accountCurrentness = await getCurrentAutomationAccountCurrentness(request.userId);
        if (!accountCurrentness) return sendStoredContentFailure(reply);
        try {
            const body = AutomationTriggerPatchRequestSchema.parse(request.body);
            if (body.trigger?.kind === "pluginEvent"
                && !("triggerDefinitionEnvelope" in body.trigger)
                && accountCurrentness.mode !== "plain") {
                return sendStoredContentFailure(reply);
            }
            const automation = await updateAutomationTrigger({
                accountId: request.userId,
                automationId: request.params.id,
                triggerId: body.triggerId,
                expectedRevision: body.expectedRevision,
                ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
                ...(body.trigger !== undefined ? { trigger: body.trigger } : {}),
                ...(body.triggerDefinitionEnvelope !== undefined
                    ? { triggerDefinitionEnvelope: body.triggerDefinitionEnvelope }
                    : {}),
            });
            if (!automation) return reply.code(404).send({ error: "automation_not_found" });
            return reply.send(await toAutomationDefinitionDetailWithCurrentEventStatus(
                automation,
                accountCurrentness,
            ));
        } catch (error) {
            if (error instanceof AutomationStoredContentReadError) {
                return sendStoredContentFailure(reply);
            }
            if (error instanceof AutomationTriggerMutationConflictError) {
                return reply.code(409).send({ error: "automation_trigger_revision_conflict" });
            }
            if (!isAutomationDefinitionValidationError(error)) throw error;
            return reply.code(400).send({ error: automationDefinitionValidationMessage(error) });
        }
    });

    app.delete("/v3/automations/:id/triggers", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ id: z.string() }),
            body: AutomationTriggerDeleteRequestSchema,
        },
    }, async (request, reply) => {
        const accountCurrentness = await getCurrentAutomationAccountCurrentness(request.userId);
        if (!accountCurrentness) return sendStoredContentFailure(reply);
        try {
            const body = AutomationTriggerDeleteRequestSchema.parse(request.body);
            const automation = await deleteAutomationTrigger({
                accountId: request.userId,
                automationId: request.params.id,
                triggerId: body.triggerId,
                expectedRevision: body.expectedRevision,
            });
            if (!automation) return reply.code(404).send({ error: "automation_not_found" });
            return reply.send(await toAutomationDefinitionDetailWithCurrentEventStatus(
                automation,
                accountCurrentness,
            ));
        } catch (error) {
            if (error instanceof AutomationStoredContentReadError) {
                return sendStoredContentFailure(reply);
            }
            if (error instanceof AutomationTriggerMutationConflictError) {
                return reply.code(409).send({ error: "automation_trigger_revision_conflict" });
            }
            if (!isAutomationDefinitionValidationError(error)) throw error;
            return reply.code(400).send({ error: automationDefinitionValidationMessage(error) });
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
        return reply.send(AutomationDeleteResponseSchema.parse({ ok: true }));
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
        return reply.send(await toAutomationDefinitionDetailWithCurrentEventStatus(
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
        return reply.send(await toAutomationDefinitionDetailWithCurrentEventStatus(
            automation,
            accountCurrentness,
        ));
    });

    app.post("/v3/automations/:id/assignments", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ id: z.string() }),
            body: AutomationAssignmentUpdateRequestSchema,
        },
    }, async (request, reply) => {
        const accountCurrentness = await getCurrentAutomationAccountCurrentness(request.userId);
        if (!accountCurrentness) return sendStoredContentFailure(reply);
        try {
            const body = AutomationAssignmentUpdateRequestSchema.parse(request.body);
            const automation = await updateAutomation({
                accountId: request.userId,
                automationId: request.params.id,
                input: { assignments: body.assignments },
            });
            if (!automation) return reply.code(404).send({ error: "automation_not_found" });
            return reply.send(await toAutomationDefinitionDetailWithCurrentEventStatus(
                automation,
                accountCurrentness,
            ));
        } catch (error) {
            if (!isAutomationDefinitionValidationError(error)) throw error;
            return reply.code(400).send({ error: automationDefinitionValidationMessage(error) });
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
            if (!isAutomationDefinitionValidationError(error)) throw error;
            return reply.code(400).send({ error: automationDefinitionValidationMessage(error) });
        }
    });

    app.get("/v3/automations/worker/assignments", {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({ machineId: z.string().trim().min(1) }),
        },
    }, async (request, reply) => {
        if (!await resolveExactAutomationWorkerPublisher({
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
        const publisher = await resolveExactAutomationWorkerPublisher({
            dependencies: workerPublisherDependencies,
            accountId: request.userId,
            request,
            path: "/v3/automations/runs/claim",
            machineId: body.machineId,
        });
        if (!publisher || publisher.kind !== "publisherProof") {
            return reply.code(401).send(null);
        }
        const result = await claimAutomationRun({
            accountId: request.userId,
            machineId: body.machineId,
            leaseDurationMs: body.leaseDurationMs ?? 30_000,
            claimRequest: {
                machineInstallationId: publisher.machineInstallationId,
                nonce: publisher.requestNonce,
                expiresAt: publisher.proofExpiresAt,
            },
        });
        return toAutomationV3WorkerClaimResponse(result, request.userId);
    });

    app.post("/v3/automations/runs/:runId/heartbeat", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ runId: z.string() }),
            body: AutomationV3WorkerHeartbeatRequestSchema,
        },
    }, async (request, reply) => {
        const body = AutomationV3WorkerHeartbeatRequestSchema.parse(request.body);
        if (!await resolveExactAutomationWorkerPublisher({
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
        if (!await resolveExactAutomationWorkerPublisher({
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
            run: await toCurrentAutomationRunListDto(request.userId, started.run),
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
        if (!await resolveExactAutomationWorkerPublisher({
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
            run: await toCurrentAutomationRunListDto(request.userId, run),
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
        if (!await resolveExactAutomationWorkerPublisher({
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
            run: await toCurrentAutomationRunListDto(request.userId, run),
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
        if (!await resolveExactAutomationWorkerPublisher({
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
            run: await toCurrentAutomationRunListDto(request.userId, run),
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
            run: await toCurrentAutomationRunListDto(request.userId, run),
        }));
    });

    app.post("/v3/automations/runs/:runId/retry-reply-handoff", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: { params: z.object({ runId: z.string() }) },
    }, async (request, reply) => {
        const run = await retryBlockedAutomationReplyHandoff({
            accountId: request.userId,
            runId: request.params.runId,
        });
        if (!run) return reply.code(404).send({ error: "automation_reply_handoff_not_retryable" });
        return reply.send(AutomationV3RunMutationResponseSchema.parse({
            run: await toCurrentAutomationRunListDto(request.userId, run),
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
            return reply.send(await toAutomationDefinitionDetailWithCurrentEventStatus(
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
                limit: z.coerce.number().int().min(1).max(AUTOMATION_V3_RUN_LIST_MAX_ITEMS).optional(),
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
