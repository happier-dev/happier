import { z } from "zod";
import { AutomationAccountCurrentnessWitnessV1Schema, EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from "@happier-dev/protocol";
import {
    isWorkflowRunExecutorStorageOperationV1,
    WorkflowInvocationLifecycleV1Schema,
    WorkflowRunListRequestV1Schema,
    WorkflowRunSummariesRequestV1Schema,
    WorkflowDefinitionIdV1Schema,
    WorkflowInvocationRecordIdSchema,
    WorkflowRunDirectOriginV1Schema,
    WorkflowRunStateV1Schema,
    WorkflowRunRecipientCensusInputV1Schema,
    WorkflowRunRecipientKeyEnvelopeCommitInputV1Schema,
    WorkflowRunRecipientKeyEnvelopesV1Schema,
    WorkflowRunWaitConditionsV1Schema,
} from "@happier-dev/protocol/workflows";

import {
    admitWorkflowRun,
    admitWorkflowInvocations,
    commitWorkflowInvocationFact,
    publishWorkflowInvocationDraft,
    completeWorkflowInvocationReview,
    deleteWorkflowRun,
    getWorkflowRun,
    getWorkflowRunInvocation,
    getCurrentWorkflowRunInvocation,
    initializeWorkflowRunExecution,
    listWorkflowRunInvocations,
    listWorkflowRunsForRecovery,
    listWorkflowRuns,
    summarizeWorkflowRuns,
    pauseWorkflowRun,
    resumeWorkflowRunBoundary,
    cancelWorkflowRun,
    waitWorkflowRun,
    recoverWorkflowInvocations,
    resolveAutomationWorkflowAcceptedSnapshot,
    pullWorkflowRunOriginDelivery,
    ackWorkflowRunOriginDelivery,
    recordWorkflowRunOriginInputWithdrawn,
    transitionWorkflowRun,
    WorkflowRunServiceError,
} from "@/app/workflows/workflowRunService";
import { WorkflowStoredContentError } from "@/app/workflows/runs/storedContent";
import { inTx } from "@/storage/inTx";
import { readWorkflowRunRecipientCensusInTx, commitWorkflowRunRecipientKeyEnvelopesInTx, WorkflowRunAccessError } from "@/app/workflows/workflowRunAccess";
import { readTeamOperationAuthenticationFromRequest } from "@/app/teams/actorContext";

import type { Fastify } from "../../types";
import { isRestrictedAuthTokenKind } from "../../utils/apiTokenRouteAdmission";
import {
    DEFAULT_AUTOMATION_WORKER_PUBLISHER_DEPENDENCIES,
    resolveExactAutomationWorkerPublisher,
    type AutomationWorkerPublisherDependencies,
} from "./automationWorkerPublisher";

const PATH = "/v3/automations/runs/workflow-storage";
const PageByteLimitSchema = z.number().int().positive().max(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES).safe();
const InvocationContentWriteShape = {
    publisherMachineId: z.string().min(1).optional(), runId: z.string().min(1), invocationId: z.string().min(1),
    invocationAttempt: z.string().regex(/^(0|[1-9][0-9]*)$/),
    expectedContentRevision: z.string().regex(/^(0|[1-9][0-9]*)$/),
    accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema, contentEnvelope: z.string().min(1),
};
const InvocationFactOperationSchema = z.object({
    operation: z.literal("invocations.fact"), publisherMachineId: z.string().min(1), runId: z.string().min(1),
    parentAttempt: z.number().int().nonnegative().safe().optional(),
    expectedRevision: z.number().int().nonnegative().safe().optional(),
    accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema, invocationId: z.string().min(1),
    invocationAttempt: z.string().regex(/^(0|[1-9][0-9]*)$/),
    expectedContentRevision: z.string().regex(/^(0|[1-9][0-9]*)$/),
    expectedLifecycle: WorkflowInvocationLifecycleV1Schema, lifecycle: WorkflowInvocationLifecycleV1Schema,
    contentEnvelope: z.string().min(1), resolution: z.enum(["observed_terminal_execution", "root_list_progress"]).optional(),
}).strict().superRefine((value, context) => {
    const observation = value.expectedRevision !== undefined;
    if (observation
        ? value.parentAttempt !== undefined || value.resolution === undefined
        : value.parentAttempt === undefined || value.resolution === "root_list_progress") {
        context.addIssue({ code: "custom", message: "Invocation facts require one exact worker attempt or terminal observation revision" });
    }
});
const OperationSchema = z.discriminatedUnion("operation", [
    WorkflowRunRecipientCensusInputV1Schema.extend({ operation: z.literal("run-key.census"), publisherMachineId: z.string().min(1).optional() }).strict(),
    WorkflowRunRecipientKeyEnvelopeCommitInputV1Schema.extend({ operation: z.literal("run-key.commit"), publisherMachineId: z.string().min(1).optional() }).strict(),
    z.object({ operation: z.literal("admit"), publisherMachineId: z.string().min(1), runId: z.string().min(1), origin: WorkflowRunDirectOriginV1Schema, machineId: z.string().min(1), sourceArtifactId: WorkflowDefinitionIdV1Schema.nullable().optional(), visibleTeamId: z.string().min(1).nullable().optional(), recipientKeyEnvelopes: WorkflowRunRecipientKeyEnvelopesV1Schema.optional(), accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema, acceptedEnvelope: z.string().min(1), resultDelivery: z.object({ kind: z.literal("originating_session") }).strict().optional() }).strict(),
    z.object({ operation: z.literal("initialize"), publisherMachineId: z.string().min(1), runId: z.string().min(1), parentAttempt: z.number().int().nonnegative().safe(), expectedRevision: z.number().int().nonnegative(), accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema, checkpointEnvelope: z.string().min(1), rootInvocation: z.object({ id: z.string().min(1), contentEnvelope: z.string().min(1) }).strict() }).strict(),
    z.object({ operation: z.literal("accepted-snapshot.resolve"), publisherMachineId: z.string().min(1), runId: z.string().min(1), automationId: z.string().min(1), originSessionId: z.string().min(1).optional(), resultDelivery: z.object({ kind: z.literal("originating_session") }).strict().optional(), sourceArtifactId: WorkflowDefinitionIdV1Schema.nullable().optional(), visibleTeamId: z.string().min(1).nullable().optional(), recipientKeyEnvelopes: WorkflowRunRecipientKeyEnvelopesV1Schema.optional(), expectedAttempt: z.number().int().nonnegative(), expectedRevision: z.number().int().nonnegative(), accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema, definitionEnvelope: z.string().min(1), acceptedEnvelope: z.string().min(1) }).strict(),
    z.object({ operation: z.literal("get"), publisherMachineId: z.string().min(1).optional(), runId: z.string().min(1) }).strict(),
    z.object({ operation: z.literal("wait"), publisherMachineId: z.string().min(1).optional(), runId: z.string().min(1), conditions: WorkflowRunWaitConditionsV1Schema.optional(), timeoutSeconds: z.literal(0).optional(), afterRevision: z.number().int().nonnegative().safe().optional() }).strict(),
    z.object({ operation: z.enum(["pause", "resume", "cancel"]), publisherMachineId: z.string().min(1).optional(), runId: z.string().min(1), expectedRevision: z.number().int().nonnegative() }).strict(),
    z.object({ operation: z.literal("list"), publisherMachineId: z.string().min(1).optional(), request: WorkflowRunListRequestV1Schema, pageByteLimit: PageByteLimitSchema }).strict(),
    z.object({ operation: z.literal("summaries"), publisherMachineId: z.string().min(1).optional(), request: WorkflowRunSummariesRequestV1Schema, pageByteLimit: PageByteLimitSchema }).strict(),
    z.object({ operation: z.literal("delivery.pull"), publisherMachineId: z.string().min(1).optional(), originSessionId: z.string().min(1), cursor: z.string().optional(), limit: z.number().int().positive().safe().optional(), pageByteLimit: PageByteLimitSchema }).strict(),
    z.object({ operation: z.literal("delivery.ack"), publisherMachineId: z.string().min(1).optional(), runId: z.string().min(1), revision: z.number().int().nonnegative().safe() }).strict(),
    z.object({ operation: z.literal("origin-input.withdrawn"), publisherMachineId: z.string().min(1).optional(), originSessionId: z.string().min(1), runId: z.string().min(1), invocationRecordId: z.string().min(1), expectedRevision: z.number().int().nonnegative().safe(), accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema }).strict(),
    z.object({ operation: z.literal("recovery.list"), publisherMachineId: z.string().min(1), cursor: z.string().optional(), limit: z.number().int().positive().safe().optional(), pageByteLimit: PageByteLimitSchema }).strict(),
    z.object({ operation: z.literal("invocations.list"), publisherMachineId: z.string().min(1).optional(), runId: z.string().min(1), cursor: z.string().optional(), limit: z.number().int().positive().optional(), parentRecordId: z.string().optional(), lifecycles: z.array(WorkflowInvocationLifecycleV1Schema).min(1).optional(), progressEnvelopes: z.literal(true).optional(), pageByteLimit: PageByteLimitSchema }).strict(),
    z.object({ operation: z.literal("invocations.admit"), publisherMachineId: z.string().min(1), runId: z.string().min(1), parentAttempt: z.number().int().nonnegative().safe(), expectedRevision: z.number().int().nonnegative(), accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema, checkpointEnvelope: z.string().min(1), invocations: z.array(z.object({ id: WorkflowInvocationRecordIdSchema, sequence: z.string().regex(/^(0|[1-9][0-9]*)$/), parentRecordId: z.string().min(1), memberOrdinal: z.string().regex(/^(0|[1-9][0-9]*)$/), lifecycle: z.enum(["pending", "waiting_for_capacity"]).optional(), contentEnvelope: z.string().min(1), replaces: z.object({ id: WorkflowInvocationRecordIdSchema, attempt: z.string().regex(/^(0|[1-9][0-9]*)$/), contentRevision: z.string().regex(/^(0|[1-9][0-9]*)$/) }).strict().optional() }).strict()).min(1) }).strict(),
    z.object({ operation: z.literal("invocations.get"), publisherMachineId: z.string().min(1).optional(), runId: z.string().min(1), invocationId: z.string().min(1) }).strict(),
    z.object({ operation: z.literal("invocations.current"), publisherMachineId: z.string().min(1).optional(), runId: z.string().min(1), parentRecordId: z.string().min(1), memberOrdinal: z.string().regex(/^(0|[1-9][0-9]*)$/) }).strict(),
    InvocationFactOperationSchema,
    z.object({ operation: z.literal("invocations.publish_draft"), ...InvocationContentWriteShape }).strict(),
    z.object({ operation: z.literal("invocations.complete_review"), ...InvocationContentWriteShape, mode: z.enum(["use_result", "generate"]) }).strict(),
    z.object({ operation: z.literal("transition"), publisherMachineId: z.string().min(1), runId: z.string().min(1), parentAttempt: z.number().int().nonnegative().safe(), expectedRevision: z.number().int().nonnegative(), accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema, state: WorkflowRunStateV1Schema, checkpointEnvelope: z.string().min(1), resultEnvelope: z.string().nullable().optional(), custodyState: z.enum(["pending", "settled"]).optional(), invocationTransitions: z.array(z.object({ id: z.string().min(1), expectedLifecycle: WorkflowInvocationLifecycleV1Schema, lifecycle: WorkflowInvocationLifecycleV1Schema, expectedContentRevision: z.string().regex(/^(0|[1-9][0-9]*)$/) }).strict()).optional() }).strict(),
    z.object({ operation: z.literal("invocations.recover"), publisherMachineId: z.string().min(1), runId: z.string().min(1), expectedRevision: z.number().int().nonnegative(), accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema, checkpointEnvelope: z.string().min(1), recoveries: z.array(z.object({ invocationId: z.string().min(1), newInvocationId: WorkflowInvocationRecordIdSchema, contentEnvelope: z.string().min(1) }).strict()).min(1) }).strict(),
    z.object({ operation: z.literal("delete"), publisherMachineId: z.string().min(1).optional(), runId: z.string().min(1), expectedRevision: z.number().int().nonnegative() }).strict(),
]);

export function registerWorkflowRunStorageRoutes(
    app: Fastify,
    dependencies: AutomationWorkerPublisherDependencies = DEFAULT_AUTOMATION_WORKER_PUBLISHER_DEPENDENCIES,
): void {
    app.post(PATH, { preHandler: app.authenticate, schema: { body: OperationSchema } }, async (request, reply) => {
        const body = request.body;
        const executorOperation = isWorkflowRunExecutorStorageOperationV1(body.operation);
        const externalAction = request.externalActionExecutionAuthorized === true;
        if (body.operation === "invocations.complete_review" && request.authAuthority !== "present_user") return reply.code(401).send(null);
        if (!executorOperation && !externalAction && isRestrictedAuthTokenKind(request.authTokenKind)) {
            return reply.code(401).send(null);
        }
        // Explicit host shapes and verified external Actions retain exact publisher proof.
        // Ordinary Account reads/controls have no executor Machine requirement.
        if (executorOperation || externalAction || body.publisherMachineId !== undefined) {
            if (body.publisherMachineId === undefined) return reply.code(401).send(null);
            const publisher = await resolveExactAutomationWorkerPublisher({
                dependencies,
                accountId: request.userId,
                request,
                path: PATH,
                machineId: body.publisherMachineId,
            });
            if (!publisher) return reply.code(401).send(null);
            if (body.operation === "admit" && body.machineId !== publisher.machineId) {
                return reply.code(422).send({ error: "target_unavailable" });
            }
        }
        try {
            // Carry only server-verified credential facts; the strict body cannot supply Team authority.
            const authentication = request.authAuthority ? readTeamOperationAuthenticationFromRequest(request) : undefined;
            switch (body.operation) {
                case "run-key.census": return await inTx(tx => readWorkflowRunRecipientCensusInTx(tx, { ...body, actorAccountId: request.userId, authentication }));
                case "run-key.commit": return await inTx(tx => commitWorkflowRunRecipientKeyEnvelopesInTx(tx, { ...body, actorAccountId: request.userId }));
                case "admit": return await admitWorkflowRun({ accountId: request.userId, runId: body.runId, origin: body.origin, machineId: body.machineId, sourceArtifactId: body.sourceArtifactId, visibleTeamId: body.visibleTeamId, authentication, recipientKeyEnvelopes: body.recipientKeyEnvelopes, accountCurrentness: body.accountCurrentness, acceptedEnvelope: body.acceptedEnvelope, ...(body.resultDelivery ? { resultDelivery: body.resultDelivery } : {}) });
                case "initialize": return await initializeWorkflowRunExecution({ accountId: request.userId, runId: body.runId, machineId: body.publisherMachineId, parentAttempt: body.parentAttempt, expectedRevision: body.expectedRevision, accountCurrentness: body.accountCurrentness, checkpointEnvelope: body.checkpointEnvelope, rootInvocation: body.rootInvocation });
                case "accepted-snapshot.resolve": return await resolveAutomationWorkflowAcceptedSnapshot({ accountId: request.userId, runId: body.runId, automationId: body.automationId, machineId: body.publisherMachineId, originSessionId: body.originSessionId, resultDelivery: body.resultDelivery, sourceArtifactId: body.sourceArtifactId, visibleTeamId: body.visibleTeamId, authentication, recipientKeyEnvelopes: body.recipientKeyEnvelopes, expectedAttempt: body.expectedAttempt, expectedRevision: body.expectedRevision, accountCurrentness: body.accountCurrentness, definitionEnvelope: body.definitionEnvelope, acceptedEnvelope: body.acceptedEnvelope });
                case "get": return await getWorkflowRun({ accountId: request.userId, runId: body.runId });
                case "wait": {
                    const controller = new AbortController();
                    const abort = () => controller.abort(new Error("workflow_wait_caller_aborted"));
                    request.raw.once("aborted", abort);
                    reply.raw.once("close", abort);
                    try {
                        return await waitWorkflowRun({
                            accountId: request.userId,
                            runId: body.runId,
                            ...(body.conditions === undefined ? {} : { conditions: body.conditions }),
                            ...(body.timeoutSeconds === undefined ? {} : { timeoutSeconds: body.timeoutSeconds }),
                            ...(body.afterRevision === undefined ? {} : { afterRevision: body.afterRevision }),
                            signal: controller.signal,
                        });
                    } finally {
                        request.raw.off("aborted", abort);
                        reply.raw.off("close", abort);
                    }
                }
                case "pause": return await pauseWorkflowRun({ accountId: request.userId, runId: body.runId, expectedRevision: body.expectedRevision });
                case "resume": return await resumeWorkflowRunBoundary({ accountId: request.userId, runId: body.runId, expectedRevision: body.expectedRevision });
                case "cancel": return await cancelWorkflowRun({ accountId: request.userId, runId: body.runId, expectedRevision: body.expectedRevision });
                case "list": return await listWorkflowRuns({ accountId: request.userId, ...body.request, pageByteLimit: body.pageByteLimit });
                case "summaries": return await summarizeWorkflowRuns({ accountId: request.userId, ...body.request, pageByteLimit: body.pageByteLimit });
                case "delivery.pull": return await pullWorkflowRunOriginDelivery({ accountId: request.userId, originSessionId: body.originSessionId, ...(body.cursor ? { cursor: body.cursor } : {}), ...(body.limit ? { limit: body.limit } : {}), pageByteLimit: body.pageByteLimit });
                case "delivery.ack": return await ackWorkflowRunOriginDelivery({ accountId: request.userId, runId: body.runId, revision: body.revision });
                case "origin-input.withdrawn": return await recordWorkflowRunOriginInputWithdrawn({ accountId: request.userId, originSessionId: body.originSessionId, runId: body.runId, invocationRecordId: body.invocationRecordId, expectedRevision: body.expectedRevision, accountCurrentness: body.accountCurrentness });
                case "recovery.list": return await listWorkflowRunsForRecovery({ accountId: request.userId, machineId: body.publisherMachineId, ...(body.cursor ? { cursor: body.cursor } : {}), ...(body.limit ? { limit: body.limit } : {}), pageByteLimit: body.pageByteLimit });
                case "invocations.list": return await listWorkflowRunInvocations({ accountId: request.userId, runId: body.runId, ...(body.cursor ? { cursor: body.cursor } : {}), ...(body.limit ? { limit: body.limit } : {}), ...(body.parentRecordId ? { parentRecordId: body.parentRecordId } : {}), ...(body.lifecycles ? { lifecycles: body.lifecycles } : {}), ...(body.progressEnvelopes ? { progressEnvelopes: body.progressEnvelopes } : {}), pageByteLimit: body.pageByteLimit });
                case "invocations.admit": return await admitWorkflowInvocations({ accountId: request.userId, runId: body.runId, machineId: body.publisherMachineId, parentAttempt: body.parentAttempt, expectedRevision: body.expectedRevision, accountCurrentness: body.accountCurrentness, checkpointEnvelope: body.checkpointEnvelope, invocations: body.invocations.map((item) => ({ id: item.id, sequence: BigInt(item.sequence), parentRecordId: item.parentRecordId, memberOrdinal: BigInt(item.memberOrdinal), ...(item.lifecycle ? { lifecycle: item.lifecycle } : {}), contentEnvelope: item.contentEnvelope, ...(item.replaces ? { replaces: { id: item.replaces.id, attempt: BigInt(item.replaces.attempt), contentRevision: BigInt(item.replaces.contentRevision) } } : {}) })) });
                case "invocations.get": return await getWorkflowRunInvocation({ accountId: request.userId, runId: body.runId, invocationId: body.invocationId });
                case "invocations.current": return await getCurrentWorkflowRunInvocation({ accountId: request.userId, runId: body.runId, parentRecordId: body.parentRecordId, memberOrdinal: BigInt(body.memberOrdinal) });
                case "invocations.fact": {
                    const fact = { accountId: request.userId, runId: body.runId, machineId: body.publisherMachineId,
                        accountCurrentness: body.accountCurrentness, invocationId: body.invocationId,
                        invocationAttempt: BigInt(body.invocationAttempt), expectedContentRevision: BigInt(body.expectedContentRevision), expectedLifecycle: body.expectedLifecycle,
                        lifecycle: body.lifecycle, contentEnvelope: body.contentEnvelope };
                    if (body.expectedRevision !== undefined && body.resolution !== undefined) {
                        return await commitWorkflowInvocationFact({ ...fact, expectedRevision: body.expectedRevision, resolution: body.resolution });
                    }
                    if (body.parentAttempt === undefined || body.resolution === "root_list_progress") throw new WorkflowRunServiceError("invalid_input");
                    return await commitWorkflowInvocationFact({ ...fact, parentAttempt: body.parentAttempt, ...(body.resolution ? { resolution: body.resolution } : {}) });
                }
                case "invocations.publish_draft": return await publishWorkflowInvocationDraft({ ...body, accountId: request.userId, invocationAttempt: BigInt(body.invocationAttempt), expectedContentRevision: BigInt(body.expectedContentRevision) });
                case "invocations.complete_review": return await completeWorkflowInvocationReview({ ...body, accountId: request.userId, invocationAttempt: BigInt(body.invocationAttempt), expectedContentRevision: BigInt(body.expectedContentRevision) });
                case "transition": return await transitionWorkflowRun({ accountId: request.userId, runId: body.runId, machineId: body.publisherMachineId, parentAttempt: body.parentAttempt, expectedRevision: body.expectedRevision, accountCurrentness: body.accountCurrentness, state: body.state, checkpointEnvelope: body.checkpointEnvelope, ...(body.resultEnvelope !== undefined ? { resultEnvelope: body.resultEnvelope } : {}), ...(body.custodyState ? { custodyState: body.custodyState } : {}), ...(body.invocationTransitions ? { invocationTransitions: body.invocationTransitions.map((item) => ({ ...item, expectedContentRevision: BigInt(item.expectedContentRevision) })) } : {}) });
                case "invocations.recover": return await recoverWorkflowInvocations({ accountId: request.userId, runId: body.runId, machineId: body.publisherMachineId, expectedRevision: body.expectedRevision, accountCurrentness: body.accountCurrentness, checkpointEnvelope: body.checkpointEnvelope, recoveries: body.recoveries.map((item) => ({ invocationId: item.invocationId, newInvocationId: item.newInvocationId, contentEnvelope: item.contentEnvelope })) });
                case "delete": return await deleteWorkflowRun({ accountId: request.userId, runId: body.runId, expectedRevision: body.expectedRevision });
            }
        } catch (error) {
            if (error instanceof WorkflowRunAccessError) {
                return reply.code(error.code === "run_not_found" ? 404 : error.code === "run_access_denied" ? 403 : error.code === "currentness_conflict" ? 409 : 422).send({ error: error.code });
            }
            if (error instanceof WorkflowStoredContentError) return reply.code(422).send({ error: error.code });
            if (!(error instanceof WorkflowRunServiceError)) throw error;
            const status = error.code === "run_not_found" ? 404 : error.code === "run_access_denied" ? 403 : error.code === "currentness_conflict" ? 409 : 422;
            return reply.code(status).send({ error: error.code });
        }
    });
}
