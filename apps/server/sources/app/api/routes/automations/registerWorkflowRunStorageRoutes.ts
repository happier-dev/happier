import { z } from "zod/mini";
import { extend } from "zod/mini";
import { AutomationAccountCurrentnessWitnessV1Schema } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/protocol/actions/externalActionLimits';
import { isWorkflowRunExecutorStorageOperationV1 } from '@happier-dev/protocol/workflows/workflowRunStorageV1';
import { WorkflowInvocationLifecycleV1Schema, WorkflowRunDirectOriginV1Schema, WorkflowRunStateV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { WorkflowRunListRequestV1Schema, WorkflowRunSummariesRequestV1Schema, WorkflowRunWaitConditionsV1Schema, WorkflowRunReadStateSetRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { WorkflowDefinitionIdV1Schema, WorkflowInvocationRecordIdSchema } from '@happier-dev/protocol/workflows/workflowIdsV1';
import { WorkflowRunRecipientCensusInputV1Schema, WorkflowRunRecipientKeyEnvelopeCommitInputV1Schema, WorkflowRunRecipientKeyEnvelopesV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { WorkflowRunOnCompleteV1Schema } from '@happier-dev/protocol/workflows/workflowDestinationsV1';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';

import {
    admitWorkflowRun,
    admitWorkflowInvocations,
    commitWorkflowInvocationFact,
    publishWorkflowInvocationDraft,
    completeWorkflowInvocationReview,
    deleteWorkflowRun,
    getWorkflowRun,
    setWorkflowRunReadState,
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
    recordWorkflowRequesterCustodyUnavailable,
} from "@/app/workflows/workflowRunService";
import { WorkflowStoredContentError } from "@/app/workflows/runs/storedContent";
import { inTx, isTransactionAcquisitionUnavailableError, isTransactionConflictExhaustedError, isTransactionDeadlineExceededError } from "@/storage/inTx";
import { getActivePrismaRuntime } from "@/storage/prisma";
import { log } from "@/utils/logging/log";
import { readWorkflowRunRecipientCensusInTx, commitWorkflowRunRecipientKeyEnvelopesInTx, WorkflowRunAccessError } from "@/app/workflows/workflowRunAccess";
import { readTeamOperationAuthenticationFromRequest } from "@/app/teams/actorContext";

import type { Fastify } from "../../types";
import { isRestrictedAuthTokenKind } from "../../utils/apiTokenRouteAdmission";
import {
    DEFAULT_AUTOMATION_WORKER_PUBLISHER_DEPENDENCIES,
    resolveWorkflowAutomationWorkerPublisher,
    type AutomationWorkerPublisherDependencies,
} from "./automationWorkerPublisher";

const PATH = "/v3/automations/runs/workflow-storage";
const PageByteLimitSchema = z.number().check(z.int(), z.positive(), z.maximum(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES), z.int());
const InvocationContentWriteShape = {
    publisherMachineId: z.optional(z.string().check(z.minLength(1))), runId: z.string().check(z.minLength(1)), invocationId: z.string().check(z.minLength(1)),
    invocationAttempt: z.string().check(z.regex(/^(0|[1-9][0-9]*)$/)),
    expectedContentRevision: z.string().check(z.regex(/^(0|[1-9][0-9]*)$/)),
    accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema, contentEnvelope: z.string().check(z.minLength(1)),
};
const InvocationFactOperationSchema = z.strictObject({
    operation: z.literal("invocations.fact"), publisherMachineId: z.string().check(z.minLength(1)), runId: z.string().check(z.minLength(1)),
    parentAttempt: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
    expectedRevision: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
    accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema, invocationId: z.string().check(z.minLength(1)),
    invocationAttempt: z.string().check(z.regex(/^(0|[1-9][0-9]*)$/)),
    expectedContentRevision: z.string().check(z.regex(/^(0|[1-9][0-9]*)$/)),
    expectedLifecycle: WorkflowInvocationLifecycleV1Schema, lifecycle: WorkflowInvocationLifecycleV1Schema,
    contentEnvelope: z.string().check(z.minLength(1)), resolution: z.optional(z.enum(["observed_terminal_execution", "root_list_progress"])),
}).check(z.superRefine((value, context) => {
    const observation = value.expectedRevision !== undefined;
    if (observation
        ? value.parentAttempt !== undefined || value.resolution === undefined
        : value.parentAttempt === undefined || value.resolution === "root_list_progress") {
        context.addIssue({ code: "custom", message: "Invocation facts require one exact worker attempt or terminal observation revision" });
    }
}));
const OperationSchema = z.discriminatedUnion("operation", [
    extend(WorkflowRunReadStateSetRequestV1Schema, { operation: z.literal("read_state.set") }),
    extend(WorkflowRunRecipientCensusInputV1Schema, { operation: z.literal("run-key.census"), publisherMachineId: z.optional(z.string().check(z.minLength(1))) }),
    extend(WorkflowRunRecipientKeyEnvelopeCommitInputV1Schema, { operation: z.literal("run-key.commit"), publisherMachineId: z.optional(z.string().check(z.minLength(1))) }),
    z.strictObject({ operation: z.literal("admit"), publisherMachineId: z.string().check(z.minLength(1)), runId: z.string().check(z.minLength(1)), origin: WorkflowRunDirectOriginV1Schema, machineId: z.string().check(z.minLength(1)), sourceArtifactId: z.optional(z.nullable(WorkflowDefinitionIdV1Schema)), visibleTeamId: z.optional(z.nullable(z.string().check(z.minLength(1)))), recipientKeyEnvelopes: z.optional(WorkflowRunRecipientKeyEnvelopesV1Schema), accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema, acceptedEnvelope: z.string().check(z.minLength(1)), resultDelivery: z.optional(WorkflowRunOnCompleteV1Schema), discussionTargetSessionIds: z.optional(z.array(z.string().check(z.minLength(1)))) }),
    z.strictObject({ operation: z.literal("initialize"), publisherMachineId: z.string().check(z.minLength(1)), runId: z.string().check(z.minLength(1)), parentAttempt: z.number().check(z.int(), z.nonnegative(), z.int()), expectedRevision: z.number().check(z.int(), z.nonnegative()), accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema, checkpointEnvelope: z.string().check(z.minLength(1)), rootInvocation: z.strictObject({ id: z.string().check(z.minLength(1)), contentEnvelope: z.string().check(z.minLength(1)) }) }),
    z.strictObject({ operation: z.literal("accepted-snapshot.resolve"), publisherMachineId: z.string().check(z.minLength(1)), runId: z.string().check(z.minLength(1)), automationId: z.string().check(z.minLength(1)), originSessionId: z.optional(z.string().check(z.minLength(1))), resultDelivery: z.optional(z.strictObject({ kind: z.literal("originating_session") })), sourceArtifactId: z.optional(z.nullable(WorkflowDefinitionIdV1Schema)), visibleTeamId: z.optional(z.nullable(z.string().check(z.minLength(1)))), recipientKeyEnvelopes: z.optional(WorkflowRunRecipientKeyEnvelopesV1Schema), expectedAttempt: z.number().check(z.int(), z.nonnegative()), expectedRevision: z.number().check(z.int(), z.nonnegative()), accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema, definitionEnvelope: z.string().check(z.minLength(1)), acceptedEnvelope: z.string().check(z.minLength(1)) }),
    z.strictObject({ operation: z.literal("get"), publisherMachineId: z.optional(z.string().check(z.minLength(1))), runId: z.string().check(z.minLength(1)) }),
    z.strictObject({ operation: z.literal("wait"), publisherMachineId: z.optional(z.string().check(z.minLength(1))), runId: z.string().check(z.minLength(1)), conditions: z.optional(WorkflowRunWaitConditionsV1Schema), timeoutSeconds: z.optional(z.literal(0)), afterRevision: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())) }),
    z.strictObject({ operation: z.enum(["pause", "resume", "cancel"]), publisherMachineId: z.optional(z.string().check(z.minLength(1))), runId: z.string().check(z.minLength(1)), expectedRevision: z.number().check(z.int(), z.nonnegative()) }),
    z.strictObject({ operation: z.literal("list"), publisherMachineId: z.optional(z.string().check(z.minLength(1))), request: WorkflowRunListRequestV1Schema, pageByteLimit: PageByteLimitSchema }),
    z.strictObject({ operation: z.literal("summaries"), publisherMachineId: z.optional(z.string().check(z.minLength(1))), request: WorkflowRunSummariesRequestV1Schema, pageByteLimit: PageByteLimitSchema }),
    z.strictObject({ operation: z.literal("delivery.pull"), publisherMachineId: z.optional(z.string().check(z.minLength(1))), originSessionId: z.string().check(z.minLength(1)), cursor: z.optional(z.string()), limit: z.optional(z.number().check(z.int(), z.positive(), z.int())), pageByteLimit: PageByteLimitSchema }),
    z.strictObject({ operation: z.literal("delivery.ack"), publisherMachineId: z.optional(z.string().check(z.minLength(1))), runId: z.string().check(z.minLength(1)), revision: z.number().check(z.int(), z.nonnegative(), z.int()) }),
    z.strictObject({ operation: z.literal("origin-input.withdrawn"), publisherMachineId: z.optional(z.string().check(z.minLength(1))), originSessionId: z.string().check(z.minLength(1)), runId: z.string().check(z.minLength(1)), invocationRecordId: z.string().check(z.minLength(1)), expectedRevision: z.number().check(z.int(), z.nonnegative(), z.int()), accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema }),
    z.strictObject({ operation: z.literal("recovery.list"), publisherMachineId: z.string().check(z.minLength(1)), cursor: z.optional(z.string()), limit: z.optional(z.number().check(z.int(), z.positive(), z.int())), pageByteLimit: PageByteLimitSchema }),
    z.strictObject({ operation: z.literal("invocations.list"), publisherMachineId: z.optional(z.string().check(z.minLength(1))), runId: z.string().check(z.minLength(1)), cursor: z.optional(z.string()), limit: z.optional(z.number().check(z.int(), z.positive())), invocationId: z.optional(WorkflowInvocationRecordIdSchema), parentRecordId: z.optional(z.nullable(z.string())), parentRecordIds: z.optional(z.array(WorkflowInvocationRecordIdSchema).check(z.minLength(1))), memberOrdinal: z.optional(z.string().check(z.regex(/^(0|[1-9][0-9]*)$/))), lifecycles: z.optional(z.array(WorkflowInvocationLifecycleV1Schema).check(z.minLength(1))), progressEnvelopes: z.optional(z.literal(true)), pageByteLimit: PageByteLimitSchema }).check(z.superRefine((value, context) => {
        if (value.invocationId !== undefined && (value.parentRecordId !== undefined || value.parentRecordIds !== undefined || value.memberOrdinal !== undefined || value.lifecycles !== undefined)) {
            context.addIssue({ code: "custom", path: ["invocationId"], message: "An exact invocation cannot select a parent window or lifecycle" });
        }
        if (value.memberOrdinal !== undefined && value.parentRecordId === undefined) {
            context.addIssue({ code: "custom", path: ["memberOrdinal"], message: "A member slot requires its parent" });
        }
        if (value.parentRecordIds !== undefined && (value.parentRecordId !== undefined || value.memberOrdinal !== undefined)) {
            context.addIssue({ code: "custom", path: ["parentRecordIds"], message: "A parent set selects histories, not one newest-member window" });
        }
    })),
    z.strictObject({ operation: z.literal("invocations.admit"), publisherMachineId: z.string().check(z.minLength(1)), runId: z.string().check(z.minLength(1)), parentAttempt: z.number().check(z.int(), z.nonnegative(), z.int()), expectedRevision: z.number().check(z.int(), z.nonnegative()), accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema, checkpointEnvelope: z.string().check(z.minLength(1)), invocations: z.array(z.strictObject({ id: WorkflowInvocationRecordIdSchema, sequence: z.string().check(z.regex(/^(0|[1-9][0-9]*)$/)), parentRecordId: z.string().check(z.minLength(1)), memberOrdinal: z.string().check(z.regex(/^(0|[1-9][0-9]*)$/)), lifecycle: z.optional(z.enum(["pending", "waiting_for_capacity"])), contentEnvelope: z.string().check(z.minLength(1)), replaces: z.optional(z.strictObject({ id: WorkflowInvocationRecordIdSchema, attempt: z.string().check(z.regex(/^(0|[1-9][0-9]*)$/)), contentRevision: z.string().check(z.regex(/^(0|[1-9][0-9]*)$/)) })) })).check(z.minLength(1)) }),
    z.strictObject({ operation: z.literal("invocations.get"), publisherMachineId: z.optional(z.string().check(z.minLength(1))), runId: z.string().check(z.minLength(1)), invocationId: z.string().check(z.minLength(1)) }),
    z.strictObject({ operation: z.literal("invocations.current"), publisherMachineId: z.optional(z.string().check(z.minLength(1))), runId: z.string().check(z.minLength(1)), parentRecordId: z.string().check(z.minLength(1)), memberOrdinal: z.string().check(z.regex(/^(0|[1-9][0-9]*)$/)) }),
    InvocationFactOperationSchema,
    z.strictObject({ operation: z.literal("invocations.publish_draft"), ...InvocationContentWriteShape }),
    z.strictObject({ operation: z.literal("invocations.complete_review"), ...InvocationContentWriteShape, mode: z.enum(["use_result", "generate"]) }),
    z.strictObject({ operation: z.literal("transition"), publisherMachineId: z.string().check(z.minLength(1)), runId: z.string().check(z.minLength(1)), parentAttempt: z.number().check(z.int(), z.nonnegative(), z.int()), expectedRevision: z.number().check(z.int(), z.nonnegative()), accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema, state: WorkflowRunStateV1Schema, checkpointEnvelope: z.string().check(z.minLength(1)), resultEnvelope: z.optional(z.nullable(z.string())), custodyState: z.optional(z.enum(["pending", "settled"])), invocationTransitions: z.optional(z.array(z.strictObject({ id: z.string().check(z.minLength(1)), expectedLifecycle: WorkflowInvocationLifecycleV1Schema, lifecycle: WorkflowInvocationLifecycleV1Schema, expectedContentRevision: z.string().check(z.regex(/^(0|[1-9][0-9]*)$/)) }))) }),
    z.strictObject({ operation: z.literal("invocations.recover"), publisherMachineId: z.string().check(z.minLength(1)), runId: z.string().check(z.minLength(1)), expectedRevision: z.number().check(z.int(), z.nonnegative()), accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema, checkpointEnvelope: z.string().check(z.minLength(1)), recoveries: z.array(z.strictObject({ invocationId: z.string().check(z.minLength(1)), newInvocationId: WorkflowInvocationRecordIdSchema, contentEnvelope: z.string().check(z.minLength(1)) })).check(z.minLength(1)) }),
    z.strictObject({ operation: z.literal("delete"), publisherMachineId: z.optional(z.string().check(z.minLength(1))), runId: z.string().check(z.minLength(1)), expectedRevision: z.number().check(z.int(), z.nonnegative()) }),
]);

export function registerWorkflowRunStorageRoutes(
    app: Fastify,
    dependencies: AutomationWorkerPublisherDependencies = DEFAULT_AUTOMATION_WORKER_PUBLISHER_DEPENDENCIES,
): void {
    app.post('/v3/automations/runs/:runId/requester-custody-unavailable', {
        preHandler: app.authenticate,
        schema: { params: z.strictObject({ runId: z.string().check(z.minLength(1)) }),
            body: z.strictObject({ machineId: z.string().check(z.minLength(1)) }) },
    }, async (request, reply) => {
        const publisher = await resolveWorkflowAutomationWorkerPublisher({ dependencies,
            accountId: request.userId, request,
            path: `/v3/automations/runs/${encodeURIComponent(request.params.runId)}/requester-custody-unavailable`,
            machineId: request.body.machineId, runId: request.params.runId, purpose: 'custody_refusal' });
        if (!publisher) return reply.code(401).send(null);
        await recordWorkflowRequesterCustodyUnavailable({ runId: request.params.runId,
            machineId: publisher.machineId, installationId: publisher.machineInstallationId });
        return { recorded: true };
    });
    app.post(PATH, { preHandler: app.authenticate, schema: { body: OperationSchema } }, async (request, reply) => {
        const body = request.body;
        const executorOperation = isWorkflowRunExecutorStorageOperationV1(body.operation);
        const publisherMachineId = 'publisherMachineId' in body ? body.publisherMachineId : undefined;
        const externalAction = request.externalActionExecutionAuthorized === true;
        if (body.operation === "invocations.complete_review" && request.authAuthority !== "present_user") return reply.code(401).send(null);
        if (!executorOperation && !externalAction && isRestrictedAuthTokenKind(request.authTokenKind)) {
            return reply.code(401).send(null);
        }
        if (executorOperation || externalAction) {
            if (publisherMachineId === undefined) return reply.code(401).send(null);
            const publisher = await resolveWorkflowAutomationWorkerPublisher({
                dependencies,
                accountId: request.userId,
                request,
                path: PATH,
                machineId: publisherMachineId,
                ...('runId' in body && body.runId ? { runId: body.runId } : {}),
                ...(body.operation === 'admit' ? { purpose: 'admission' as const } : {}),
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
                case "run-key.census": return await inTx(tx => readWorkflowRunRecipientCensusInTx(tx, { ...body, actorAccountId: request.userId, authentication }), { transactionClass: "workflow-run-key-census" });
                case "run-key.commit": return await inTx(tx => commitWorkflowRunRecipientKeyEnvelopesInTx(tx, { ...body, actorAccountId: request.userId }), { transactionClass: "workflow-run-key-commit" });
                case "admit": return await admitWorkflowRun({ accountId: request.userId, runId: body.runId, origin: body.origin, machineId: body.machineId, sourceArtifactId: body.sourceArtifactId, visibleTeamId: body.visibleTeamId, authentication, recipientKeyEnvelopes: body.recipientKeyEnvelopes, accountCurrentness: body.accountCurrentness, acceptedEnvelope: body.acceptedEnvelope, ...(body.resultDelivery ? { resultDelivery: body.resultDelivery } : {}), ...(body.discussionTargetSessionIds ? { discussionTargetSessionIds: body.discussionTargetSessionIds } : {}), ...(body.origin.discussion ? { discussionAuthentication: readSessionAccessAuthenticationFromRequest(request) } : {}) });
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
                case "read_state.set": return await setWorkflowRunReadState({ accountId: request.userId, runId: body.runId, revision: body.revision, failedAt: body.failedAt });
                case "origin-input.withdrawn": return await recordWorkflowRunOriginInputWithdrawn({ accountId: request.userId, originSessionId: body.originSessionId, runId: body.runId, invocationRecordId: body.invocationRecordId, expectedRevision: body.expectedRevision, accountCurrentness: body.accountCurrentness });
                case "recovery.list": return await listWorkflowRunsForRecovery({ accountId: request.userId, machineId: body.publisherMachineId, ...(body.cursor ? { cursor: body.cursor } : {}), ...(body.limit ? { limit: body.limit } : {}), pageByteLimit: body.pageByteLimit });
                case "invocations.list": return await listWorkflowRunInvocations({ accountId: request.userId, runId: body.runId, ...(body.cursor ? { cursor: body.cursor } : {}), ...(body.limit ? { limit: body.limit } : {}), ...(body.invocationId !== undefined ? { invocationId: body.invocationId } : {}), ...(body.parentRecordId !== undefined ? { parentRecordId: body.parentRecordId } : {}), ...(body.parentRecordIds !== undefined ? { parentRecordIds: body.parentRecordIds } : {}), ...(body.memberOrdinal !== undefined ? { memberOrdinal: body.memberOrdinal } : {}), ...(body.lifecycles ? { lifecycles: body.lifecycles } : {}), ...(body.progressEnvelopes ? { progressEnvelopes: body.progressEnvelopes } : {}), pageByteLimit: body.pageByteLimit });
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
            const prisma = getActivePrismaRuntime();
            if (error instanceof prisma.PrismaClientKnownRequestError
                || error instanceof prisma.PrismaClientUnknownRequestError
                || error instanceof prisma.PrismaClientInitializationError
                || error instanceof prisma.PrismaClientRustPanicError
                || isTransactionAcquisitionUnavailableError(error)
                || isTransactionConflictExhaustedError(error)
                || isTransactionDeadlineExceededError(error)) {
                // Keep operational failures distinct from unreadable private content.
                // Unexpected application errors still reach the global error owner.
                log({ module: "workflow-storage", level: "error", operation: body.operation,
                    errorCode: "code" in error ? error.code : error.name }, "Workflow storage is unavailable");
                return reply.code(503).send({ error: "storage_unavailable" });
            }
            if (!(error instanceof WorkflowRunServiceError)) throw error;
            const status = error.code === "run_not_found" ? 404 : error.code === "run_access_denied" ? 403 : error.code === "currentness_conflict" ? 409 : 422;
            return reply.code(status).send({ error: error.code });
        }
    });
}
