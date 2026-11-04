import { buildMachineAdmissionFactsSelect, resolveMachineAdmissionFromFactsInTx } from '@/app/machines/machineAccess';
import { publishWorkflowRunMachineWakeInTx } from './workflowRunMachineRouting';
import { isDeepStrictEqual } from 'node:util';
import { decodeKeysetCursorV1, encodeKeysetCursorV1, readKeysetCursorIdV1, readKeysetCursorTextV1 } from '@happier-dev/protocol/pagination/keysetCursorV1';
import { measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '@happier-dev/protocol/actions/externalActionLimits';
import { projectWorkflowBigIntV1, WORKFLOW_UNSETTLED_INVOCATION_LIFECYCLES_V1, type WorkflowInvocationLifecycleV1, type WorkflowRunOriginV1, type WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { toAutomationRunExecutionInputV1Origin } from '@happier-dev/protocol/automations/automationApiV3';
import { projectAutomationAccountCurrentnessWitnessV1, sameAutomationAccountContentIdentityV1, type AutomationAccountCurrentnessWitnessV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { WorkflowRunListRequestV1Schema, WorkflowRunAutomationSummariesRequestV1Schema,
    type WorkflowRunSummariesResultV1,
    type WorkflowRunSourceSummariesResultV1, type WorkflowRunAutomationSummariesResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { Prisma } from "@prisma/client";
import { WorkflowDirectRunAdmissionIdV1Schema, WorkflowInvocationRecordIdSchema } from '@happier-dev/protocol/workflows/workflowIdsV1';
import { isWorkflowDraftPublicationLifecycleV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { type WorkflowRunRecipientKeyEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { type WorkflowRunWaitConditionV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { resolveWorkflowRunAdmissionVisibilityInTx, storeWorkflowRunInitialKeyEnvelopesInTx, resolveWorkflowRunRecipientAccountIdsInTx, assertWorkflowDiscussionAdmissionInTx, workflowInvocationObservationRunWhere } from "./workflowRunAccess";
import type { TeamOperationAuthenticationContext } from "@/app/teams/actorContext";
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';

import { markAccountsChanged, type AccountChangePublication } from "@/app/changes/markAccountChanged";
import { acquireWorkflowPublicationLocksInTx } from "./acquireWorkflowPublicationLocksInTx";
import { invalidateRunFollowDestinationsInTx } from '@/app/session/follow/sessionFollowEdgeService';
import { markAccountChangesForSessionAccounts } from "@/app/session/changeTracking/markAccountChangesForSessionAccounts";
import { publishManagedRunWakeInTx, publishManagedContextWakeInTx } from '@/app/machines/managed/managedWake';
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { automationRunCustodyTerminalWhere, readAutomationLiveCauseRunIdsTx } from "@/app/automations/automationCrudService";
import { AUTOMATION_RUN_TERMINAL_STATES, projectAutomationRunState } from "@/app/automations/automationTypes";
import { automationRunCauseSelect, automationRunWithoutExecutionWhere } from "@/app/automations/automationPersistenceSelect";
import { decodeAutomationRunCause } from "@/app/automations/automationRunCauseCodec";
import { applyAutomationRunTerminalEffectsTx, failAutomationRunWithoutContentInTx } from "@/app/automations/automationRunSucceeded";
import { readRetainedAutomationRunExecutionInputForWorkflowAdmission, validateAutomationStoredContentEnvelopeOuterForMode } from "@/app/automations/automationStoredContentRead";
import { db } from "@/storage/db";
import { afterTx, inReadSnapshot, inTx, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv, isPrismaErrorCode, prismaRuntime } from "@/storage/prisma";
import { timeWebLatencyPhase } from '@/utils/webLatencyTrace';
import { readSnapshotWithCurrentAdmission } from '@/storage/readSnapshotWithCurrentAdmission';

import { assertWorkflowStoredEnvelopeOuterForMode, WorkflowStoredContentError } from "./runs/storedContent";
import { workflowRunAttentionWhere, workflowRunSqlIdentifier, workflowRunFailureUnseen,
    readWorkflowRunInvocationAttentionInTx, workflowRunAttentionSql, workflowRunFailureUnseenSql, workflowRunInvocationAttentionSql } from "./workflowRunAttention";
import { admitWorkflowRunLifecycleAutomationRunsTx } from "@/app/automations/automationRunLifecycleAdmission";
import {
    WorkflowRunAccessError, resolveWorkflowRunAccessInTx, readWorkflowRunKeyProjectionInTx, readWorkflowRunKeyProjectionsInTx,
    resolveWorkflowRunVisibilityScopesInTx, type WorkflowRunAccess,
} from "./workflowRunAccess";
import type { WorkflowRunRecipientCensusResponseV1 } from '@happier-dev/protocol/workflows/workflowRunKeyV1';

type WorkflowRunState = WorkflowRunSummaryV1["state"];
type WorkflowCustodyState = "pending" | "settled";
const MAX_DATABASE_BIGINT = 9_223_372_036_854_775_807n;
// A continuation cursor, rather than an unbounded SQL `take`, carries reads
// that need more rows. This is an internal fetch bound, not a workflow quota.
const WORKFLOW_PAGE_DATABASE_BATCH_ROWS = 128;

function automationPreviousStateForWorkflowTerminalEffects(state: WorkflowRunState) {
    const projected = projectAutomationRunState(state);
    if (projected === null) throw new WorkflowRunServiceError("currentness_conflict");
    return projected;
}

export class WorkflowRunServiceError extends Error {
    constructor(readonly code: "invalid_input" | "target_unavailable" | "run_not_found" | "run_access_denied" | "visible_team_not_granted" | "data_key_not_required" | "currentness_conflict" | "ineligible_state" | "custody_pending" | "content_unavailable") {
        super(code);
        this.name = "WorkflowRunServiceError";
    }
}

async function withWorkflowRunAccess<T>(body: () => Promise<T>): Promise<T> {
    try { return await body(); }
    catch (error) {
        if (error instanceof WorkflowRunAccessError) throw new WorkflowRunServiceError(error.code);
        throw error;
    }
}

async function resolveWorkflowRunAccessTx(tx: Tx, input: Readonly<{ actorAccountId: string; runId: string }>): Promise<WorkflowRunAccess> {
    return withWorkflowRunAccess(async () => {
        const access = await resolveWorkflowRunAccessInTx(tx, input);
        if (!access) throw new WorkflowRunServiceError("run_not_found");
        return access;
    });
}

const workflowRunProjectionSelect = {
    ...automationRunCauseSelect,
    id: true,
    accountId: true,
    sourceArtifactId: true,
    visibleTeamId: true,
    originKind: true,
    automationId: true,
    automationScopeCaptured: true,
    automationScopeSessionId: true,
    originSessionId: true,
    state: true,
    errorCode: true,
    revision: true,
    attempt: true,
    claimedByMachineId: true,
    workflowCustodyState: true,
    originDeliveryAckRevision: true,
    attentionSeenFailureAt: true,
    createdAt: true,
    updatedAt: true,
    finishedAt: true,
    assignments: { orderBy: { priority: "asc" as const }, take: 1, select: { machineId: true } },
    workflowInvocations: { take: 1, select: { id: true } },
    _count: { select: { workflowInvocations: { where: { lifecycle: "waiting_for_review" } } } },
} satisfies Prisma.AutomationRunSelect;
const workflowRunListSelect = {
    ...workflowRunProjectionSelect,
    workflowAcceptedSnapshotEnvelope: true,
} satisfies Prisma.AutomationRunSelect;
const workflowRunSelect = {
    ...workflowRunListSelect,
    workflowCheckpointEnvelope: true,
    executionInputEnvelope: true,
    resultEnvelope: true,
    scheduledAt: true,
    startedAt: true,
    finishedAt: true,
} satisfies Prisma.AutomationRunSelect;

/** A selector's Prisma payload with the persisted text columns narrowed to the Workflow Run domain values. */
type NarrowedWorkflowRunRow<S extends Prisma.AutomationRunSelect> = Omit<
    Prisma.AutomationRunGetPayload<{ select: S }>,
    "state"
> & {
    state: WorkflowRunState;
};
type WorkflowRunProjectionRow = NarrowedWorkflowRunRow<typeof workflowRunProjectionSelect>;
type WorkflowRunRow = WorkflowRunProjectionRow & { invocationAttentionRequired: boolean };
type WorkflowRunListRow = NarrowedWorkflowRunRow<typeof workflowRunListSelect>;
type WorkflowRunListCapturedRow = Omit<WorkflowRunListRow, "workflowAcceptedSnapshotEnvelope">
    & { workflowAcceptedSnapshotEnvelope?: string | null; invocationAttentionRequired: boolean };
type WorkflowRunFullRow = NarrowedWorkflowRunRow<typeof workflowRunSelect>;

export function deriveWorkflowRunAvailability(input: Readonly<{
    state: WorkflowRunState;
    workflowCustodyState: WorkflowCustodyState | null;
    hasExecution: boolean;
}>): WorkflowRunSummaryV1["availability"] {
    const { state, workflowCustodyState, hasExecution } = input;
    const terminal = AUTOMATION_RUN_TERMINAL_STATES.some((candidate) => candidate === state);
    const pause = workflowCustodyState === "pending"
        && (state === "queued" || state === "claimed" || state === "running" || state === "waiting_for_review");
    const resumeBoundary = state === "paused";
    const restoreWorkspace = state === "interrupted" && hasExecution;
    const cancel = !terminal && workflowCustodyState === "pending";
    const disabledReasons: WorkflowRunSummaryV1["availability"]["disabledReasons"] = [];
    if (!pause) disabledReasons.push({ operation: "pause", code: terminal ? "run_terminal" : "ineligible_state" });
    if (!resumeBoundary) disabledReasons.push({ operation: "resume_boundary", code: "ineligible_state" });
    if (!restoreWorkspace) disabledReasons.push({ operation: "restore_workspace", code: hasExecution ? "ineligible_state" : "execution_not_admitted" });
    if (!cancel) disabledReasons.push({ operation: "cancel", code: terminal ? "run_terminal" : "custody_settled" });
    if (!hasExecution) disabledReasons.push({ operation: "inspect_execution", code: "execution_not_admitted" });
    return {
        pause,
        resumeBoundary,
        restoreWorkspace,
        cancel,
        inspectExecution: hasExecution,
        disabledReasons,
    };
}

function availability(row: WorkflowRunRow): WorkflowRunSummaryV1["availability"] {
    return deriveWorkflowRunAvailability({
        state: row.state as WorkflowRunState,
        workflowCustodyState: row.workflowCustodyState,
        hasExecution: row.workflowInvocations.length > 0,
    });
}

function projectRun(row: WorkflowRunRow, viewerAccountId: string = row.accountId): WorkflowRunSummaryV1 {
    const machineId = row.assignments[0]?.machineId;
    if (!machineId) throw new WorkflowRunServiceError("content_unavailable");
    const state = row.state as WorkflowRunState;
    const failureUnseen = workflowRunFailureUnseen(row, viewerAccountId);
    const invocationAttentionRequired = state !== 'cancelled' && row.invocationAttentionRequired;
    const origin: WorkflowRunOriginV1 = row.originKind === "automation" && row.automationId
        ? { kind: "automation", automationId: row.automationId,
            ...(row.originSessionId !== null ? { originSessionId: row.originSessionId } : {}),
            cause: decodeAutomationRunCause(row) ?? undefined,
        }
        : { kind: "direct", ...(row.originSessionId !== null ? { originSessionId: row.originSessionId } : {}) };
    return {
        id: row.id,
        sourceArtifactId: row.sourceArtifactId,
        ownerAccountId: row.accountId,
        visibleTeamId: row.visibleTeamId,
        attentionRequired: failureUnseen || invocationAttentionRequired,
        failureUnseen,
        invocationAttentionRequired,
        attentionSeenFailureAt: row.accountId === viewerAccountId ? row.attentionSeenFailureAt?.toISOString() ?? null : null,
        heldCount: state === "cancelled" ? 0 : row._count.workflowInvocations,
        origin,
        ...(origin.kind === "automation" && row.automationScopeCaptured
            ? { automationScopeSessionId: row.automationScopeSessionId } : {}),
        state,
        ...(row.errorCode !== null ? { errorCode: row.errorCode } : {}),
        revision: row.revision,
        machineId,
        workflowCustodyState: row.workflowCustodyState,
        originDeliveryAckRevision: row.originDeliveryAckRevision,
        availability: availability(row),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        // Every Run row select carries the terminal-transition instant (`workflowRunProjectionSelect`).
        finishedAt: row.finishedAt?.toISOString() ?? null,
    };
}

async function projectRunInTx(tx: Tx, row: NarrowedWorkflowRunRow<typeof workflowRunProjectionSelect>, viewerAccountId: string = row.accountId): Promise<WorkflowRunSummaryV1> {
    const attention = await readWorkflowRunInvocationAttentionInTx(tx, [row.id]);
    return projectRun({ ...row, invocationAttentionRequired: attention.has(row.id) }, viewerAccountId);
}

async function loadAccountModeTx(tx: Tx, accountId: string, runId?: string): Promise<"plain" | "e2ee"> {
    if (runId) await acquireWorkflowPublicationLocksInTx(tx, { accountId, runIds: [runId] });
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, accountId, "content");
    if (fence.status !== "ready") {
        throw new WorkflowRunServiceError("content_unavailable");
    }
    return fence.account.currentness.encryptionMode;
}

async function readAccountModeTx(tx: Tx, accountId: string): Promise<"plain" | "e2ee"> {
    const account = await tx.account.findUnique({
        where: { id: accountId },
        select: { publicKey: true, encryptionMode: true, contentPublicKey: true, contentPublicKeySig: true },
    });
    if (!account) throw new WorkflowRunServiceError("content_unavailable");
    const currentness = deriveAccountEncryptionCurrentnessFromRow(account);
    if (currentness.status !== "ready") throw new WorkflowRunServiceError("content_unavailable");
    return currentness.currentness.encryptionMode;
}

async function loadCurrentWorkflowAccountModeTx(
    tx: Tx,
    accountId: string,
    supplied: AutomationAccountCurrentnessWitnessV1,
    runId: string,
): Promise<"plain" | "e2ee"> {
    await acquireWorkflowPublicationLocksInTx(tx, { accountId, runIds: [runId] });
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, accountId, "content");
    if (fence.status !== "ready") throw new WorkflowRunServiceError("content_unavailable");
    const current = projectAutomationAccountCurrentnessWitnessV1({
        mode: fence.account.currentness.encryptionMode,
        version: fence.account.version,
        contentKeyFingerprint: fence.account.contentKeyFingerprint,
    });
    if (!current || !sameAutomationAccountContentIdentityV1(supplied, current)) {
        throw new WorkflowRunServiceError("currentness_conflict");
    }
    return current.mode;
}

type OriginDeliverySignal = Readonly<{ state: string; originSessionId: string | null; revision: number; originDeliveryAckRevision: number | null; attention: boolean }>;

async function readOriginDeliverySignalTx(tx: Tx, accountId: string, runId: string): Promise<OriginDeliverySignal | null> {
    const row = await tx.automationRun.findFirst({ where: { id: runId, accountId }, select: {
        state: true, originSessionId: true, revision: true, originDeliveryAckRevision: true,
    } });
    if (!row) return null;
    const attention = await tx.automationRun.findFirst({
        where: { id: runId, accountId, AND: [workflowRunAttentionWhere(accountId)] }, select: { id: true },
    }) !== null;
    return { ...row, attention };
}

async function reconcileWorkflowRunAttentionAndHintTx(tx: Tx, accountId: string, runId: string, before: OriginDeliverySignal | null, inputDeliverable = false): Promise<void> {
    if (!before) return;
    let after = await readOriginDeliverySignalTx(tx, accountId, runId);
    if (!after) return;
    const attentionChanged = before.attention !== after.attention;
    // Child writers hold the parent control lock. Ordinary facts stay row-local;
    // only membership changes need a new revision for the existing delivery ack.
    // Allocation/control/review transactions already advance that same revision.
    if (attentionChanged && before.revision === after.revision) {
        const changed = await tx.automationRun.updateMany({
            where: { id: runId, accountId, revision: after.revision },
            data: { revision: { increment: 1 } },
        });
        if (changed.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
        after = { ...after, revision: after.revision + 1 };
    }
    if (!after.originSessionId) return;
    const becameTerminal = !AUTOMATION_RUN_TERMINAL_STATES.some((state) => state === before.state)
        && AUTOMATION_RUN_TERMINAL_STATES.some((state) => state === after.state);
    if (!inputDeliverable && !(after.originDeliveryAckRevision !== null && (becameTerminal || attentionChanged))) return;
    await markAccountChangesForSessionAccounts({ tx, sessionId: after.originSessionId, accountIds: [accountId],
        hint: { kind: "workflow-run-delivery", runId, revision: after.revision } });
    if (inputDeliverable || (after.originDeliveryAckRevision !== null && becameTerminal)) {
        await publishManagedContextWakeInTx(tx, { runId, originSessionId: after.originSessionId });
    }
}

async function markWorkflowRunChangedTx(tx: Tx, accountId: string, runId: string, deliveryBefore?: OriginDeliverySignal | null, inputDeliverable = false): Promise<AccountChangePublication> {
    const recipients = await resolveWorkflowRunRecipientAccountIdsInTx(tx, runId);
    const cursors = await markAccountsChanged(tx, { accountIds: [accountId, ...recipients], kind: "account", entityId: `workflow-run:${runId}` });
    const ownerCursor = cursors.find(cursor => cursor.accountId === accountId);
    if (!ownerCursor) throw new Error("Workflow owner is missing from its publication audience");
    if (deliveryBefore !== undefined) await reconcileWorkflowRunAttentionAndHintTx(tx, accountId, runId, deliveryBefore, inputDeliverable);
    await admitWorkflowRunLifecycleAutomationRunsTx(tx, runId);
    const run = await tx.automationRun.findUnique({ where: { id: runId }, select: { state: true, workflowCustodyState: true } });
    if (run?.workflowCustodyState !== null && run && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.state)) {
        await invalidateRunFollowDestinationsInTx(tx, { kind: 'workflow_run', runId });
    }
    return ownerCursor;
}

export type AdmitWorkflowRunInput = Readonly<{
    accountId: string;
    runId: string;
    origin: Extract<WorkflowRunOriginV1, { kind: "direct" }>;
    machineId: string;
    acceptedEnvelope: string;
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    sourceArtifactId?: string | null;
    visibleTeamId?: string | null;
    authentication?: TeamOperationAuthenticationContext;
    recipientKeyEnvelopes?: readonly WorkflowRunRecipientKeyEnvelopeV1[];
    resultDelivery?: Readonly<{ kind: "originating_session" | "originating_discussion" }>;
    discussionTargetSessionIds?: readonly string[];
    discussionAuthentication?: SessionAccessAuthentication;
}>;

function isExactWorkflowAdmission(row: WorkflowRunListRow, params: AdmitWorkflowRunInput): boolean {
    const sameOrigin = row.originKind === "direct"
        && row.automationId === null
        && row.originSessionId === (params.origin.originSessionId ?? null);
    const sameDelivery = params.resultDelivery?.kind !== 'originating_session'
        ? row.originDeliveryAckRevision === null
        : row.originDeliveryAckRevision !== null;
    return row.workflowCustodyState !== null
        && row.sourceArtifactId === (params.sourceArtifactId ?? null)
        && (params.visibleTeamId === undefined || row.visibleTeamId === params.visibleTeamId)
        && row.workflowAcceptedSnapshotEnvelope === params.acceptedEnvelope
        && row.assignments[0]?.machineId === params.machineId
        && sameOrigin
        && sameDelivery;
}

/** Rejoining immutable admission never substitutes a newly generated Run key. */
async function assertWorkflowRunAdmissionKeysUnchangedTx(tx: Tx, accountId: string, runId: string,
    mode: "plain" | "e2ee", recipientKeyEnvelopes: readonly WorkflowRunRecipientKeyEnvelopeV1[]): Promise<void> {
    if (mode === "plain") {
        if (recipientKeyEnvelopes.length > 0) throw new WorkflowRunServiceError("data_key_not_required");
        return;
    }
    const census = await withWorkflowRunAccess(() => readWorkflowRunKeyProjectionInTx(tx, { actorAccountId: accountId, runId }));
    const owner = recipientKeyEnvelopes.find((envelope) => envelope.recipientAccountId === accountId);
    if (!owner || !census.dataEncryptionKey) throw new WorkflowRunServiceError("content_unavailable");
    const recipient = census.recipients.find((candidate) => candidate.recipientAccountId === accountId);
    if (owner.encryptedDataKey !== census.dataEncryptionKey
        || owner.recipientContentPublicKeyFingerprint !== recipient?.contentPublicKeyFingerprint) {
        throw new WorkflowRunServiceError("currentness_conflict");
    }
}

async function resolveEditableWorkflowRunAccessTx(tx: Tx, input: Readonly<{ actorAccountId: string; runId: string }>) {
    const access = await resolveWorkflowRunAccessTx(tx, input);
    if (access.level === "view") throw new WorkflowRunServiceError("run_access_denied");
    return access;
}

export async function admitWorkflowRunTx(tx: Tx, params: AdmitWorkflowRunInput): Promise<{ kind: "created" | "existing"; run: WorkflowRunSummaryV1 }> {
        if (!WorkflowDirectRunAdmissionIdV1Schema.safeParse(params.runId).success) {
            throw new WorkflowRunServiceError("invalid_input");
        }
        const discussionOrigin = params.origin.discussion;
        if (params.resultDelivery?.kind === 'originating_discussion' && !discussionOrigin
            || params.discussionTargetSessionIds !== undefined && !discussionOrigin) throw new WorkflowRunServiceError('invalid_input');
        if (discussionOrigin) await withWorkflowRunAccess(() => assertWorkflowDiscussionAdmissionInTx(tx, {
            accountId: params.accountId, origin: discussionOrigin, targetSessionIds: params.discussionTargetSessionIds ?? [],
            authentication: params.discussionAuthentication, publishes: params.resultDelivery?.kind === 'originating_discussion',
        }));
        await withWorkflowRunAccess(() => acquireWorkflowPublicationLocksInTx(tx, {
            accountId: params.accountId, runIds: [params.runId], machineIds: [params.machineId],
            sessionIds: params.origin.originSessionId ? [params.origin.originSessionId] : [],
            admission: { sourceArtifactId: params.sourceArtifactId ?? null, authentication: params.authentication,
                ...(params.visibleTeamId === undefined ? {} : { visibleTeamId: params.visibleTeamId }) },
        }));
        const existing = await tx.automationRun.findUnique({ where: { id: params.runId }, select: workflowRunSelect });
        if (existing) {
            if (existing.accountId !== params.accountId) throw new WorkflowRunServiceError("currentness_conflict");
            if (!isExactWorkflowAdmission(existing as WorkflowRunListRow, params)) throw new WorkflowRunServiceError("currentness_conflict");
            const mode = await loadCurrentWorkflowAccountModeTx(tx, params.accountId, params.accountCurrentness, params.runId);
            assertWorkflowStoredEnvelopeOuterForMode({ raw: existing.workflowAcceptedSnapshotEnvelope!, mode, binding: { v: 1, purpose: "accepted_snapshot", accountId: params.accountId, runId: params.runId } });
            await assertWorkflowRunAdmissionKeysUnchangedTx(tx, params.accountId, params.runId, mode, params.recipientKeyEnvelopes ?? []);
            return { kind: "existing", run: await projectRunInTx(tx, existing as WorkflowRunProjectionRow, params.accountId) };
        }
        const mode = await loadCurrentWorkflowAccountModeTx(tx, params.accountId, params.accountCurrentness, params.runId);
        assertWorkflowStoredEnvelopeOuterForMode({ raw: params.acceptedEnvelope, mode, binding: { v: 1, purpose: "accepted_snapshot", accountId: params.accountId, runId: params.runId } });
        const machine = await tx.machine.findUnique({ where: { id: params.machineId },
            select: buildMachineAdmissionFactsSelect(params.accountId) });
        const admission = await resolveMachineAdmissionFromFactsInTx(tx, machine,
            { actorAccountId: params.accountId, machineId: params.machineId, purpose: 'workflow' });
        if (admission.kind !== 'admitted' || admission.availability !== 'available') throw new WorkflowRunServiceError("target_unavailable");
        if (params.origin.originSessionId) {
            const session = await tx.session.findFirst({ where: { id: params.origin.originSessionId, accountId: params.accountId }, select: { id: true } });
            if (!session) throw new WorkflowRunServiceError("invalid_input");
        } else if (params.resultDelivery?.kind === 'originating_session') {
            throw new WorkflowRunServiceError("invalid_input");
        }
        const visibleTeamId = await withWorkflowRunAccess(() => resolveWorkflowRunAdmissionVisibilityInTx(tx, {
            actorAccountId: params.accountId, sourceArtifactId: params.sourceArtifactId ?? null,
            authentication: params.authentication,
            ...(params.visibleTeamId === undefined ? {} : { visibleTeamId: params.visibleTeamId }),
        }));
        const now = new Date();
        const row = await tx.automationRun.create({
                data: {
                    id: params.runId,
                    accountId: params.accountId,
                    sourceArtifactId: params.sourceArtifactId ?? null,
                    visibleTeamId,
                    originKind: "direct",
                    automationId: null,
                    originSessionId: params.origin.originSessionId ?? null,
                    causeKind: null,
                    causeOccurredAt: null,
                    state: "queued",
                    scheduledAt: now,
                    dueAt: now,
                    workflowAcceptedSnapshotEnvelope: params.acceptedEnvelope,
                    // The Automation claim corridor reads the frozen program
                    // from executionInputEnvelope for both origins. Direct
                    // admission therefore materializes the same immutable bytes
                    // at that incumbent claim boundary; it is not a second
                    // mutable definition pointer.
                    executionInputEnvelope: params.acceptedEnvelope,
                    workflowCheckpointEnvelope: null,
                    workflowCustodyState: "pending",
                    originDeliveryAckRevision: params.resultDelivery?.kind === 'originating_session' ? 0 : null,
                    assignments: { create: { machineId: params.machineId, priority: 0,
                        admittedMachineInstallationId: admission.installationId } },
                },
                select: workflowRunSelect,
            });
        await withWorkflowRunAccess(() => storeWorkflowRunInitialKeyEnvelopesInTx(tx, {
            actorAccountId: params.accountId, runId: params.runId, sourceArtifactId: params.sourceArtifactId ?? null,
            visibleTeamId, encryptionMode: mode, recipientKeyEnvelopes: params.recipientKeyEnvelopes ?? [],
        }));
        const cursor = await markWorkflowRunChangedTx(tx, params.accountId, params.runId);
        await publishManagedRunWakeInTx(tx, { accountId: params.accountId, runId: params.runId, cursor });
        await publishWorkflowRunMachineWakeInTx(tx, { accountId: params.accountId,
            run: row as WorkflowRunFullRow, cursor, admittedTargets: [admission] });
        return { kind: "created", run: await projectRunInTx(tx, row as WorkflowRunProjectionRow, params.accountId) };
}

async function findUnsettledWorkflowInvocationInTx(tx: Tx, runId: string, reconciledTerminalInvocationIds: readonly string[] = []) {
    return await tx.workflowRunInvocation.findFirst({ where: {
        runId, lifecycle: { in: [...WORKFLOW_UNSETTLED_INVOCATION_LIFECYCLES_V1] },
        ...(reconciledTerminalInvocationIds.length > 0 ? { id: { notIn: [...reconciledTerminalInvocationIds] } } : {}),
    }, select: { id: true } });
}

/** Installation authority can report only this non-content terminal refusal. */
export async function recordWorkflowRequesterCustodyUnavailable(input: Readonly<{
    runId: string; machineId: string; installationId: string;
}>): Promise<void> {
    await inTx(async tx => {
        const current = await tx.automationRun.findFirst({ where: { id: input.runId,
            workflowCustodyState: 'pending', state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] },
            assignments: { some: { machineId: input.machineId,
                admittedMachineInstallationId: input.installationId } },
        }, select: { accountId: true, state: true } });
        if (!current) return;
        await acquireWorkflowPublicationLocksInTx(tx, { accountId: current.accountId, runIds: [input.runId] });
        const unsettled = await findUnsettledWorkflowInvocationInTx(tx, input.runId);
        const now = new Date();
        const result = await failAutomationRunWithoutContentInTx({ tx, accountId: current.accountId, runId: input.runId,
            previousState: current.state as WorkflowRunState,
            where: { state: current.state, workflowCustodyState: 'pending', assignments: { some: {
                machineId: input.machineId, admittedMachineInstallationId: input.installationId,
            } } }, errorCode: 'requester_custody_unavailable', settleWorkflowCustody: unsettled === null, now });
        if (!result.changed) return;
        await markWorkflowRunChangedTx(tx, current.accountId, input.runId);
    }, { isolationLevel: 'ReadCommitted', transactionClass: 'workflow-requester-custody-refusal' });
}

export async function admitWorkflowRun(params: AdmitWorkflowRunInput): Promise<{ kind: "created" | "existing"; run: WorkflowRunSummaryV1 }> {
    try {
        return await inTx(async (tx) => await admitWorkflowRunTx(tx, params), {
            // Ordered publication locks/replay and mode/control/row predicates fence this mutation.
            isolationLevel: "ReadCommitted",
            transactionClass: "workflow-admit-run",
        });
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2002")) throw error;
        return await inTx(async (tx) => await admitWorkflowRunTx(tx, params), {
            // Ordered publication locks/replay and mode/control/row predicates fence this mutation.
            isolationLevel: "ReadCommitted",
            transactionClass: "workflow-admit-run-rejoin",
        });
    }
}

/** Adds the frozen Automation definition body to a parent created by canonical Automation admission. */
export async function attachAutomationWorkflowBodyTx(tx: Tx, params: Readonly<{
    accountId: string; runId: string; automationId: string; definitionEnvelope: string;
}>): Promise<WorkflowRunSummaryV1> {
    const mode = await loadAccountModeTx(tx, params.accountId, params.runId);
    const definitionOuter = validateAutomationStoredContentEnvelopeOuterForMode({ raw: params.definitionEnvelope, mode });
    if (definitionOuter.kind !== "available") throw new WorkflowRunServiceError(definitionOuter.kind === "modeMismatch" ? "content_unavailable" : "invalid_input");
    const changed = await tx.automationRun.updateMany({
        where: {
            id: params.runId,
            accountId: params.accountId,
            automationId: params.automationId,
            originKind: "automation",
            workflowCustodyState: null,
            workflowAcceptedSnapshotEnvelope: null,
            assignments: { some: {} },
        },
        data: {
            executionInputEnvelope: params.definitionEnvelope,
            workflowCustodyState: "pending",
        },
    });
    if (changed.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
    const row = await tx.automationRun.findUniqueOrThrow({ where: { id: params.runId }, select: workflowRunSelect });
    await markWorkflowRunChangedTx(tx, params.accountId, params.runId);
    return await projectRunInTx(tx, row as WorkflowRunProjectionRow, params.accountId);
}

/** Freezes resolved Automation inputs once, before any root or effect is admitted. */
export async function resolveAutomationWorkflowAcceptedSnapshot(params: Readonly<{
    accountId: string; runId: string; automationId: string; machineId: string;
    expectedAttempt: number; expectedRevision: number;
    definitionEnvelope: string; acceptedEnvelope: string;
    originSessionId?: string;
    resultDelivery?: AdmitWorkflowRunInput["resultDelivery"];
    sourceArtifactId?: string | null;
    visibleTeamId?: string | null;
    authentication?: TeamOperationAuthenticationContext;
    recipientKeyEnvelopes?: readonly WorkflowRunRecipientKeyEnvelopeV1[];
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
}>) {
    if (!Number.isSafeInteger(params.expectedAttempt) || params.expectedAttempt < 0) throw new WorkflowRunServiceError("invalid_input");
    return await inTx(async (tx) => {
        // Only unresolved snapshots have a prospective audience. Rejoin keeps
        // the frozen Team even when current grants require a new choice.
        const unresolved = await tx.automationRun.findFirst({ where: {
            id: params.runId, accountId: params.accountId, workflowAcceptedSnapshotEnvelope: null,
        }, select: { id: true } });
        if (unresolved) await withWorkflowRunAccess(() => acquireWorkflowPublicationLocksInTx(tx, {
            accountId: params.accountId, runIds: [params.runId],
            admission: { sourceArtifactId: params.sourceArtifactId ?? null, authentication: params.authentication,
                ...(params.visibleTeamId === undefined ? {} : { visibleTeamId: params.visibleTeamId }) },
        }));
        const mode = await loadCurrentWorkflowAccountModeTx(tx, params.accountId, params.accountCurrentness, params.runId);
        const predecessor = readRetainedAutomationRunExecutionInputForWorkflowAdmission({ raw: params.definitionEnvelope, mode });
        if (predecessor === null) {
            const definitionOuter = validateAutomationStoredContentEnvelopeOuterForMode({ raw: params.definitionEnvelope, mode });
            if (definitionOuter.kind !== "available") throw new WorkflowRunServiceError(definitionOuter.kind === "modeMismatch" ? "content_unavailable" : "invalid_input");
        } else if (params.originSessionId !== undefined || params.resultDelivery !== undefined
            || params.sourceArtifactId != null || params.visibleTeamId != null) {
            throw new WorkflowRunServiceError("invalid_input");
        }
        assertWorkflowStoredEnvelopeOuterForMode({ raw: params.acceptedEnvelope, mode, binding: { v: 1, purpose: "accepted_snapshot", accountId: params.accountId, runId: params.runId } });
        const current = await tx.automationRun.findFirst({ where: {
            id: params.runId,
            accountId: params.accountId,
            originKind: "automation",
            automationId: params.automationId,
            claimedByMachineId: params.machineId,
            attempt: params.expectedAttempt,
            ...(predecessor ? { OR: [
                { workflowCustodyState: "pending" },
                { workflowCustodyState: null, ...automationRunWithoutExecutionWhere, state: "claimed" },
            ] } : { workflowCustodyState: "pending" }),
            workflowCheckpointEnvelope: null,
            assignments: { some: { machineId: params.machineId } },
        }, select: workflowRunSelect });
        if (!current || current.executionInputEnvelope !== params.definitionEnvelope) throw new WorkflowRunServiceError("currentness_conflict");
        if (predecessor) {
            const cause = decodeAutomationRunCause(current);
            const origin = cause === null ? null : toAutomationRunExecutionInputV1Origin(cause);
            if (origin === null || createCanonicalJsonSigningInput(origin) !== createCanonicalJsonSigningInput(predecessor.origin)) {
                throw new WorkflowRunServiceError("currentness_conflict");
            }
        }
        const originSessionId = params.originSessionId ?? null;
        if (current.workflowAcceptedSnapshotEnvelope !== null) {
            if (current.revision === params.expectedRevision + 1 && current.sourceArtifactId === (params.sourceArtifactId ?? null)
                && (params.visibleTeamId === undefined || current.visibleTeamId === params.visibleTeamId)
                && current.originSessionId === originSessionId
                && (params.resultDelivery === undefined ? current.originDeliveryAckRevision === null : current.originDeliveryAckRevision !== null)
                && current.workflowAcceptedSnapshotEnvelope === params.acceptedEnvelope) {
                await assertWorkflowRunAdmissionKeysUnchangedTx(tx, params.accountId, params.runId, mode, params.recipientKeyEnvelopes ?? []);
                return {
                    disposition: "existing" as const,
                    acceptedEnvelope: current.workflowAcceptedSnapshotEnvelope,
                    run: await projectRunInTx(tx, current as WorkflowRunProjectionRow, params.accountId),
                };
            }
            throw new WorkflowRunServiceError("currentness_conflict");
        }
        const automation = await tx.automation.findFirst({ where: { id: params.automationId, accountId: params.accountId },
            select: { scopeSessionId: true } });
        if (!automation || (!predecessor && automation.scopeSessionId !== originSessionId)) throw new WorkflowRunServiceError("currentness_conflict");
        if (originSessionId !== null) {
            const session = await tx.session.findFirst({ where: { id: originSessionId, accountId: params.accountId }, select: { id: true } });
            if (!session) throw new WorkflowRunServiceError("invalid_input");
        } else if (params.resultDelivery !== undefined) {
            throw new WorkflowRunServiceError("invalid_input");
        }
        const visibleTeamId = await withWorkflowRunAccess(() => resolveWorkflowRunAdmissionVisibilityInTx(tx, {
            actorAccountId: params.accountId, sourceArtifactId: params.sourceArtifactId ?? null,
            authentication: params.authentication,
            ...(params.visibleTeamId === undefined ? {} : { visibleTeamId: params.visibleTeamId }),
        }));
        const changed = await tx.automationRun.updateMany({ where: {
            id: params.runId,
            accountId: params.accountId,
            revision: params.expectedRevision,
            originKind: "automation",
            automationId: params.automationId,
            automation: { is: { accountId: params.accountId, ...(predecessor ? {} : { scopeSessionId: originSessionId }) } },
            claimedByMachineId: params.machineId,
            attempt: params.expectedAttempt,
            ...(predecessor ? { ...automationRunWithoutExecutionWhere, state: "claimed", workflowCustodyState: null } : { workflowCustodyState: "pending" }),
            workflowAcceptedSnapshotEnvelope: null,
            workflowCheckpointEnvelope: null,
            executionInputEnvelope: params.definitionEnvelope,
            assignments: { some: { machineId: params.machineId } },
        }, data: { workflowAcceptedSnapshotEnvelope: params.acceptedEnvelope, workflowCustodyState: "pending", originSessionId,
            originDeliveryAckRevision: params.resultDelivery ? 0 : null,
            sourceArtifactId: params.sourceArtifactId ?? null, visibleTeamId, revision: { increment: 1 } } });
        if (changed.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
        await withWorkflowRunAccess(() => storeWorkflowRunInitialKeyEnvelopesInTx(tx, {
            actorAccountId: params.accountId, runId: params.runId, sourceArtifactId: params.sourceArtifactId ?? null,
            visibleTeamId, encryptionMode: mode, recipientKeyEnvelopes: params.recipientKeyEnvelopes ?? [],
        }));
        const row = await tx.automationRun.findUniqueOrThrow({ where: { id: params.runId }, select: workflowRunSelect });
        await markWorkflowRunChangedTx(tx, params.accountId, params.runId);
        return {
            disposition: "created" as const,
            acceptedEnvelope: row.workflowAcceptedSnapshotEnvelope!,
            run: await projectRunInTx(tx, row as WorkflowRunProjectionRow, params.accountId),
        };
    }, {
        // Ordered publication locks/replay and mode/control/row predicates fence this mutation.
        isolationLevel: "ReadCommitted",
        transactionClass: "workflow-resolve-automation-accepted-snapshot",
    });
}

export async function initializeWorkflowRunExecution(params: Readonly<{
    accountId: string; runId: string; machineId: string; parentAttempt: number; expectedRevision: number;
    checkpointEnvelope: string; rootInvocation: Readonly<{ id: string; contentEnvelope: string }>;
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
}>) {
    return await inTx(async (tx) => {
        if (!WorkflowInvocationRecordIdSchema.safeParse(params.rootInvocation.id).success || !Number.isSafeInteger(params.parentAttempt) || params.parentAttempt < 0) throw new WorkflowRunServiceError("invalid_input");
        const mode = await loadCurrentWorkflowAccountModeTx(tx, params.accountId, params.accountCurrentness, params.runId);
        assertWorkflowStoredEnvelopeOuterForMode({ raw: params.checkpointEnvelope, mode, binding: { v: 1, purpose: "checkpoint", accountId: params.accountId, runId: params.runId } });
        assertWorkflowStoredEnvelopeOuterForMode({ raw: params.rootInvocation.contentEnvelope, mode, binding: { v: 1, purpose: "invocation_progress", accountId: params.accountId, runId: params.runId, recordId: params.rootInvocation.id, sequence: "0", parentRecordId: null, memberOrdinal: "0", attempt: "0" } });
        const existing = await tx.automationRun.findFirst({
            where: { id: params.runId, accountId: params.accountId, claimedByMachineId: params.machineId, attempt: params.parentAttempt, assignments: { some: { machineId: params.machineId } }, workflowCustodyState: { not: null }, workflowAcceptedSnapshotEnvelope: { not: null } },
            select: { ...workflowRunSelect, workflowInvocations: { where: { parentRecordId: null }, take: 2, select: invocationSelect } },
        });
        if (existing && existing.workflowCheckpointEnvelope !== null) {
            const roots = existing.workflowInvocations as InvocationRow[];
            if (roots.length === 1
                && roots[0]!.id === params.rootInvocation.id
                && roots[0]!.contentEnvelope === params.rootInvocation.contentEnvelope
                && existing.workflowCheckpointEnvelope === params.checkpointEnvelope) {
                return { run: await projectRunInTx(tx, existing as WorkflowRunProjectionRow, params.accountId), initialization: "existing" as const };
            }
            throw new WorkflowRunServiceError("currentness_conflict");
        }
        const run = await tx.automationRun.findFirst({ where: { id: params.runId, accountId: params.accountId, claimedByMachineId: params.machineId, attempt: params.parentAttempt, assignments: { some: { machineId: params.machineId } }, revision: params.expectedRevision, state: { in: ["queued", "claimed", "running"] }, workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: { not: null }, workflowCheckpointEnvelope: null }, select: { id: true } });
        if (!run) throw new WorkflowRunServiceError("currentness_conflict");
        if (await tx.workflowRunInvocation.findUnique({ where: { id: params.rootInvocation.id }, select: { id: true } })) throw new WorkflowRunServiceError("currentness_conflict");
        const roots = await tx.workflowRunInvocation.count({ where: { runId: params.runId, parentRecordId: null } });
        if (roots !== 0) throw new WorkflowRunServiceError("currentness_conflict");
        await tx.workflowRunInvocation.create({ data: { id: params.rootInvocation.id, runId: params.runId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n, attempt: 0n, lifecycle: "pending", contentEnvelope: params.rootInvocation.contentEnvelope } });
        const parent = await tx.automationRun.update({
            where: { id: params.runId },
            data: { workflowCheckpointEnvelope: params.checkpointEnvelope, state: "running", startedAt: new Date(), revision: { increment: 1 } },
            select: workflowRunSelect,
        });
        await markWorkflowRunChangedTx(tx, params.accountId, params.runId);
        return { run: await projectRunInTx(tx, parent as WorkflowRunProjectionRow, params.accountId), initialization: "created" as const };
    }, {
        // Ordered publication locks/replay and mode/control/row predicates fence this mutation.
        isolationLevel: "ReadCommitted",
        transactionClass: "workflow-initialize-run-execution",
    });
}

export async function admitWorkflowInvocations(params: Readonly<{
    accountId: string; runId: string; machineId: string; parentAttempt: number; expectedRevision: number; checkpointEnvelope: string;
    invocations: readonly Readonly<{
        id: string; sequence: bigint; parentRecordId: string; memberOrdinal: bigint;
        lifecycle?: "pending" | "waiting_for_capacity"; contentEnvelope: string;
        replaces?: Readonly<{ id: string; attempt: bigint; contentRevision: bigint }>;
    }>[];
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
}>) {
    if (params.invocations.length === 0 || !Number.isSafeInteger(params.parentAttempt) || params.parentAttempt < 0) throw new WorkflowRunServiceError("invalid_input");
    return await inTx(async (tx) => {
        const invocationIds = params.invocations.map((invocation) => invocation.id);
        if (new Set(invocationIds).size !== invocationIds.length) throw new WorkflowRunServiceError("invalid_input");
        if (new Set(params.invocations.map((item) => JSON.stringify([item.parentRecordId, item.memberOrdinal.toString()]))).size !== params.invocations.length) throw new WorkflowRunServiceError("invalid_input");
        for (const invocation of params.invocations) {
            if (!WorkflowInvocationRecordIdSchema.safeParse(invocation.id).success
                || invocation.sequence < 0n || invocation.sequence > MAX_DATABASE_BIGINT
                || invocation.memberOrdinal < 0n || invocation.memberOrdinal > MAX_DATABASE_BIGINT) {
                throw new WorkflowRunServiceError("invalid_input");
            }
            if (invocation.replaces && (!WorkflowInvocationRecordIdSchema.safeParse(invocation.replaces.id).success
                || invocation.replaces.id === invocation.id || invocation.replaces.attempt < 0n
                || invocation.replaces.attempt >= MAX_DATABASE_BIGINT || invocation.replaces.contentRevision < 0n
                || invocation.replaces.contentRevision >= MAX_DATABASE_BIGINT)) throw new WorkflowRunServiceError("invalid_input");
        }
        const mode = await loadCurrentWorkflowAccountModeTx(tx, params.accountId, params.accountCurrentness, params.runId);
        assertWorkflowStoredEnvelopeOuterForMode({ raw: params.checkpointEnvelope, mode, binding: { v: 1, purpose: "checkpoint", accountId: params.accountId, runId: params.runId } });
        for (const invocation of params.invocations) {
            assertWorkflowStoredEnvelopeOuterForMode({
                raw: invocation.contentEnvelope,
                mode,
                binding: {
                    v: 1,
                    purpose: "invocation_progress",
                    accountId: params.accountId,
                    runId: params.runId,
                    recordId: invocation.id,
                    sequence: invocation.sequence.toString(),
                    parentRecordId: invocation.parentRecordId,
                    memberOrdinal: invocation.memberOrdinal.toString(),
                    attempt: (invocation.replaces ? invocation.replaces.attempt + 1n : 0n).toString(),
                },
            });
        }
        const current = await tx.automationRun.findFirst({
            where: { id: params.runId, accountId: params.accountId, claimedByMachineId: params.machineId, attempt: params.parentAttempt, assignments: { some: { machineId: params.machineId } }, workflowCustodyState: "pending", workflowCheckpointEnvelope: { not: null } },
            select: { revision: true, workflowCheckpointEnvelope: true },
        });
        if (!current) throw new WorkflowRunServiceError("currentness_conflict");
        const existingRows = await tx.workflowRunInvocation.findMany({ where: { id: { in: invocationIds } }, select: invocationSelect }) as InvocationRow[];
        if (existingRows.length > 0) {
            const byId = new Map(existingRows.map((row) => [row.id, row]));
            const previousRows = await tx.workflowRunInvocation.findMany({ where: { runId: params.runId,
                id: { in: params.invocations.flatMap((item) => item.replaces ? [item.replaces.id] : []) } }, select: invocationSelect }) as InvocationRow[];
            const previousById = new Map(previousRows.map((row) => [row.id, row]));
            const exact = existingRows.length === params.invocations.length
                && current.revision === params.expectedRevision + 1
                && current.workflowCheckpointEnvelope === params.checkpointEnvelope
                && params.invocations.every((invocation) => {
                    const row = byId.get(invocation.id);
                    return row?.runId === params.runId
                        && row.parentRecordId === invocation.parentRecordId
                        && row.sequence === invocation.sequence
                        && row.memberOrdinal === invocation.memberOrdinal
                        && row.attempt === (invocation.replaces ? invocation.replaces.attempt + 1n : 0n)
                        && row.contentRevision === 0n
                        && row.lifecycle === (invocation.lifecycle ?? "pending")
                        && row.contentEnvelope === invocation.contentEnvelope
                        && (!invocation.replaces || (() => {
                            const previous = previousById.get(invocation.replaces.id);
                            return previous?.parentRecordId === invocation.parentRecordId
                                && previous.memberOrdinal === invocation.memberOrdinal
                                && previous.attempt === invocation.replaces.attempt
                                && previous.contentRevision === invocation.replaces.contentRevision + 1n
                                && previous.lifecycle === "superseded";
                        })());
                });
            if (!exact) throw new WorkflowRunServiceError("currentness_conflict");
            return {
                invocations: params.invocations.map((invocation) => projectInvocation(byId.get(invocation.id)!)),
                parentRevision: current.revision,
                disposition: "existing" as const,
            };
        }
        if (current.revision !== params.expectedRevision) throw new WorkflowRunServiceError("currentness_conflict");
        const parentIds = [...new Set(params.invocations.map((item) => item.parentRecordId))];
        const validParents = await tx.workflowRunInvocation.count({ where: { runId: params.runId, id: { in: parentIds } } });
        if (validParents !== parentIds.length) throw new WorkflowRunServiceError("invalid_input");
        const newSlots = params.invocations.filter((invocation) => !invocation.replaces);
        const occupiedSlots = newSlots.length === 0 ? 0 : await tx.workflowRunInvocation.count({ where: {
            runId: params.runId,
            OR: newSlots.map((invocation) => ({ parentRecordId: invocation.parentRecordId, memberOrdinal: invocation.memberOrdinal })),
        } });
        if (occupiedSlots !== 0) throw new WorkflowRunServiceError("currentness_conflict");
        for (const invocation of params.invocations) {
            if (!invocation.replaces) continue;
            const previous = await tx.workflowRunInvocation.findFirst({ where: { id: invocation.replaces.id,
                runId: params.runId, parentRecordId: invocation.parentRecordId, memberOrdinal: invocation.memberOrdinal,
                attempt: invocation.replaces.attempt, contentRevision: invocation.replaces.contentRevision, lifecycle: "waiting_for_review" }, select: invocationSelect }) as InvocationRow | null;
            if (!previous) throw new WorkflowRunServiceError("currentness_conflict");
            await assertCurrentWorkflowInvocationTx(tx, previous);
        }
        const max = await tx.workflowRunInvocation.aggregate({ where: { runId: params.runId }, _max: { sequence: true } });
        const nextSequence = (max._max.sequence ?? -1n) + 1n;
        if (nextSequence + BigInt(params.invocations.length) - 1n > MAX_DATABASE_BIGINT
            || params.invocations.some((invocation, index) => invocation.sequence !== nextSequence + BigInt(index))) {
            throw new WorkflowRunServiceError("currentness_conflict");
        }
        const deliveryBefore = await readOriginDeliverySignalTx(tx, params.accountId, params.runId);
        const changed = await tx.automationRun.updateMany({ where: { ...workflowInputAdmissionWhere(params), revision: params.expectedRevision }, data: { workflowCheckpointEnvelope: params.checkpointEnvelope, revision: { increment: 1 } } });
        if (changed.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
        const created: InvocationRow[] = [];
        for (const invocation of params.invocations) {
            if (invocation.replaces) {
                const superseded = await tx.workflowRunInvocation.updateMany({ where: { id: invocation.replaces.id,
                    runId: params.runId, parentRecordId: invocation.parentRecordId, memberOrdinal: invocation.memberOrdinal,
                    attempt: invocation.replaces.attempt, contentRevision: invocation.replaces.contentRevision, lifecycle: "waiting_for_review" },
                    data: { lifecycle: "superseded", contentRevision: { increment: 1 } } });
                if (superseded.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
            }
            created.push(await tx.workflowRunInvocation.create({ data: {
                id: invocation.id,
                runId: params.runId,
                sequence: invocation.sequence,
                parentRecordId: invocation.parentRecordId,
                memberOrdinal: invocation.memberOrdinal,
                attempt: invocation.replaces ? invocation.replaces.attempt + 1n : 0n,
                lifecycle: invocation.lifecycle ?? "pending",
                contentEnvelope: invocation.contentEnvelope,
            }, select: invocationSelect }) as InvocationRow);
        }
        await markWorkflowRunChangedTx(tx, params.accountId, params.runId, deliveryBefore);
        return { invocations: created.map(projectInvocation), parentRevision: params.expectedRevision + 1, disposition: "created" as const };
    }, {
        // Ordered publication locks/replay and mode/control/row predicates fence this mutation.
        isolationLevel: "ReadCommitted",
        transactionClass: "workflow-admit-invocations",
    });
}

/** Workflow identity in shared AutomationRun storage, without disclosing content. */
export function workflowRunIdentityWhere(params: Readonly<{ accountId: string; runId: string }>): Prisma.AutomationRunWhereInput {
    return { id: params.runId, accountId: params.accountId, workflowCustodyState: { not: null }, workflowAcceptedSnapshotEnvelope: { not: null } };
}

export async function getWorkflowRun(params: Readonly<{ accountId: string; runId: string }>) {
    return await inTx(async (tx) => {
        const keyCensus = await withWorkflowRunAccess(() => readWorkflowRunKeyProjectionInTx(tx, { actorAccountId: params.accountId, runId: params.runId }));
        const mode = keyCensus.encryptionMode;
        const row = await tx.automationRun.findFirst({ where: {
            id: params.runId, accountId: keyCensus.ownerAccountId, workflowCustodyState: { not: null },
        }, select: workflowRunSelect });
        if (!row) throw new WorkflowRunServiceError("run_not_found");
        if (row.workflowAcceptedSnapshotEnvelope === null) throw new WorkflowRunServiceError("content_unavailable");
        assertWorkflowStoredEnvelopeOuterForMode({ raw: row.workflowAcceptedSnapshotEnvelope, mode, binding: { v: 1, purpose: "accepted_snapshot", accountId: keyCensus.ownerAccountId, runId: params.runId } });
        if (row.workflowCheckpointEnvelope !== null) assertWorkflowStoredEnvelopeOuterForMode({ raw: row.workflowCheckpointEnvelope, mode, binding: { v: 1, purpose: "checkpoint", accountId: keyCensus.ownerAccountId, runId: params.runId } });
        if (row.resultEnvelope !== null) assertWorkflowStoredEnvelopeOuterForMode({ raw: row.resultEnvelope, mode, binding: { v: 1, purpose: "final_result", accountId: keyCensus.ownerAccountId, runId: params.runId } });
        const root = await tx.workflowRunInvocation.findFirst({ where: { runId: params.runId,
            parentRecordId: null, sequence: 0n, memberOrdinal: 0n, attempt: 0n }, select: invocationSelect });
        return { run: await projectRunInTx(tx, row as WorkflowRunProjectionRow, params.accountId), acceptedEnvelope: row.workflowAcceptedSnapshotEnvelope, checkpointEnvelope: row.workflowCheckpointEnvelope, resultEnvelope: row.resultEnvelope, keyCensus,
            rootProgress: projectWorkflowRootProgress(root, keyCensus) };
    }, { isolationLevel: "ReadCommitted", transactionClass: "workflow-get-run" });
}

/** Acknowledge only the owner's exact presented failure, without advancing operational revision or lifecycle. */
export async function setWorkflowRunReadState(params: Readonly<{ accountId: string; runId: string; revision: number; failedAt: string }>) {
    return inTx(async tx => {
        const access = await resolveWorkflowRunAccessTx(tx, { actorAccountId: params.accountId, runId: params.runId });
        if (access.ownerAccountId !== params.accountId) throw new WorkflowRunServiceError('run_access_denied');
        await acquireWorkflowPublicationLocksInTx(tx, { accountId: params.accountId, runIds: [params.runId] });
        const row = await tx.automationRun.findFirst({ where: workflowRunIdentityWhere(params),
            select: { state: true, revision: true, finishedAt: true, attentionSeenFailureAt: true, updatedAt: true } });
        if (!row) throw new WorkflowRunServiceError('run_not_found');
        if (row.state !== 'failed' || row.finishedAt === null || row.finishedAt.toISOString() !== params.failedAt) {
            throw new WorkflowRunServiceError('currentness_conflict');
        }
        if (row.attentionSeenFailureAt?.getTime() === row.finishedAt.getTime()) {
            return { runId: params.runId, attentionSeenFailureAt: row.attentionSeenFailureAt.toISOString() };
        }
        if (row.revision !== params.revision) throw new WorkflowRunServiceError('currentness_conflict');
        const changed = await tx.automationRun.updateMany({
            where: { ...workflowRunIdentityWhere(params), state: 'failed', revision: params.revision, finishedAt: row.finishedAt },
            data: { attentionSeenFailureAt: row.finishedAt, updatedAt: row.updatedAt },
        });
        if (changed.count !== 1) throw new WorkflowRunServiceError('currentness_conflict');
        // Seen changes only this owner's notice. The operational publication path also
        // admits lifecycle Automations and changes delivery revisions, so it does not own this write.
        await markAccountsChanged(tx, { accountIds: [params.accountId], kind: 'account', entityId: `workflow-run:${params.runId}` });
        return { runId: params.runId, attentionSeenFailureAt: row.finishedAt.toISOString() };
    }, { isolationLevel: 'ReadCommitted', transactionClass: 'workflow-run-read-state' });
}

type PageOptions = Readonly<{ cursor?: string; limit?: number; pageByteLimit: number }>;

const ORIGIN_INPUT_CANDIDATE_LIFECYCLES = ["admitting", "cancel_requested"] as const;

/** Origin runtimes reconcile committed snapshots, including inputs whose control closed while offline. */
export async function pullWorkflowRunOriginDelivery(params: PageOptions & Readonly<{ accountId: string; originSessionId: string }>) {
    if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit <= 0)) throw new WorkflowRunServiceError("invalid_input");
    const queryKey = JSON.stringify({ accountId: params.accountId, originSessionId: params.originSessionId, selector: "workflow_origin_delivery_v1" });
    const decoded = params.cursor ? decodeKeysetCursorV1(params.cursor, queryKey) : null;
    const afterDate = decoded?.status === "ok" ? readKeysetCursorTextV1(decoded.parts[0]) : null;
    const afterId = decoded?.status === "ok" ? readKeysetCursorIdV1(decoded.parts[1]) : null;
    if (params.cursor && (!afterDate || !afterId)) throw new WorkflowRunServiceError("invalid_input");
    type RawDeliveryCandidate = Readonly<{ row: WorkflowRunFullRow; invocationAttentionRequired: boolean }>;
    const rawPage = await inReadSnapshot(async (tx) => {
        const session = await tx.session.findFirst({ where: { id: params.originSessionId, accountId: params.accountId }, select: { id: true } });
        if (!session) throw new WorkflowRunServiceError("run_not_found");
        const mode = await readAccountModeTx(tx, params.accountId);
        const wanted = params.limit ?? Number.POSITIVE_INFINITY;
        let pageAfterDate = afterDate;
        let pageAfterId = afterId;
        const collected: RawDeliveryCandidate[] = [];
        for (;;) {
            const batchSize = Math.min(wanted - collected.length, WORKFLOW_PAGE_DATABASE_BATCH_ROWS);
            const rows = await tx.automationRun.findMany({
                where: {
                    accountId: params.accountId, originSessionId: params.originSessionId,
                    workflowCustodyState: { not: null }, workflowAcceptedSnapshotEnvelope: { not: null },
                    OR: [
                        { originDeliveryAckRevision: { not: null }, revision: { gt: tx.automationRun.fields.originDeliveryAckRevision } },
                        { workflowInvocations: { some: { lifecycle: { in: [...ORIGIN_INPUT_CANDIDATE_LIFECYCLES] } } } },
                    ],
                    ...(pageAfterDate && pageAfterId ? { AND: [{ OR: [
                        { createdAt: { lt: new Date(pageAfterDate) } }, { createdAt: new Date(pageAfterDate), id: { lt: pageAfterId } },
                    ] }] } : {}),
                },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: batchSize + 1,
                select: { ...workflowRunSelect, workflowInvocations: { where: { lifecycle: { in: [...ORIGIN_INPUT_CANDIDATE_LIFECYCLES] } }, take: 1, select: { id: true } } },
            }) as WorkflowRunFullRow[];
            const candidates = rows.slice(0, batchSize);
            const attentionIds = await readWorkflowRunInvocationAttentionInTx(tx, candidates.map(row => row.id));
            const batchHasMore = rows.length > batchSize;
            collected.push(...candidates.map(row => ({ row, invocationAttentionRequired: attentionIds.has(row.id) })));
            if (collected.length >= wanted || !batchHasMore) return { mode, candidates: collected, hasMore: batchHasMore };
            const last = candidates.at(-1);
            if (!last) return { mode, candidates: collected, hasMore: false };
            pageAfterDate = last.createdAt.toISOString();
            pageAfterId = last.id;
        }
    }, { transactionClass: "workflow-pull-run-origin-delivery" });
    type DeliverySnapshot = { run: WorkflowRunSummaryV1; acceptedEnvelope: string; checkpointEnvelope: string | null; resultEnvelope: string | null; invocations: never[]; hasOriginInputCandidates: boolean };
    const snapshots: DeliverySnapshot[] = rawPage.candidates.map(({ row, invocationAttentionRequired }) => {
        assertWorkflowStoredEnvelopeOuterForMode({ raw: row.workflowAcceptedSnapshotEnvelope!, mode: rawPage.mode, binding: { v: 1, purpose: "accepted_snapshot", accountId: params.accountId, runId: row.id } });
        if (row.workflowCheckpointEnvelope !== null) assertWorkflowStoredEnvelopeOuterForMode({ raw: row.workflowCheckpointEnvelope, mode: rawPage.mode, binding: { v: 1, purpose: "checkpoint", accountId: params.accountId, runId: row.id } });
        if (row.resultEnvelope !== null) assertWorkflowStoredEnvelopeOuterForMode({ raw: row.resultEnvelope, mode: rawPage.mode, binding: { v: 1, purpose: "final_result", accountId: params.accountId, runId: row.id } });
        // Candidate progress uses the existing byte-paged invocation owner, so even
        // a Run with many valid parallel inputs never exceeds a grouped snapshot page.
        return { run: projectRun({ ...row, invocationAttentionRequired }, params.accountId), acceptedEnvelope: row.workflowAcceptedSnapshotEnvelope!, checkpointEnvelope: row.workflowCheckpointEnvelope, resultEnvelope: row.resultEnvelope, invocations: [], hasOriginInputCandidates: row.workflowInvocations.length > 0 };
    });
    const cursorFor = (snapshot: DeliverySnapshot) => encodeKeysetCursorV1({ queryKey, parts: [snapshot.run.createdAt, snapshot.run.id] });
    const bounded = appendBoundedPage({ existing: [], existingBytes: 2, candidates: snapshots,
        byteLimit: params.pageByteLimit, serializeMembers: (snapshot) => [JSON.stringify(snapshot)],
        emptyPage: (nextCursor) => ({ runs: [], nextCursor: nextCursor ?? null }), nextCursorFor: cursorFor,
        hasMoreAfter: (index) => index < snapshots.length - 1 || rawPage.hasMore });
    const last = bounded.rows.at(-1);
    return { runs: bounded.rows, nextCursor: (bounded.shortened || rawPage.hasMore) && last ? cursorFor(last) : null };
}

/** Acknowledgement suppresses only the owner's already-composed snapshot and never changes Run custody. */
export async function ackWorkflowRunOriginDelivery(params: Readonly<{ accountId: string; runId: string; revision: number }>) {
    if (!Number.isSafeInteger(params.revision) || params.revision < 0) throw new WorkflowRunServiceError("invalid_input");
    return await inTx(async (tx) => {
        await loadAccountModeTx(tx, params.accountId);
        const row = await tx.automationRun.findFirst({ where: workflowRunIdentityWhere(params), select: { revision: true, originDeliveryAckRevision: true, updatedAt: true } });
        if (!row) throw new WorkflowRunServiceError("run_not_found");
        if (row.originDeliveryAckRevision === null || params.revision > row.revision) throw new WorkflowRunServiceError("invalid_input");
        await tx.automationRun.updateMany({
            where: { ...workflowRunIdentityWhere(params), revision: { gte: params.revision }, originDeliveryAckRevision: { lt: params.revision } },
            data: { originDeliveryAckRevision: params.revision, updatedAt: row.updatedAt },
        });
        return { acknowledgedRevision: (await tx.automationRun.findUniqueOrThrow({ where: { id: params.runId }, select: { originDeliveryAckRevision: true } })).originDeliveryAckRevision! };
    }, { transactionClass: "workflow-ack-run-origin-delivery" });
}

/**
 * Appends rows while measuring the complete response shape. The empty-page
 * measurement supplies the exact wrapper, cursor, and external Action framing
 * bytes. Each row contributes exactly its serialized members — one per page
 * collection it appears in (for example a Run array element and its
 * `"runId":envelope` sidecar member) plus one separator per member after the
 * first row — so a 24 MB page does not require repeatedly serializing its
 * growing prefix.
 */
export function appendBoundedPage<T>(params: Readonly<{
    existing: readonly T[];
    existingBytes: number;
    candidates: readonly T[];
    byteLimit: number;
    serializeMembers: (row: T) => readonly string[];
    emptyPage: (nextCursor?: string) => unknown;
    nextCursorFor: (row: T) => string;
    hasMoreAfter: (candidateIndex: number) => boolean;
    measurePage?: (page: unknown) => number;
}>): { rows: T[]; bytes: number; shortened: boolean } {
    const { existing, existingBytes, candidates, byteLimit } = params;
    if (!Number.isSafeInteger(byteLimit) || byteLimit <= 0) throw new WorkflowRunServiceError("invalid_input");
    const kept = [...existing];
    let bytes = existingBytes;
    const measurePage = params.measurePage ?? measureExternalActionResultResponseEnvelopeUtf8BytesV1;
    for (const [candidateIndex, row] of candidates.entries()) {
        const members = params.serializeMembers(row);
        let rowBytes = kept.length === 0 ? 0 : members.length;
        for (const member of members) rowBytes += Buffer.byteLength(member, "utf8");
        const nextCursor = params.hasMoreAfter(candidateIndex) ? params.nextCursorFor(row) : undefined;
        const pageOverheadBytes = measurePage(params.emptyPage(nextCursor)) - 2;
        if (kept.length > 0 && bytes + rowBytes + pageOverheadBytes > byteLimit) {
            return { rows: kept, bytes, shortened: true };
        }
        if (bytes + rowBytes + pageOverheadBytes > byteLimit) throw new WorkflowRunServiceError("content_unavailable");
        kept.push(row);
        bytes += rowBytes;
    }
    return { rows: kept, bytes, shortened: false };
}

/** Every collection filter narrows the same owner-or-live-Team audience. */
export type WorkflowRunCallerScope = Readonly<{ accountId: string; sourceArtifactId?: string }>;
async function workflowRunCallerScopeWhereTx(tx: Tx, scope: WorkflowRunCallerScope): Promise<Prisma.AutomationRunWhereInput> {
    const visibility = await withWorkflowRunAccess(() => resolveWorkflowRunVisibilityScopesInTx(tx, {
        actorAccountId: scope.accountId, ...(scope.sourceArtifactId ? { sourceArtifactIds: [scope.sourceArtifactId] } : {}),
    }));
    return { ...(scope.sourceArtifactId ? { sourceArtifactId: scope.sourceArtifactId } : {}), OR: [
        { accountId: scope.accountId },
        ...visibility.map(scope => ({ sourceArtifactId: scope.sourceArtifactId, visibleTeamId: { in: [...scope.visibleTeamIds] } })),
    ] };
}

export async function listWorkflowRuns(params: PageOptions & Readonly<{
    accountId: string; runId?: string; origin?: "automation" | "direct"; states?: readonly WorkflowRunState[]; attention?: "required";
    runIds?: readonly string[];
    invocationProvenance?: readonly Readonly<{ runId: string; invocationRecordIds: readonly string[] }>[];
    originSessionId?: string; targetSessionId?: string; underSessionId?: string; automationId?: string; machineId?: string; sourceArtifactId?: string;
    projection?: "membership";
}>) {
    if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit <= 0)) throw new WorkflowRunServiceError("invalid_input");
    const membershipOnly = params.projection === "membership";
    if (membershipOnly) {
        const { accountId: _accountId, pageByteLimit: _pageByteLimit, ...request } = params;
        if (!WorkflowRunListRequestV1Schema.safeParse(request).success) throw new WorkflowRunServiceError("invalid_input");
    }
    // The exact-Run selection is part of the cursor binding like every other
    // filter, so a cursor minted for a collection page cannot be replayed as
    // an exact read or vice versa. The lookup itself stays the lean list
    // projection with exact opaque accepted/root sidecars, uniform keyset
    // pagination. Only attention pages add the first held invocation; no history or usage reads.
    // Destinations remain private; the Action owner filters opened snapshots.
    // Bind its selection to the same storage cursor to reject cross-filter replay.
    const queryKey = JSON.stringify({ accountId: params.accountId, sourceArtifactId: params.sourceArtifactId ?? null, runId: params.runId ?? null,
        runIds: params.runIds ? [...params.runIds].sort() : null, invocationProvenance: params.invocationProvenance ?? null,
        origin: params.origin ?? null, states: [...(params.states ?? [])].sort(), attention: params.attention ?? null, originSessionId: params.originSessionId ?? null, targetSessionId: params.targetSessionId ?? null, underSessionId: params.underSessionId ?? null, automationId: params.automationId ?? null, machineId: params.machineId ?? null,
        ...(membershipOnly ? { projection: params.projection } : {}) });
    const decoded = params.cursor ? decodeKeysetCursorV1(params.cursor, queryKey) : null;
    const afterDate = decoded?.status === "ok" ? readKeysetCursorTextV1(decoded.parts[0]) : null;
    const afterId = decoded?.status === "ok" ? readKeysetCursorIdV1(decoded.parts[1]) : null;
    if (params.cursor && (!afterDate || !afterId)) throw new WorkflowRunServiceError("invalid_input");
    const captureBatch = async (tx: Tx, pageAfterDate: string | null, pageAfterId: string | null, remaining: number) => {
        const batchSize = Math.min(remaining, WORKFLOW_PAGE_DATABASE_BATCH_ROWS);
        const callerScope = await workflowRunCallerScopeWhereTx(tx, params);
        const additionalWhere: Prisma.AutomationRunWhereInput[] = [];
        if (params.runIds) additionalWhere.push({ id: { in: [...params.runIds] } });
        if (params.attention === "required") {
            additionalWhere.push(workflowRunAttentionWhere(params.accountId));
        }
        if (pageAfterDate && pageAfterId) {
            additionalWhere.push({
                OR: [
                    { createdAt: { lt: new Date(pageAfterDate) } },
                    { createdAt: new Date(pageAfterDate), id: { lt: pageAfterId } },
                ],
            });
        }
        const rows = await tx.automationRun.findMany({
            where: {
                ...callerScope,
                workflowCustodyState: { not: null },
                ...(params.runId ? { id: params.runId } : {}),
                ...(params.origin ? { originKind: params.origin } : {}),
                ...(params.states ? { state: { in: [...params.states] } } : {}),
                ...(params.originSessionId ? { originSessionId: params.originSessionId } : {}),
                ...(params.automationId ? { automationId: params.automationId } : {}),
                ...(params.machineId ? { assignments: { some: { machineId: params.machineId } } } : {}),
                ...(additionalWhere.length > 0 ? { AND: additionalWhere } : {}),
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: batchSize + 1,
            select: membershipOnly ? { ...workflowRunListSelect, workflowAcceptedSnapshotEnvelope: false } : workflowRunListSelect,
        }) as WorkflowRunListCapturedRow[];
        const candidateRows = rows.slice(0, batchSize);
        const roots = membershipOnly || candidateRows.length === 0 ? [] : await tx.workflowRunInvocation.findMany({
            where: { runId: { in: candidateRows.map((row) => row.id) }, parentRecordId: null,
                sequence: 0n, memberOrdinal: 0n, attempt: 0n }, select: invocationSelect,
        });
        // One bounded relation per visible page member, matching the Inbox's first-hold intent.
        // Keep the ordinary execution-exists relation independent of attention membership.
        const heldRuns = membershipOnly || params.attention !== "required" || candidateRows.length === 0 ? [] : await tx.automationRun.findMany({
            where: { id: { in: candidateRows.map(row => row.id) } },
            select: { id: true, workflowInvocations: { where: { lifecycle: "waiting_for_review" },
                orderBy: { sequence: "asc" }, take: 1, select: invocationSelect } },
        });
        const candidateIds = new Set(candidateRows.map(row => row.id));
        const selectedReferences = params.invocationProvenance?.filter(ref => candidateIds.has(ref.runId)
            && ref.invocationRecordIds.length > 0) ?? [];
        // This is one exact-index query over visible page members, never a history traversal.
        const selectedInvocations = selectedReferences.length === 0 ? [] : await tx.workflowRunInvocation.findMany({
            where: { OR: selectedReferences.map(ref => ({ runId: ref.runId, id: { in: [...ref.invocationRecordIds] } })) },
            select: invocationSelect,
        });
        // The same page-sized invocation index supplies the independent hold
        // constituent even when failure alone admitted an attention member.
        const attentionIds = await readWorkflowRunInvocationAttentionInTx(tx, candidateRows.map(row => row.id));
        const pageKeys = await withWorkflowRunAccess(() => readWorkflowRunKeyProjectionsInTx(tx, {
            actorAccountId: params.accountId, runIds: candidateRows.map(candidate => candidate.id),
        }));
        return { candidateRows, roots, heldRuns, selectedInvocations, attentionIds, pageKeys, batchHasMore: rows.length > batchSize };
    };
    // Exact page bytes depend on validation. Keep the existing incremental
    // fetch boundary while the canonical helper releases capture before CPU
    // work and readmits the completed page through a fresh coherent snapshot.
    const page = await readSnapshotWithCurrentAdmission({
        capture: tx => captureBatch(tx, afterDate, afterId, params.limit ?? Number.POSITIVE_INFINITY),
        materialize: async firstBatch => {
            const wanted = params.limit ?? Number.POSITIVE_INFINITY;
            let pageAfterDate = afterDate;
            let pageAfterId = afterId;
            let collected: Array<WorkflowRunListCapturedRow & { workflowAcceptedSnapshotEnvelope: string | null; keyCensus: WorkflowRunRecipientCensusResponseV1;
                invocationProgress: Array<{ index: ReturnType<typeof projectInvocation>; contentEnvelope: string }>;
                heldProgress: { index: ReturnType<typeof projectInvocation>; contentEnvelope: string } | null;
                rootProgress: { index: ReturnType<typeof projectInvocation>; contentEnvelope: string } | null }> = [];
            let collectedBytes = 2;
            let captured = firstBatch;
            for (;;) {
                const { candidateRows, roots, heldRuns, selectedInvocations, attentionIds, pageKeys, batchHasMore } = captured;
                const { candidates, bounded } = await timeWebLatencyPhase('workflow.list.materialize', () => {
                    const rootsByRunId = new Map(roots.map(row => [row.runId, row]));
                    const heldByRunId = new Map(heldRuns.map(row => [row.id, row.workflowInvocations[0]]));
                    const candidates = candidateRows.map((candidate) => {
                        const keyCensus = pageKeys.get(candidate.id);
                        if (!keyCensus) throw new WorkflowRunServiceError("run_not_found");
                        const root = rootsByRunId.get(candidate.id);
                        const rootProgress = projectWorkflowRootProgress(root, keyCensus);
                        const projectPrivateInvocation = (row: (typeof selectedInvocations)[number]) => {
                            try {
                                assertWorkflowStoredEnvelopeOuterForMode({ raw: row.contentEnvelope, mode: keyCensus.encryptionMode,
                                    binding: { v: 1, purpose: "invocation_progress", accountId: keyCensus.ownerAccountId, runId: row.runId,
                                        recordId: row.id, sequence: row.sequence.toString(), parentRecordId: row.parentRecordId,
                                        memberOrdinal: row.memberOrdinal.toString(), attempt: row.attempt.toString() } });
                                return { index: projectInvocation(row), contentEnvelope: row.contentEnvelope };
                            } catch (error) {
                                if (!(error instanceof WorkflowStoredContentError)) throw error;
                                return null;
                            }
                        };
                        const invocationProgress = selectedInvocations.filter(row => row.runId === candidate.id).flatMap(row => {
                            const progress = projectPrivateInvocation(row);
                            return progress ? [progress] : [];
                        });
                        const held = heldByRunId.get(candidate.id);
                        const heldProgress = held ? projectPrivateInvocation(held) : null;
                        const row = { ...candidate, workflowAcceptedSnapshotEnvelope: candidate.workflowAcceptedSnapshotEnvelope ?? null,
                            invocationAttentionRequired: attentionIds.has(candidate.id), keyCensus, rootProgress, invocationProgress, heldProgress };
                        if (membershipOnly || row.workflowAcceptedSnapshotEnvelope === null) return row;
                        try {
                            assertWorkflowStoredEnvelopeOuterForMode({
                                raw: row.workflowAcceptedSnapshotEnvelope,
                                mode: keyCensus.encryptionMode,
                                binding: { v: 1, purpose: "accepted_snapshot", accountId: keyCensus.ownerAccountId, runId: row.id },
                            });
                            return row;
                        } catch (error) {
                            if (!(error instanceof WorkflowStoredContentError)) throw error;
                            return { ...row, workflowAcceptedSnapshotEnvelope: null };
                        }
                    });
                    const bounded = appendBoundedPage({
                        existing: collected,
                        existingBytes: collectedBytes,
                        candidates,
                        byteLimit: params.pageByteLimit,
                        // Each Run occupies the `runs` array and the private accepted
                        // sidecar object, so it contributes both exact members.
                        serializeMembers: (row) => membershipOnly ? [JSON.stringify(projectRun(row as WorkflowRunRow, params.accountId))] : [
                            JSON.stringify(projectRun(row as WorkflowRunRow, params.accountId)),
                            `${JSON.stringify(row.id)}:${JSON.stringify(row.workflowAcceptedSnapshotEnvelope)}`,
                            `${JSON.stringify(row.id)}:${JSON.stringify(row.keyCensus)}`,
                            `${JSON.stringify(row.id)}:${JSON.stringify(row.rootProgress)}`,
                            ...(params.attention === "required" ? [`${JSON.stringify(row.id)}:${JSON.stringify(row.heldProgress)}`] : []),
                            ...(params.invocationProvenance ? [`${JSON.stringify(row.id)}:${JSON.stringify(row.invocationProgress)}`] : []),
                        ],
                        emptyPage: (nextCursor) => ({ ...(membershipOnly ? { projection: "membership" } : {}),
                            runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {}, rootProgressByRunId: {},
                            ...(params.attention === "required" ? { heldProgressByRunId: {} } : {}),
                            ...(params.invocationProvenance ? { invocationProgressByRunId: {} } : {}), ...(nextCursor ? { nextCursor } : {}) }),
                        nextCursorFor: (row) => encodeKeysetCursorV1({ queryKey, parts: [row.createdAt.toISOString(), row.id] }),
                        hasMoreAfter: (candidateIndex) => candidateIndex < candidates.length - 1 || batchHasMore,
                    });
                    return { candidates, bounded };
                }, 'workflow-list-runs');
                if (bounded.shortened) return { ...bounded, hasMore: true };
                collected = bounded.rows;
                collectedBytes = bounded.bytes;
                if (collected.length >= wanted || !batchHasMore) return { rows: collected, hasMore: batchHasMore };
                const last = candidates.at(-1);
                if (!last) return { rows: collected, hasMore: true };
                pageAfterDate = last.createdAt.toISOString();
                pageAfterId = last.id;
                captured = await inReadSnapshot(tx => captureBatch(tx, pageAfterDate, pageAfterId, wanted - collected.length),
                    { transactionClass: "workflow-list-runs" });
            }
        },
    }, async (tx, page) => {
        // Materialization no longer owns a native transaction. Readmit the exact
        // disclosed members together, through the same live audience/key owner.
        // Account seq is a general change cursor: unrelated writes must not revoke
        // otherwise identical content. Mode/key identity and all recipient facts do.
        if (page.rows.length === 0) return page;
        const current = await withWorkflowRunAccess(() => readWorkflowRunKeyProjectionsInTx(tx, {
            actorAccountId: params.accountId, runIds: page.rows.map(row => row.id),
        }));
        for (const row of page.rows) {
            assertCapturedWorkflowRunKeysCurrent(row.keyCensus, current.get(row.id));
        }
        return page;
    }, { transactionClass: "workflow-list-runs" });
    const last = page.rows.at(-1);
    return {
        ...(membershipOnly ? { projection: "membership" as const } : {}),
        runs: page.rows.map(row => projectRun(row as WorkflowRunRow, params.accountId)),
        acceptedEnvelopesByRunId: Object.fromEntries(membershipOnly ? [] : page.rows.map((row) => [row.id, row.workflowAcceptedSnapshotEnvelope])),
        keyCensusByRunId: Object.fromEntries(membershipOnly ? [] : page.rows.map((row) => [row.id, row.keyCensus])),
        rootProgressByRunId: Object.fromEntries(membershipOnly ? [] : page.rows.map((row) => [row.id, row.rootProgress])),
        ...(params.attention === "required" ? { heldProgressByRunId: Object.fromEntries(membershipOnly ? [] : page.rows.map(row => [row.id, row.heldProgress])) } : {}),
        ...(params.invocationProvenance ? { invocationProgressByRunId: Object.fromEntries(page.rows.map(row => [row.id, row.invocationProgress])) } : {}),
        ...(page.hasMore && last ? { nextCursor: encodeKeysetCursorV1({ queryKey, parts: [last.createdAt.toISOString(), last.id] }) } : {}),
    };
}

function assertCapturedWorkflowRunKeysCurrent(before: WorkflowRunRecipientCensusResponseV1,
    after: WorkflowRunRecipientCensusResponseV1 | undefined): void {
    if (!after) throw new WorkflowRunServiceError('run_not_found');
    const { ownerAccountCurrentness: beforeIdentity, ...beforeFacts } = before;
    const { ownerAccountCurrentness: afterIdentity, ...afterFacts } = after;
    if (!sameAutomationAccountContentIdentityV1(beforeIdentity, afterIdentity) || !isDeepStrictEqual(beforeFacts, afterFacts)) {
        throw new WorkflowRunServiceError('currentness_conflict');
    }
}

/** SQL adapts the same canonical owner-or-frozen-Team audience as collection reads. */
async function workflowSummaryVisibilityInTx(tx: Tx, accountId: string, sourceArtifactIds?: readonly string[]) {
    const id = workflowRunSqlIdentifier;
    const scopes = await withWorkflowRunAccess(() => resolveWorkflowRunVisibilityScopesInTx(tx, {
        actorAccountId: accountId, ...(sourceArtifactIds ? { sourceArtifactIds } : {}),
    }));
    const sharedScopes = scopes.filter(scope => scope.visibleTeamIds.length > 0).map(scope => prismaRuntime.sql`
        (r.${id("sourceArtifactId")} = ${scope.sourceArtifactId} AND r.${id("visibleTeamId")} IN (${prismaRuntime.join([...scope.visibleTeamIds])}))`);
    return sharedScopes.length === 0 ? prismaRuntime.sql`r.${id("accountId")} = ${accountId}`
        : prismaRuntime.sql`(r.${id("accountId")} = ${accountId} OR ${prismaRuntime.join(sharedScopes, " OR ")})`;
}

type SourceSummaryReadParams = Readonly<{ accountId: string; sourceArtifactIds: readonly string[]; recent: number; pageByteLimit: number }>;
type AutomationSummaryReadParams = Readonly<{ accountId: string; automationIds: readonly string[]; pageByteLimit: number }>;
type SummaryReadParams = SourceSummaryReadParams | AutomationSummaryReadParams;

/** Both summary selections retain the same input-order, exact response-byte continuation policy. */
function workflowSummaryPage<Summary, Page>(params: Readonly<{
    ids: readonly string[]; pageByteLimit: number;
    summarize: (id: string) => Summary;
    page: (summaries: Summary[], remainingIds: string[]) => Page;
}>): Page {
    const summaries: Summary[] = [];
    for (const [index, id] of params.ids.entries()) {
        const summary = params.summarize(id);
        const candidate = params.page([...summaries, summary], params.ids.slice(index + 1));
        if (measureExternalActionResultResponseEnvelopeUtf8BytesV1(candidate) > params.pageByteLimit) {
            if (summaries.length === 0) throw new WorkflowRunServiceError("content_unavailable");
            const page = params.page(summaries, params.ids.slice(index));
            if (measureExternalActionResultResponseEnvelopeUtf8BytesV1(page) > params.pageByteLimit) throw new WorkflowRunServiceError("content_unavailable");
            return page;
        }
        summaries.push(summary);
    }
    return params.page(summaries, []);
}

/** One indexed summary owner; selectors do not load accepted/private content or issue per-card queries. */
export function summarizeWorkflowRuns(params: SourceSummaryReadParams): Promise<WorkflowRunSourceSummariesResultV1>;
export function summarizeWorkflowRuns(params: AutomationSummaryReadParams): Promise<WorkflowRunAutomationSummariesResultV1>;
export function summarizeWorkflowRuns(params: SummaryReadParams): Promise<WorkflowRunSummariesResultV1>;
export async function summarizeWorkflowRuns(params: SummaryReadParams): Promise<WorkflowRunSummariesResultV1> {
    if ("automationIds" in params) return await summarizeLatestAutomationRuns(params);
    if (!Number.isSafeInteger(params.recent) || params.recent <= 0
        || !Number.isSafeInteger(params.pageByteLimit) || params.pageByteLimit <= 0
        || new Set(params.sourceArtifactIds).size !== params.sourceArtifactIds.length) throw new WorkflowRunServiceError("invalid_input");
    if (params.sourceArtifactIds.length === 0) return { summaries: [], remainingSourceArtifactIds: [] };
    const id = workflowRunSqlIdentifier;
    type SummaryRow = {
        sourceArtifactId: string; runId: string; state: WorkflowRunState;
        workflowCustodyState: WorkflowCustodyState;
        attentionRequired: bigint | number; failureUnseen: bigint | number; invocationAttentionRequired: bigint | number;
        createdAt: Date | bigint | number; startedAt: Date | bigint | number | null; finishedAt: Date | bigint | number | null;
        ordinal: bigint | number; startedOrdinal: bigint | number; needsYouCount: bigint | number; needsYouRunId: string;
    };
    const rows = await inTx(async (tx) => {
        // The SQL adapter consumes the canonical source visibility decision;
        // it does not load content or issue per-card queries.
        const visibility = await workflowSummaryVisibilityInTx(tx, params.accountId, params.sourceArtifactIds);
        return await tx.$queryRaw<SummaryRow[]>(prismaRuntime.sql`
            WITH facts AS (
                SELECT r.${id("sourceArtifactId")} AS ${id("sourceArtifactId")}, r.${id("id")} AS ${id("runId")},
                    r.${id("state")} AS ${id("state")}, r.${id("createdAt")} AS ${id("createdAt")},
                    r.${id("startedAt")} AS ${id("startedAt")}, r.${id("finishedAt")} AS ${id("finishedAt")},
                    r.${id("workflowCustodyState")} AS ${id("workflowCustodyState")},
                    CASE WHEN ${workflowRunAttentionSql(params.accountId)} THEN 1 ELSE 0 END AS ${id("attentionRequired")},
                    CASE WHEN ${workflowRunFailureUnseenSql(params.accountId)} THEN 1 ELSE 0 END AS ${id("failureUnseen")},
                    CASE WHEN ${workflowRunInvocationAttentionSql()} THEN 1 ELSE 0 END AS ${id("invocationAttentionRequired")}
                FROM ${id("AutomationRun")} r
                WHERE ${visibility} AND r.${id("sourceArtifactId")} IN (${prismaRuntime.join([...params.sourceArtifactIds])})
                    AND r.${id("workflowCustodyState")} IS NOT NULL
            ), ranked AS (
                SELECT facts.*,
                    ROW_NUMBER() OVER (PARTITION BY ${id("sourceArtifactId")} ORDER BY ${id("createdAt")} DESC, ${id("runId")} DESC) AS ordinal,
                    ROW_NUMBER() OVER (PARTITION BY ${id("sourceArtifactId")} ORDER BY CASE WHEN ${id("startedAt")} IS NULL THEN 1 ELSE 0 END, ${id("startedAt")} DESC, ${id("runId")} DESC) AS ${id("startedOrdinal")},
                    SUM(${id("attentionRequired")}) OVER (PARTITION BY ${id("sourceArtifactId")}) AS ${id("needsYouCount")},
                    FIRST_VALUE(${id("runId")}) OVER (PARTITION BY ${id("sourceArtifactId")} ORDER BY ${id("attentionRequired")} DESC, ${id("createdAt")} DESC, ${id("runId")} DESC) AS ${id("needsYouRunId")}
                FROM facts
            ) SELECT * FROM ranked WHERE ordinal <= ${params.recent}
                OR (${id("startedOrdinal")} = 1 AND ${id("startedAt")} IS NOT NULL)
                ORDER BY ${id("sourceArtifactId")}, ordinal`);
    }, { isolationLevel: "ReadCommitted", transactionClass: "workflow-summarize-runs" });
    const bySource = new Map<string, SummaryRow[]>();
    for (const row of rows) {
        const group = bySource.get(row.sourceArtifactId) ?? [];
        group.push(row);
        bySource.set(row.sourceArtifactId, group);
    }
    const timestamp = (value: Date | bigint | number) => (value instanceof Date ? value : new Date(Number(value))).toISOString();
    const projectRecent = (row: SummaryRow) => ({ runId: row.runId, state: row.state,
        workflowCustodyState: row.workflowCustodyState, attentionRequired: Number(row.attentionRequired) === 1,
        failureUnseen: Number(row.failureUnseen) === 1, invocationAttentionRequired: Number(row.invocationAttentionRequired) === 1 });
    return workflowSummaryPage({ ids: params.sourceArtifactIds, pageByteLimit: params.pageByteLimit,
        summarize: (sourceArtifactId): WorkflowRunSourceSummariesResultV1["summaries"][number] => {
            const recent = bySource.get(sourceArtifactId) ?? [];
            const first = recent[0];
            const lastStarted = recent.find(row => Number(row.startedOrdinal) === 1 && row.startedAt !== null);
            const needsYouCount = Number(first?.needsYouCount ?? 0);
            if (!Number.isSafeInteger(needsYouCount) || needsYouCount < 0) throw new WorkflowRunServiceError("content_unavailable");
            return {
                sourceArtifactId,
                lastRun: lastStarted && lastStarted.startedAt !== null ? { ...projectRecent(lastStarted),
                    createdAt: timestamp(lastStarted.createdAt), startedAt: timestamp(lastStarted.startedAt),
                    finishedAt: lastStarted.finishedAt === null ? null : timestamp(lastStarted.finishedAt) } : null,
                recent: recent.filter(row => Number(row.ordinal) <= params.recent).map(projectRecent),
                needsYouCount, needsYouRunId: needsYouCount > 0 && first ? first.needsYouRunId : null,
            };
        }, page: (summaries, remainingSourceArtifactIds) => ({ summaries, remainingSourceArtifactIds }),
    });
}

/** Latest actually started Run per Automation; ids filter visibility and never grant it. */
async function summarizeLatestAutomationRuns(params: AutomationSummaryReadParams): Promise<WorkflowRunAutomationSummariesResultV1> {
    const { accountId, pageByteLimit, ...request } = params;
    if (!WorkflowRunAutomationSummariesRequestV1Schema.safeParse(request).success
        || !Number.isSafeInteger(pageByteLimit) || pageByteLimit <= 0) throw new WorkflowRunServiceError("invalid_input");
    if (params.automationIds.length === 0) return { automationSummaries: [], remainingAutomationIds: [] };
    const id = workflowRunSqlIdentifier;
    type StatusRow = {
        automationId: string; runId: string; state: WorkflowRunState; workflowCustodyState: WorkflowCustodyState;
        createdAt: Date | bigint | number; startedAt: Date | bigint | number;
        failureUnseen: bigint | number; invocationAttentionRequired: bigint | number;
    };
    const page = await readSnapshotWithCurrentAdmission({
        capture: async tx => {
            const visibility = await workflowSummaryVisibilityInTx(tx, accountId);
            const rows = await tx.$queryRaw<StatusRow[]>(prismaRuntime.sql`
                WITH ranked AS (
                    SELECT r.${id("automationId")} AS ${id("automationId")}, r.${id("id")} AS ${id("runId")},
                        ROW_NUMBER() OVER (PARTITION BY r.${id("automationId")} ORDER BY r.${id("startedAt")} DESC, r.${id("id")} DESC) AS ordinal
                    FROM ${id("AutomationRun")} r
                    WHERE ${visibility} AND r.${id("automationId")} IN (${prismaRuntime.join([...params.automationIds])})
                        AND r.${id("originKind")} = ${"automation"}
                        AND r.${id("startedAt")} IS NOT NULL
                ) SELECT ranked.${id("automationId")} AS ${id("automationId")}, r.${id("id")} AS ${id("runId")},
                    r.${id("state")} AS ${id("state")}, r.${id("workflowCustodyState")} AS ${id("workflowCustodyState")},
                    r.${id("createdAt")} AS ${id("createdAt")}, r.${id("startedAt")} AS ${id("startedAt")},
                    CASE WHEN ${workflowRunFailureUnseenSql(params.accountId)} THEN 1 ELSE 0 END AS ${id("failureUnseen")},
                    CASE WHEN ${workflowRunInvocationAttentionSql()} THEN 1 ELSE 0 END AS ${id("invocationAttentionRequired")}
                FROM ranked JOIN ${id("AutomationRun")} r ON r.${id("id")} = ranked.${id("runId")}
                WHERE ranked.ordinal = 1`);
            const keys = await withWorkflowRunAccess(() => readWorkflowRunKeyProjectionsInTx(tx, {
                actorAccountId: accountId, runIds: rows.map(row => row.runId),
            }));
            return { rows, keys };
        },
        materialize: async captured => await timeWebLatencyPhase("workflow.summaries.materialize", () => {
            const byAutomation = new Map(captured.rows.map(row => [row.automationId, row]));
            const result = workflowSummaryPage({ ids: params.automationIds, pageByteLimit,
                summarize: (automationId): WorkflowRunAutomationSummariesResultV1["automationSummaries"][number] => {
                    const row = byAutomation.get(automationId);
                    return { automationId, lastRun: row ? { id: row.runId, state: row.state,
                        workflowCustodyState: row.workflowCustodyState, attentionRequired: Number(row.failureUnseen) === 1 || Number(row.invocationAttentionRequired) === 1,
                        failureUnseen: Number(row.failureUnseen) === 1, invocationAttentionRequired: Number(row.invocationAttentionRequired) === 1,
                        createdAt: (row.createdAt instanceof Date ? row.createdAt : new Date(Number(row.createdAt))).toISOString(),
                        startedAt: (row.startedAt instanceof Date ? row.startedAt : new Date(Number(row.startedAt))).toISOString() } : null };
                }, page: (automationSummaries, remainingAutomationIds) => ({ automationSummaries, remainingAutomationIds }),
            });
            return { result, keys: captured.keys };
        }, "workflow-summarize-runs"),
    }, async (tx, captured) => {
        const runIds = captured.result.automationSummaries.flatMap(summary => summary.lastRun ? [summary.lastRun.id] : []);
        if (runIds.length === 0) return captured;
        const current = await withWorkflowRunAccess(() => readWorkflowRunKeyProjectionsInTx(tx, { actorAccountId: accountId, runIds }));
        for (const runId of runIds) {
            const before = captured.keys.get(runId);
            if (!before) throw new WorkflowRunServiceError("run_not_found");
            assertCapturedWorkflowRunKeysCurrent(before, current.get(runId));
        }
        return captured;
    }, { transactionClass: "workflow-summarize-runs" });
    return page.result;
}

const WORKFLOW_TERMINAL_INVOCATION_LIFECYCLES = [
    "completed",
    "failed",
    "skipped",
    "cancelled",
    "outcome_uncertain",
    "superseded",
] as const satisfies readonly WorkflowInvocationLifecycleV1[];
const WORKFLOW_RECOVERY_INVOCATION_LIFECYCLES = [
    "pending",
    "waiting_for_capacity",
    "admitting",
    "running",
    "waiting_for_approval",
    "needs_attention",
    "cancel_requested",
    "outcome_uncertain",
] as const satisfies readonly WorkflowInvocationLifecycleV1[];

/**
 * Returns only exact-machine Runs whose persisted custody still requires the
 * existing worker startup/reconnect owner. This is a targeted indexed read,
 * not a claim, interpreter, history scan, or private-content disclosure.
 */
export async function listWorkflowRunsForRecovery(params: PageOptions & Readonly<{
    accountId: string;
    machineId: string;
}>) {
    if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit <= 0)) {
        throw new WorkflowRunServiceError("invalid_input");
    }
    const queryKey = JSON.stringify({ machineId: params.machineId, selector: "workflow_recovery_v1" });
    const decoded = params.cursor ? decodeKeysetCursorV1(params.cursor, queryKey) : null;
    const afterDate = decoded?.status === "ok" ? readKeysetCursorTextV1(decoded.parts[0]) : null;
    const afterId = decoded?.status === "ok" ? readKeysetCursorIdV1(decoded.parts[1]) : null;
    if (params.cursor && (!afterDate || !afterId)) throw new WorkflowRunServiceError("invalid_input");
    const page = await inTx(async (tx) => {
        await loadAccountModeTx(tx, params.accountId);
        const wanted = params.limit ?? Number.POSITIVE_INFINITY;
        let pageAfterDate = afterDate;
        let pageAfterId = afterId;
        let collected: WorkflowRunRow[] = [];
        let collectedBytes = 2;
        for (;;) {
            const batchSize = Math.min(wanted - collected.length, WORKFLOW_PAGE_DATABASE_BATCH_ROWS);
            const rows = await tx.automationRun.findMany({
                where: {
                    accountId: params.accountId,
                    workflowCustodyState: { not: null },
                    assignments: { some: { machineId: params.machineId } },
                    OR: [
                        {
                            state: { in: [...AUTOMATION_RUN_TERMINAL_STATES] },
                            workflowCustodyState: "pending",
                        },
                        {
                            state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] },
                            workflowCustodyState: "pending",
                            workflowInvocations: { some: { OR: [
                                { lifecycle: "cancel_requested" },
                                // Root/child facts commit before parent custody.
                                // Keep cancellation reachable if the final parent
                                // write failed after every active row settled.
                                { parentRecordId: null, lifecycle: "cancelled" },
                            ] } },
                        },
                        {
                            // Child settlement and root publication are separate
                            // writes. Retain interrupted custody after the final
                            // child leaves the active index so projection can heal.
                            state: "interrupted",
                            workflowCustodyState: "pending",
                        },
                    ],
                    ...(pageAfterDate && pageAfterId ? {
                        AND: [{ OR: [
                            { createdAt: { lt: new Date(pageAfterDate) } },
                            { createdAt: new Date(pageAfterDate), id: { lt: pageAfterId } },
                        ] }],
                    } : {}),
                },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                take: batchSize + 1,
                select: workflowRunProjectionSelect,
            }) as WorkflowRunProjectionRow[];
            const invocationAttention = await readWorkflowRunInvocationAttentionInTx(tx, rows.slice(0, batchSize).map(row => row.id));
            const candidates = rows.slice(0, batchSize).map(row => ({ ...row, invocationAttentionRequired: invocationAttention.has(row.id) }));
            const batchHasMore = rows.length > batchSize;
            const bounded = appendBoundedPage({
                existing: collected,
                existingBytes: collectedBytes,
                candidates,
                byteLimit: params.pageByteLimit,
                serializeMembers: (row) => [JSON.stringify({ run: projectRun(row), parentAttempt: row.attempt })],
                emptyPage: (nextCursor) => ({ candidates: [], ...(nextCursor ? { nextCursor } : {}) }),
                nextCursorFor: (row) => encodeKeysetCursorV1({ queryKey, parts: [row.createdAt.toISOString(), row.id] }),
                hasMoreAfter: (candidateIndex) => candidateIndex < candidates.length - 1 || batchHasMore,
                measurePage: (page) => Buffer.byteLength(JSON.stringify(page), "utf8"),
            });
            if (bounded.shortened) return { ...bounded, hasMore: true };
            collected = bounded.rows;
            collectedBytes = bounded.bytes;
            if (collected.length >= wanted || !batchHasMore) return { rows: collected, hasMore: batchHasMore };
            const last = candidates.at(-1);
            if (!last) return { rows: collected, hasMore: true };
            pageAfterDate = last.createdAt.toISOString();
            pageAfterId = last.id;
        }
    }, { isolationLevel: "ReadCommitted", transactionClass: "workflow-list-runs-for-recovery" });
    const last = page.rows.at(-1);
    return {
        candidates: page.rows.map((row) => ({
            run: projectRun(row),
            parentAttempt: row.attempt,
        })),
        ...(page.hasMore && last
            ? { nextCursor: encodeKeysetCursorV1({ queryKey, parts: [last.createdAt.toISOString(), last.id] }) }
            : {}),
    };
}

export const invocationSelect = { id: true, runId: true, sequence: true, parentRecordId: true, memberOrdinal: true, attempt: true, contentRevision: true, lifecycle: true, contentEnvelope: true, createdAt: true, updatedAt: true } as const;
export type InvocationRow = Prisma.WorkflowRunInvocationGetPayload<{ select: typeof invocationSelect }>;
export function projectInvocation(row: InvocationRow) {
    return { id: row.id, runId: row.runId, sequence: projectWorkflowBigIntV1(row.sequence), parentRecordId: row.parentRecordId, memberOrdinal: projectWorkflowBigIntV1(row.memberOrdinal), attempt: projectWorkflowBigIntV1(row.attempt), contentRevision: projectWorkflowBigIntV1(row.contentRevision), lifecycle: row.lifecycle as WorkflowInvocationLifecycleV1, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/** Same opaque root observation for exact detail and paged summaries; private content stays sealed. */
function projectWorkflowRootProgress(root: InvocationRow | null | undefined, census: WorkflowRunRecipientCensusResponseV1) {
    if (!root) return null;
    try {
        assertWorkflowStoredEnvelopeOuterForMode({ raw: root.contentEnvelope, mode: census.encryptionMode,
            binding: { v: 1, purpose: "invocation_progress", accountId: census.ownerAccountId, runId: census.runId,
                recordId: root.id, sequence: "0", parentRecordId: null, memberOrdinal: "0", attempt: "0" } });
        return { index: projectInvocation(root), contentEnvelope: root.contentEnvelope };
    } catch (error) {
        if (!(error instanceof WorkflowStoredContentError)) throw error;
        return null;
    }
}

async function isCurrentWorkflowInvocationTx(tx: Tx, row: InvocationRow): Promise<boolean> {
    const newer = await tx.workflowRunInvocation.findFirst({
        where: { runId: row.runId, parentRecordId: row.parentRecordId, memberOrdinal: row.memberOrdinal, attempt: { gt: row.attempt } },
        select: { id: true },
    });
    return newer === null;
}

async function assertCurrentWorkflowInvocationTx(tx: Tx, row: InvocationRow): Promise<void> {
    if (!await isCurrentWorkflowInvocationTx(tx, row)) throw new WorkflowRunServiceError("currentness_conflict");
}

/** Structural running ancestors do not prevent parking; only exact current custody does. */
async function assertWorkflowReviewParkableTx(tx: Tx, runId: string): Promise<void> {
    let afterSequence: bigint | undefined;
    let held = false;
    for (;;) {
        const rows = await tx.workflowRunInvocation.findMany({
            where: { runId, lifecycle: { in: ["waiting_for_review", "admitting", "waiting_for_approval", "cancel_requested"] },
                ...(afterSequence === undefined ? {} : { sequence: { gt: afterSequence } }) },
            orderBy: { sequence: "asc" }, take: WORKFLOW_PAGE_DATABASE_BATCH_ROWS, select: invocationSelect,
        }) as InvocationRow[];
        for (const row of rows) {
            if (!await isCurrentWorkflowInvocationTx(tx, row)) continue;
            if (row.lifecycle !== "waiting_for_review") throw new WorkflowRunServiceError("currentness_conflict");
            held = true;
        }
        if (rows.length < WORKFLOW_PAGE_DATABASE_BATCH_ROWS) break;
        afterSequence = rows.at(-1)!.sequence;
    }
    if (!held) throw new WorkflowRunServiceError("currentness_conflict");
}

type WorkflowReviewMutationInput = Readonly<{
    accountId: string; runId: string; invocationId: string; invocationAttempt: bigint;
    expectedContentRevision: bigint; contentEnvelope: string;
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
}>;

/** Account review writes share the exact parent lock used by parking and controls. */
async function loadWorkflowReviewMutationTx(tx: Tx, input: WorkflowReviewMutationInput) {
    if (input.invocationAttempt < 0n || input.invocationAttempt > MAX_DATABASE_BIGINT
        || input.expectedContentRevision < 0n || input.expectedContentRevision > MAX_DATABASE_BIGINT) throw new WorkflowRunServiceError("invalid_input");
    const access = await resolveEditableWorkflowRunAccessTx(tx, { actorAccountId: input.accountId, runId: input.runId });
    const ownerAccountId = access.ownerAccountId;
    const mode = await loadCurrentWorkflowAccountModeTx(tx, ownerAccountId, input.accountCurrentness, input.runId);
    const run = await tx.automationRun.findFirst({ where: { ...workflowRunIdentityWhere({ accountId: ownerAccountId, runId: input.runId }),
        workflowCustodyState: "pending", state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] } }, select: workflowRunSelect });
    if (!run) throw new WorkflowRunServiceError("currentness_conflict");
    const locked = await tx.automationRun.updateMany({ where: { id: input.runId, accountId: ownerAccountId,
        revision: run.revision, state: run.state, workflowCustodyState: "pending" },
        data: { revision: { increment: 0 }, updatedAt: run.updatedAt } });
    if (locked.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
    const row = await tx.workflowRunInvocation.findFirst({ where: { id: input.invocationId, runId: input.runId,
        attempt: input.invocationAttempt, contentRevision: input.expectedContentRevision }, select: invocationSelect }) as InvocationRow | null;
    if (!row) throw new WorkflowRunServiceError("currentness_conflict");
    await assertCurrentWorkflowInvocationTx(tx, row);
    assertWorkflowStoredEnvelopeOuterForMode({ raw: input.contentEnvelope, mode, binding: {
        v: 1, purpose: "invocation_progress", accountId: ownerAccountId, runId: input.runId, recordId: row.id,
        sequence: row.sequence.toString(), parentRecordId: row.parentRecordId, memberOrdinal: row.memberOrdinal.toString(), attempt: row.attempt.toString(),
    } });
    const deliveryBefore = await readOriginDeliverySignalTx(tx, ownerAccountId, input.runId);
    return { ownerAccountId, run, row, deliveryBefore };
}

/** Publication replaces one private draft without releasing its leaf or contending on the parent revision. */
export async function publishWorkflowInvocationDraft(input: WorkflowReviewMutationInput) {
    return inTx(async (tx) => {
        const current = await loadWorkflowReviewMutationTx(tx, input);
        if (!isWorkflowDraftPublicationLifecycleV1(current.row.lifecycle as WorkflowInvocationLifecycleV1)) throw new WorkflowRunServiceError("ineligible_state");
        if (current.row.contentEnvelope === input.contentEnvelope) return { invocation: { index: projectInvocation(current.row),
            contentEnvelope: current.row.contentEnvelope }, parentRevision: current.run.revision };
        if (current.row.contentRevision === MAX_DATABASE_BIGINT) throw new WorkflowRunServiceError("currentness_conflict");
        const changed = await tx.workflowRunInvocation.updateMany({ where: { id: current.row.id, runId: input.runId,
            attempt: input.invocationAttempt, lifecycle: current.row.lifecycle, contentRevision: input.expectedContentRevision },
            data: { contentEnvelope: input.contentEnvelope, contentRevision: { increment: 1 } } });
        if (changed.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
        const row = await tx.workflowRunInvocation.findUniqueOrThrow({ where: { id: current.row.id }, select: invocationSelect }) as InvocationRow;
        await markWorkflowRunChangedTx(tx, current.ownerAccountId, input.runId, current.deliveryBefore);
        return { invocation: { index: projectInvocation(row), contentEnvelope: row.contentEnvelope }, parentRevision: current.run.revision };
    }, {
        // Ordered publication locks/replay and mode/control/row predicates fence this mutation.
        isolationLevel: "ReadCommitted",
        transactionClass: "workflow-publish-invocation-draft",
    });
}

/** Human authority is stamped and required at the authenticated transport, never inferred from sealed content. */
export async function completeWorkflowInvocationReview(input: WorkflowReviewMutationInput & Readonly<{ mode: "use_result" | "generate" }>) {
    return inTx(async (tx) => {
        const current = await loadWorkflowReviewMutationTx(tx, input);
        if (current.row.lifecycle !== "waiting_for_review" || current.row.contentRevision === MAX_DATABASE_BIGINT) throw new WorkflowRunServiceError("currentness_conflict");
        const wake = current.run.state === "waiting_for_review";
        const parentChanged = await tx.automationRun.updateMany({ where: { id: input.runId, accountId: current.ownerAccountId,
            revision: current.run.revision, state: current.run.state, workflowCustodyState: "pending" },
            data: { revision: { increment: 1 }, ...(wake ? { state: "queued", claimedByMachineId: null, claimedAt: null, leaseExpiresAt: null } : {}) } });
        if (parentChanged.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
        const changed = await tx.workflowRunInvocation.updateMany({ where: { id: current.row.id, runId: input.runId,
            attempt: input.invocationAttempt, lifecycle: "waiting_for_review", contentRevision: input.expectedContentRevision },
            data: { lifecycle: input.mode === "use_result" ? "completed" : "waiting_for_review",
                contentEnvelope: input.contentEnvelope, contentRevision: { increment: 1 } } });
        if (changed.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
        const [row, run] = await Promise.all([
            tx.workflowRunInvocation.findUniqueOrThrow({ where: { id: current.row.id }, select: invocationSelect }),
            tx.automationRun.findUniqueOrThrow({ where: { id: input.runId }, select: workflowRunSelect }),
        ]);
        const cursor = await markWorkflowRunChangedTx(tx, current.ownerAccountId, input.runId, current.deliveryBefore);
        if (wake) await publishManagedRunWakeInTx(tx, { accountId: current.ownerAccountId, runId: input.runId, cursor });
        const live = current.run.state === "claimed" || current.run.state === "running" || current.run.state === "pause_requested";
        const machineId = run.assignments[0]?.machineId;
        if (machineId && (wake || live)) await publishWorkflowRunMachineWakeInTx(tx, {
            accountId: current.ownerAccountId, run: run as WorkflowRunFullRow, cursor,
            ...(live ? { workflowControl: "review_resolved" } : {}),
        });
        return { run: await projectRunInTx(tx, run as WorkflowRunProjectionRow, input.accountId), invocation: { index: projectInvocation(row as InvocationRow), contentEnvelope: row.contentEnvelope },
            disposition: input.mode === "use_result" ? "completed" as const : "generation_requested" as const };
    }, {
        // Ordered publication locks/replay and mode/control/row predicates fence this mutation.
        isolationLevel: "ReadCommitted",
        transactionClass: "workflow-complete-invocation-review",
    });
}

/**
 * Pages invocation history or newest direct-member attempts. The internal
 * storage-only `progressEnvelopes` flag adds the private
 * `progressEnvelopesByInvocationId` sidecar for exactly the page's rows so the
 * Action host can open only selected scope/round rows or aggregate Run usage;
 * its members count
 * against the same response-byte boundary and it is part of the cursor binding.
 */
export async function listWorkflowRunInvocations(params: PageOptions & Readonly<{ accountId: string; runId: string; invocationId?: string; parentRecordId?: string | null; parentRecordIds?: readonly string[]; memberOrdinal?: string; lifecycles?: readonly WorkflowInvocationLifecycleV1[]; progressEnvelopes?: true }>) {
    if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit <= 0)) throw new WorkflowRunServiceError("invalid_input");
    if (params.invocationId !== undefined && (!params.invocationId || params.parentRecordId !== undefined
        || params.parentRecordIds !== undefined || params.memberOrdinal !== undefined || params.lifecycles !== undefined)) throw new WorkflowRunServiceError("invalid_input");
    if (params.parentRecordIds !== undefined && (params.parentRecordIds.length === 0 || params.parentRecordId !== undefined
        || params.memberOrdinal !== undefined || params.parentRecordIds.some(id => !id))) throw new WorkflowRunServiceError("invalid_input");
    if (params.memberOrdinal !== undefined && (params.parentRecordId === undefined
        || !/^(0|[1-9][0-9]*)$/.test(params.memberOrdinal) || BigInt(params.memberOrdinal) > MAX_DATABASE_BIGINT)) throw new WorkflowRunServiceError("invalid_input");
    const queryKey = JSON.stringify({ runId: params.runId, parentRecordId: params.parentRecordId ?? null, lifecycles: [...(params.lifecycles ?? [])].sort(),
        ...(params.parentRecordId === null ? { rootOnly: true } : {}),
        ...(params.invocationId !== undefined ? { invocationId: params.invocationId } : {}),
        ...(params.parentRecordIds !== undefined ? { parentRecordIds: [...new Set(params.parentRecordIds)].sort() } : {}),
        ...(params.memberOrdinal !== undefined ? { memberOrdinal: params.memberOrdinal } : {}),
        ...(params.progressEnvelopes ? { progressEnvelopes: true } : {}) });
    const decoded = params.cursor ? decodeKeysetCursorV1(params.cursor, queryKey) : null;
    const afterSequence = decoded?.status === "ok" ? readKeysetCursorTextV1(decoded.parts[0]) : null;
    const afterId = decoded?.status === "ok" ? readKeysetCursorIdV1(decoded.parts[1]) : null;
    if (params.cursor && (!afterSequence || !afterId || !/^(0|[1-9][0-9]*)$/.test(afterSequence) || BigInt(afterSequence) > MAX_DATABASE_BIGINT)) throw new WorkflowRunServiceError("invalid_input");
    return await inTx(async (tx) => {
        const keyCensus = await withWorkflowRunAccess(() => readWorkflowRunKeyProjectionInTx(tx, { actorAccountId: params.accountId, runId: params.runId }));
        const mode = keyCensus.encryptionMode;
        const run = await tx.automationRun.findFirst({ where: { id: params.runId, accountId: keyCensus.ownerAccountId, workflowCustodyState: { not: null } }, select: { revision: true } });
        if (!run) throw new WorkflowRunServiceError("run_not_found");
        // Both history and newest-member windows disclose the same admitted
        // progress sidecar and spend the same exact response-byte budget.
        const discloseProgressEnvelope = (row: InvocationRow): [string, string] => {
            assertWorkflowStoredEnvelopeOuterForMode({ raw: row.contentEnvelope, mode, binding: { v: 1, purpose: "invocation_progress", accountId: keyCensus.ownerAccountId, runId: params.runId, recordId: row.id, sequence: row.sequence.toString(), parentRecordId: row.parentRecordId, memberOrdinal: row.memberOrdinal.toString(), attempt: row.attempt.toString() } });
            return [row.id, row.contentEnvelope];
        };
        const invocationPage = (rows: readonly InvocationRow[], nextCursor?: string) => ({
            invocations: rows.map(projectInvocation),
            ...(params.progressEnvelopes ? { progressEnvelopesByInvocationId: Object.fromEntries(rows.map(discloseProgressEnvelope)) } : {}),
            ...(nextCursor ? { nextCursor } : {}),
            parentRevision: run.revision, keyCensus,
        });
        const serializeMembers = (row: InvocationRow) => params.progressEnvelopes
            ? [JSON.stringify(projectInvocation(row)), `${JSON.stringify(row.id)}:${JSON.stringify(row.contentEnvelope)}`]
            : [JSON.stringify(projectInvocation(row))];
        if (params.parentRecordId !== undefined && params.memberOrdinal !== undefined) {
            const row = await readCurrentWorkflowRunInvocationRowInTx(tx, { runId: params.runId,
                parentRecordId: params.parentRecordId, memberOrdinal: BigInt(params.memberOrdinal) });
            const candidates = row && (afterSequence === null || row.memberOrdinal > BigInt(afterSequence))
                && (!params.lifecycles || params.lifecycles.includes(row.lifecycle)) ? [row] : [];
            const page = appendBoundedPage({ existing: [], existingBytes: 2, candidates,
                byteLimit: params.pageByteLimit, serializeMembers, emptyPage: () => invocationPage([]),
                nextCursorFor: () => "", hasMoreAfter: () => false });
            return invocationPage(page.rows);
        }
        if (params.parentRecordId !== undefined) {
            const wanted = params.limit ?? Number.POSITIVE_INFINITY;
            let pageAfterOrdinal = afterSequence === null ? null : BigInt(afterSequence);
            let collected: InvocationRow[] = [];
            let collectedBytes = 2;
            for (;;) {
                // The public limit bounds returned newest attempts, not the
                // number of logical slots inspected before lifecycle filtering.
                const batchSize = WORKFLOW_PAGE_DATABASE_BATCH_ROWS;
                const slots = await tx.workflowRunInvocation.groupBy({
                by: ["memberOrdinal"],
                where: {
                    runId: params.runId,
                    parentRecordId: params.parentRecordId,
                    ...(params.lifecycles ? { lifecycle: { in: [...params.lifecycles] } } : {}),
                    ...(pageAfterOrdinal === null ? {} : { memberOrdinal: { gt: pageAfterOrdinal } }),
                },
                _max: { attempt: true },
                orderBy: { memberOrdinal: "asc" },
                take: batchSize + 1,
                });
                const examined = slots.slice(0, batchSize);
                const examinedOrdinals = examined.map((slot) => slot.memberOrdinal);
                const overallNewest = examinedOrdinals.length === 0 ? [] : await tx.workflowRunInvocation.groupBy({
                    by: ["memberOrdinal"],
                    where: {
                        runId: params.runId,
                        parentRecordId: params.parentRecordId,
                        memberOrdinal: { in: examinedOrdinals },
                    },
                    _max: { attempt: true },
                });
                const overallAttemptByOrdinal = new Map(overallNewest.map((slot) => [slot.memberOrdinal.toString(), slot._max.attempt]));
                const newestSelectors = examined.flatMap((slot) => {
                    if (slot._max.attempt === null
                        || overallAttemptByOrdinal.get(slot.memberOrdinal.toString()) !== slot._max.attempt) return [];
                    return [{ memberOrdinal: slot.memberOrdinal, attempt: slot._max.attempt }];
                });
                const newestRows = newestSelectors.length === 0 ? [] : await tx.workflowRunInvocation.findMany({
                where: {
                    runId: params.runId,
                    parentRecordId: params.parentRecordId,
                    OR: newestSelectors,
                },
                orderBy: [{ memberOrdinal: "asc" }, { id: "asc" }],
                select: invocationSelect,
                }) as InvocationRow[];
                const remaining = wanted - collected.length;
                const candidates = newestRows.slice(0, remaining);
                const batchHasMore = slots.length > batchSize || newestRows.length > candidates.length;
                const bounded = appendBoundedPage({
                    existing: collected,
                    existingBytes: collectedBytes,
                    candidates,
                    byteLimit: params.pageByteLimit,
                    serializeMembers,
                    emptyPage: (nextCursor) => invocationPage([], nextCursor),
                    nextCursorFor: (row) => encodeKeysetCursorV1({ queryKey, parts: [row.memberOrdinal.toString(), row.id] }),
                    hasMoreAfter: (candidateIndex) => candidateIndex < candidates.length - 1 || batchHasMore,
                });
                if (bounded.shortened) {
                    const last = bounded.rows.at(-1);
                    return invocationPage(bounded.rows, last ? encodeKeysetCursorV1({ queryKey, parts: [last.memberOrdinal.toString(), last.id] }) : undefined);
                }
                collected = bounded.rows;
                collectedBytes = bounded.bytes;
                const lastExamined = examined.at(-1);
                if (collected.length >= wanted) {
                    const last = collected.at(-1);
                    return invocationPage(collected, batchHasMore && last ? encodeKeysetCursorV1({ queryKey, parts: [last.memberOrdinal.toString(), last.id] }) : undefined);
                }
                if (!batchHasMore) return invocationPage(collected);
                if (!lastExamined) return invocationPage(collected);
                pageAfterOrdinal = lastExamined.memberOrdinal;
            }
        }
        const wanted = params.limit ?? Number.POSITIVE_INFINITY;
        let pageAfterSequence = afterSequence === null ? null : BigInt(afterSequence);
        let pageAfterId = afterId;
        let collected: InvocationRow[] = [];
        let collectedBytes = 2;
        const id = workflowRunSqlIdentifier;
        const provider = getDbProviderFromEnv(process.env, "postgres");
        const textType = prismaRuntime.raw(provider === "mysql" ? "CHAR" : "TEXT");
        const parentRecordIds = params.parentRecordIds;
        const selectedParents = parentRecordIds === undefined ? undefined
            : provider === "postgres" || provider === "pglite"
                ? prismaRuntime.sql`${id("parentRecordId")} = ANY(${[...parentRecordIds]}::text[])`
                : provider === "mysql"
                    ? prismaRuntime.sql`${id("parentRecordId")} IN (SELECT selected.id FROM JSON_TABLE(${JSON.stringify(parentRecordIds)}, '$[*]' COLUMNS (id VARCHAR(191) PATH '$')) selected)`
                    : prismaRuntime.sql`${id("parentRecordId")} IN (SELECT value FROM json_each(${JSON.stringify(parentRecordIds)}))`;
        for (;;) {
            const batchSize = Math.min(wanted - collected.length, WORKFLOW_PAGE_DATABASE_BATCH_ROWS);
            // A selected set of parents is a history filter (including retries),
            // not a second newest-attempt projection. Bind the caller-sized set
            // once: 35k short ids fit the HTTP budget but exceed PostgreSQL's
            // 32767 bind parameters. Only the bounded page ids acquire bodies.
            const selectedIds = selectedParents === undefined ? undefined : await tx.$queryRaw<Array<{ id: string }>>(prismaRuntime.sql`
                    SELECT ${id("id")} FROM ${id("WorkflowRunInvocation")}
                    WHERE ${id("runId")} = ${params.runId} AND ${selectedParents}
                    ${params.lifecycles ? prismaRuntime.sql`AND CAST(${id("lifecycle")} AS ${textType}) IN (${prismaRuntime.join([...params.lifecycles])})` : prismaRuntime.empty}
                    ${pageAfterSequence !== null && pageAfterId ? prismaRuntime.sql`AND (${id("sequence")} > ${pageAfterSequence}
                        OR (${id("sequence")} = ${pageAfterSequence} AND ${id("id")} > ${pageAfterId}))` : prismaRuntime.empty}
                    ORDER BY ${id("sequence")}, ${id("id")} LIMIT ${batchSize + 1}`);
            const rows = selectedIds?.length === 0 ? [] : await tx.workflowRunInvocation.findMany({ where: {
            runId: params.runId,
            ...(selectedIds === undefined ? {} : { id: { in: selectedIds.map(row => row.id) } }),
            ...(params.invocationId !== undefined ? { id: params.invocationId } : {}),
            ...(params.lifecycles ? { lifecycle: { in: [...params.lifecycles] } } : {}),
            ...(pageAfterSequence !== null && pageAfterId ? { OR: [{ sequence: { gt: pageAfterSequence } }, { sequence: pageAfterSequence, id: { gt: pageAfterId } }] } : {}),
            }, orderBy: [{ sequence: "asc" }, { id: "asc" }], take: batchSize + 1, select: invocationSelect }) as InvocationRow[];
            const candidates = rows.slice(0, batchSize);
            const batchHasMore = rows.length > batchSize;
            const bounded = appendBoundedPage({
                existing: collected,
                existingBytes: collectedBytes,
                candidates,
                byteLimit: params.pageByteLimit,
                serializeMembers,
                emptyPage: (nextCursor) => invocationPage([], nextCursor),
                nextCursorFor: (row) => encodeKeysetCursorV1({ queryKey, parts: [row.sequence.toString(), row.id] }),
                hasMoreAfter: (candidateIndex) => candidateIndex < candidates.length - 1 || batchHasMore,
            });
            if (bounded.shortened) {
                const last = bounded.rows.at(-1);
                return invocationPage(bounded.rows, last ? encodeKeysetCursorV1({ queryKey, parts: [last.sequence.toString(), last.id] }) : undefined);
            }
            collected = bounded.rows;
            collectedBytes = bounded.bytes;
            if (collected.length >= wanted || !batchHasMore) {
                const last = collected.at(-1);
                return invocationPage(collected, batchHasMore && last ? encodeKeysetCursorV1({ queryKey, parts: [last.sequence.toString(), last.id] }) : undefined);
            }
            const last = candidates.at(-1);
            if (!last) return invocationPage(collected);
            pageAfterSequence = last.sequence;
            pageAfterId = last.id;
        }
    }, { isolationLevel: "ReadCommitted", transactionClass: "workflow-list-run-invocations" });
}

/** One greatest-attempt query shared by current detail and exact member lists. */
async function readCurrentWorkflowRunInvocationRowInTx(tx: Tx, params: Readonly<{
    runId: string; parentRecordId: string | null; memberOrdinal: bigint;
}>): Promise<InvocationRow | null> {
    return await tx.workflowRunInvocation.findFirst({
        where: { runId: params.runId, parentRecordId: params.parentRecordId, memberOrdinal: params.memberOrdinal },
        orderBy: [{ attempt: "desc" }, { id: "desc" }], select: invocationSelect,
    }) as InvocationRow | null;
}

export async function getWorkflowRunInvocation(params: Readonly<{ accountId: string; runId: string; invocationId: string }>) {
    return await inTx(async (tx) => {
        const keyCensus = await withWorkflowRunAccess(() => readWorkflowRunKeyProjectionInTx(tx, { actorAccountId: params.accountId, runId: params.runId }));
        const mode = keyCensus.encryptionMode;
        const run = await tx.automationRun.findFirst({ where: { id: params.runId, accountId: keyCensus.ownerAccountId, workflowCustodyState: { not: null } }, select: { revision: true } });
        if (!run) throw new WorkflowRunServiceError("run_not_found");
        const row = await tx.workflowRunInvocation.findFirst({ where: { id: params.invocationId, runId: params.runId }, select: invocationSelect }) as InvocationRow | null;
        if (!row) throw new WorkflowRunServiceError("run_not_found");
        assertWorkflowStoredEnvelopeOuterForMode({ raw: row.contentEnvelope, mode, binding: { v: 1, purpose: "invocation_progress", accountId: keyCensus.ownerAccountId, runId: params.runId, recordId: row.id, sequence: row.sequence.toString(), parentRecordId: row.parentRecordId, memberOrdinal: row.memberOrdinal.toString(), attempt: row.attempt.toString() } });
        return { invocation: { index: projectInvocation(row), contentEnvelope: row.contentEnvelope, parentRevision: run.revision }, keyCensus };
    }, { isolationLevel: "ReadCommitted", transactionClass: "workflow-get-run-invocation" });
}

/** Reads the greatest persisted attempt for one direct-member slot. */
export async function getCurrentWorkflowRunInvocation(params: Readonly<{
    accountId: string;
    runId: string;
    parentRecordId: string;
    memberOrdinal: bigint;
}>) {
    if (params.memberOrdinal < 0n || params.memberOrdinal > MAX_DATABASE_BIGINT) {
        throw new WorkflowRunServiceError("invalid_input");
    }
    return await inTx(async (tx) => {
        const keyCensus = await withWorkflowRunAccess(() => readWorkflowRunKeyProjectionInTx(tx, { actorAccountId: params.accountId, runId: params.runId }));
        const mode = keyCensus.encryptionMode;
        const run = await tx.automationRun.findFirst({
            where: { id: params.runId, accountId: keyCensus.ownerAccountId, workflowCustodyState: { not: null } },
            select: { revision: true },
        });
        if (!run) throw new WorkflowRunServiceError("run_not_found");
        const row = await readCurrentWorkflowRunInvocationRowInTx(tx, params);
        if (!row) return { invocation: null, parentRevision: run.revision, keyCensus };
        assertWorkflowStoredEnvelopeOuterForMode({
            raw: row.contentEnvelope,
            mode,
            binding: {
                v: 1,
                purpose: "invocation_progress",
                accountId: keyCensus.ownerAccountId,
                runId: params.runId,
                recordId: row.id,
                sequence: row.sequence.toString(),
                parentRecordId: row.parentRecordId,
                memberOrdinal: row.memberOrdinal.toString(),
                attempt: row.attempt.toString(),
            },
        });
        return { invocation: { index: projectInvocation(row), contentEnvelope: row.contentEnvelope }, parentRevision: run.revision, keyCensus };
    }, { isolationLevel: "ReadCommitted", transactionClass: "workflow-get-current-run-invocation" });
}

/** The parent predicate shared by allocation and the final input-admission fact. */
function workflowInputAdmissionWhere(params: Readonly<{
    accountId: string; runId: string; machineId: string; parentAttempt: number;
}>): Prisma.AutomationRunWhereInput {
    return {
        id: params.runId,
        accountId: params.accountId,
        claimedByMachineId: params.machineId,
        attempt: params.parentAttempt,
        assignments: { some: { machineId: params.machineId } },
        workflowCustodyState: "pending",
        state: { in: ["claimed", "running"] },
        workflowInvocations: { none: {
            parentRecordId: null,
            lifecycle: { in: ["cancel_requested", "cancelled", "outcome_uncertain"] },
        } },
    };
}

type WorkflowInvocationFactParams = Readonly<{
    accountId: string; runId: string; machineId: string; invocationId: string;
    invocationAttempt: bigint; expectedContentRevision: bigint; expectedLifecycle: WorkflowInvocationLifecycleV1;
    lifecycle: WorkflowInvocationLifecycleV1; contentEnvelope: string;
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
} & (
    | { parentAttempt: number; expectedRevision?: never; resolution?: "observed_terminal_execution" }
    | { expectedRevision: number; parentAttempt?: never; resolution: "observed_terminal_execution" | "root_list_progress" }
)>;

/** Commit a claimed fact, terminal observation, or exact root projection on the assigned interrupted Run. */
export async function commitWorkflowInvocationFact(params: WorkflowInvocationFactParams) {
    return await inTx(async (tx) => {
        const observation = params.expectedRevision !== undefined;
        const rootProjection = params.resolution === "root_list_progress";
        const parentCurrentness = observation ? params.expectedRevision : params.parentAttempt;
        if (typeof parentCurrentness !== "number" || !Number.isSafeInteger(parentCurrentness)
            || parentCurrentness < 0
            || params.invocationAttempt < 0n
            || params.invocationAttempt > MAX_DATABASE_BIGINT
            || params.expectedContentRevision < 0n || params.expectedContentRevision > MAX_DATABASE_BIGINT) {
            throw new WorkflowRunServiceError("invalid_input");
        }
        const observedSettlement = params.lifecycle === "completed" || params.lifecycle === "failed"
            || params.lifecycle === "cancelled" || params.lifecycle === "needs_attention";
        if ((rootProjection && !observation) || (observation && (params.parentAttempt !== undefined
            || (rootProjection ? params.lifecycle !== params.expectedLifecycle
                : params.resolution !== "observed_terminal_execution" || !observedSettlement)))) {
            throw new WorkflowRunServiceError("invalid_input");
        }
        const mode = await loadCurrentWorkflowAccountModeTx(tx, params.accountId, params.accountCurrentness, params.runId);
        if (!observation && params.lifecycle === "admitting") {
            // Lock the same parent row as Pause/Cancel before authorizing input, including exact revalidation.
            const admitted = await tx.automationRun.updateMany({
                where: workflowInputAdmissionWhere({
                    accountId: params.accountId, runId: params.runId, machineId: params.machineId,
                    parentAttempt: parentCurrentness,
                }),
                data: { revision: { increment: 0 } },
            });
            if (admitted.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
        }
        const parentWhere = observation ? workflowInvocationObservationRunWhere({ accountId: params.accountId,
            runId: params.runId, machineId: params.machineId, expectedRevision: parentCurrentness }) : {
            id: params.runId, accountId: params.accountId,
            assignments: { some: { machineId: params.machineId } }, workflowCustodyState: "pending",
            claimedByMachineId: params.machineId, attempt: params.parentAttempt,
        } satisfies Prisma.AutomationRunWhereInput;
        const run = await tx.automationRun.findFirst({ where: parentWhere, select: { id: true, updatedAt: true, state: true } });
        if (!run) throw new WorkflowRunServiceError("currentness_conflict");
        // Active interrupted Runs retain an explicit recovery choice. A terminal
        // parent instead only needs the exact stopped child fact to retire custody.
        const resolvesObservedTerminal = params.resolution === "observed_terminal_execution"
            && (observation ? observedSettlement : params.lifecycle === "completed" || params.lifecycle === "needs_attention"
                || ((params.lifecycle === "failed" || params.lifecycle === "cancelled")
                    && AUTOMATION_RUN_TERMINAL_STATES.some(state => state === run.state)));
        // Revalidate custody under the same parent lock as controls/recovery,
        // preserving the revision and timestamps of this row-only fact.
        const locked = await tx.automationRun.updateMany({
            where: parentWhere,
            data: { revision: { increment: 0 }, updatedAt: run.updatedAt },
        });
        if (locked.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
        const deliveryBefore = await readOriginDeliverySignalTx(tx, params.accountId, params.runId);
        const current = await tx.workflowRunInvocation.findFirst({ where: { id: params.invocationId, runId: params.runId, attempt: params.invocationAttempt }, select: invocationSelect }) as InvocationRow | null;
        const acknowledge = async (row: InvocationRow) => {
            const parent = await tx.automationRun.findUniqueOrThrow({ where: { id: params.runId }, select: { revision: true } });
            return { ...projectInvocation(row), parentRevision: parent.revision };
        };
        if (!current || current.contentRevision !== params.expectedContentRevision) throw new WorkflowRunServiceError("currentness_conflict");
        if (rootProjection && (current.parentRecordId !== null || current.sequence !== 0n
            || current.memberOrdinal !== 0n || current.attempt !== 0n)) throw new WorkflowRunServiceError("invalid_input");
        await assertCurrentWorkflowInvocationTx(tx, current);
        assertWorkflowStoredEnvelopeOuterForMode({ raw: params.contentEnvelope, mode, binding: { v: 1, purpose: "invocation_progress", accountId: params.accountId, runId: params.runId, recordId: current.id, sequence: current.sequence.toString(), parentRecordId: current.parentRecordId, memberOrdinal: current.memberOrdinal.toString(), attempt: current.attempt.toString() } });
        if (current.lifecycle !== params.expectedLifecycle) {
            if ((observation || params.expectedLifecycle === "outcome_uncertain")
                && resolvesObservedTerminal
                && current.lifecycle === params.lifecycle
                && current.contentEnvelope === params.contentEnvelope) {
                return await acknowledge(current);
            }
            throw new WorkflowRunServiceError("currentness_conflict");
        }
        if (current.lifecycle === params.lifecycle && current.contentEnvelope === params.contentEnvelope) return await acknowledge(current);
        if (current.contentRevision === MAX_DATABASE_BIGINT) throw new WorkflowRunServiceError("currentness_conflict");
        if (WORKFLOW_TERMINAL_INVOCATION_LIFECYCLES.some((lifecycle) => lifecycle === current.lifecycle)) {
            if (current.lifecycle === "outcome_uncertain"
                && resolvesObservedTerminal) {
                const changed = await tx.workflowRunInvocation.updateMany({
                    where: { id: current.id, attempt: params.invocationAttempt, lifecycle: current.lifecycle, contentRevision: params.expectedContentRevision },
                    data: { lifecycle: params.lifecycle, contentEnvelope: params.contentEnvelope, contentRevision: { increment: 1 } },
                });
                if (changed.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
                const resolved = await tx.workflowRunInvocation.findUniqueOrThrow({ where: { id: current.id }, select: invocationSelect }) as InvocationRow;
                await markWorkflowRunChangedTx(tx, params.accountId, params.runId, deliveryBefore);
                return await acknowledge(resolved);
            }
            throw new WorkflowRunServiceError("currentness_conflict");
        }
        const changed = await tx.workflowRunInvocation.updateMany({
            where: { id: current.id, attempt: params.invocationAttempt, lifecycle: params.expectedLifecycle, contentRevision: params.expectedContentRevision },
            data: { lifecycle: params.lifecycle, contentEnvelope: params.contentEnvelope, contentRevision: { increment: 1 } },
        });
        if (changed.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
        const updated = await tx.workflowRunInvocation.findUniqueOrThrow({ where: { id: current.id }, select: invocationSelect }) as InvocationRow;
        await markWorkflowRunChangedTx(tx, params.accountId, params.runId, deliveryBefore, current.lifecycle !== "admitting" && params.lifecycle === "admitting");
        return await acknowledge(updated);
    }, {
        // Ordered publication locks fence the audience before the mode/parent
        // locks and row CAS. ReadCommitted observes cursor writes that finish
        // during acquisition instead of aborting on an unrelated publication.
        isolationLevel: "ReadCommitted",
        transactionClass: "workflow-invocation-fact",
    });
}

/** The origin input-admission owner reports its authoritative withdrawal, never an inferred absence of dispatch. */
export async function recordWorkflowRunOriginInputWithdrawn(params: Readonly<{
    accountId: string; originSessionId: string; runId: string; invocationRecordId: string;
    expectedRevision: number; accountCurrentness: AutomationAccountCurrentnessWitnessV1;
}>) {
    if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) throw new WorkflowRunServiceError("invalid_input");
    return await inTx(async (tx) => {
        const session = await tx.session.findFirst({ where: { id: params.originSessionId, accountId: params.accountId }, select: { id: true } });
        const parent = await tx.automationRun.findFirst({ where: { ...workflowRunIdentityWhere(params), originSessionId: params.originSessionId }, select: { state: true, revision: true, updatedAt: true } });
        if (!session || !parent) throw new WorkflowRunServiceError("run_not_found");
        if (parent.revision !== params.expectedRevision) throw new WorkflowRunServiceError("currentness_conflict");
        const mode = await loadCurrentWorkflowAccountModeTx(tx, params.accountId, params.accountCurrentness, params.runId);
        const locked = await tx.automationRun.updateMany({
            where: { ...workflowRunIdentityWhere(params), originSessionId: params.originSessionId, revision: params.expectedRevision, state: parent.state },
            data: { revision: { increment: 0 }, updatedAt: parent.updatedAt },
        });
        if (locked.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
        const current = await tx.workflowRunInvocation.findFirst({ where: { id: params.invocationRecordId, runId: params.runId }, select: invocationSelect }) as InvocationRow | null;
        if (!current) throw new WorkflowRunServiceError("currentness_conflict");
        await assertCurrentWorkflowInvocationTx(tx, current);
        const terminal = AUTOMATION_RUN_TERMINAL_STATES.some((state) => state === parent.state);
        const paused = parent.state === "pause_requested" || parent.state === "paused";
        const cancelled = current.lifecycle === "cancel_requested" || current.lifecycle === "cancelled" || terminal;
        if (!paused && !cancelled) throw new WorkflowRunServiceError("currentness_conflict");
        const lifecycle = cancelled ? "cancelled" : "pending";
        assertWorkflowStoredEnvelopeOuterForMode({ raw: current.contentEnvelope, mode, binding: { v: 1, purpose: "invocation_progress", accountId: params.accountId, runId: params.runId, recordId: current.id, sequence: current.sequence.toString(), parentRecordId: current.parentRecordId, memberOrdinal: current.memberOrdinal.toString(), attempt: current.attempt.toString() } });
        if (current.lifecycle === lifecycle) return { index: projectInvocation(current) };
        const expectedLifecycle = ORIGIN_INPUT_CANDIDATE_LIFECYCLES.find((state) => state === current.lifecycle);
        if (!expectedLifecycle) throw new WorkflowRunServiceError("currentness_conflict");
        const deliveryBefore = await readOriginDeliverySignalTx(tx, params.accountId, params.runId);
        if (current.contentRevision === MAX_DATABASE_BIGINT) throw new WorkflowRunServiceError("currentness_conflict");
        const changed = await tx.workflowRunInvocation.updateMany({ where: { id: current.id, attempt: current.attempt, lifecycle: expectedLifecycle, contentRevision: current.contentRevision }, data: { lifecycle, contentRevision: { increment: 1 } } });
        if (changed.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
        const updated = await tx.workflowRunInvocation.findUniqueOrThrow({ where: { id: current.id }, select: invocationSelect }) as InvocationRow;
        await markWorkflowRunChangedTx(tx, params.accountId, params.runId, deliveryBefore);
        return { index: projectInvocation(updated) };
    }, {
        // Ordered publication locks/replay and mode/control/row predicates fence this mutation.
        isolationLevel: "ReadCommitted",
        transactionClass: "workflow-record-run-origin-input-withdrawn",
    });
}

export async function transitionWorkflowRun(params: Readonly<{ accountId: string; runId: string; machineId: string; parentAttempt: number; expectedRevision: number; state: WorkflowRunState; checkpointEnvelope: string; resultEnvelope?: string | null; custodyState?: WorkflowCustodyState; invocationTransitions?: readonly Readonly<{ id: string; expectedLifecycle: WorkflowInvocationLifecycleV1; lifecycle: WorkflowInvocationLifecycleV1; expectedContentRevision: bigint }>[]; accountCurrentness: AutomationAccountCurrentnessWitnessV1 }>) {
    return await inTx(async (tx) => {
        if (!Number.isSafeInteger(params.parentAttempt) || params.parentAttempt < 0) throw new WorkflowRunServiceError("invalid_input");
        const mode = await loadCurrentWorkflowAccountModeTx(tx, params.accountId, params.accountCurrentness, params.runId);
        const deliveryBefore = await readOriginDeliverySignalTx(tx, params.accountId, params.runId);
        assertWorkflowStoredEnvelopeOuterForMode({ raw: params.checkpointEnvelope, mode, binding: { v: 1, purpose: "checkpoint", accountId: params.accountId, runId: params.runId } });
        if (params.resultEnvelope) assertWorkflowStoredEnvelopeOuterForMode({ raw: params.resultEnvelope, mode, binding: { v: 1, purpose: "final_result", accountId: params.accountId, runId: params.runId } });
        const parksForReview = params.state === "waiting_for_review";
        if (parksForReview) {
            if (params.custodyState !== undefined && params.custodyState !== "pending") throw new WorkflowRunServiceError("currentness_conflict");
            const parent = await tx.automationRun.findFirst({ where: { id: params.runId, accountId: params.accountId,
                revision: params.expectedRevision, attempt: params.parentAttempt, claimedByMachineId: params.machineId,
                assignments: { some: { machineId: params.machineId } }, state: { in: ["claimed", "running"] }, workflowCustodyState: "pending" },
                select: { updatedAt: true } });
            if (!parent) throw new WorkflowRunServiceError("currentness_conflict");
            const locked = await tx.automationRun.updateMany({ where: { id: params.runId, accountId: params.accountId,
                revision: params.expectedRevision, attempt: params.parentAttempt, claimedByMachineId: params.machineId,
                state: { in: ["claimed", "running"] }, workflowCustodyState: "pending" },
                data: { revision: { increment: 0 }, updatedAt: parent.updatedAt } });
            if (locked.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
            await assertWorkflowReviewParkableTx(tx, params.runId);
        }
        const reconciledTerminalInvocationIds: string[] = [];
        let allInvocationTransitionsTerminalIdempotent = true;
        for (const transition of params.invocationTransitions ?? []) {
            const current = await tx.workflowRunInvocation.findFirst({
                where: { id: transition.id, runId: params.runId },
                select: invocationSelect,
            });
            if (transition.expectedContentRevision < 0n || transition.expectedContentRevision > MAX_DATABASE_BIGINT) throw new WorkflowRunServiceError("invalid_input");
            if (!current || current.lifecycle !== transition.expectedLifecycle || current.contentRevision !== transition.expectedContentRevision) {
                throw new WorkflowRunServiceError("currentness_conflict");
            }
            const terminal = WORKFLOW_TERMINAL_INVOCATION_LIFECYCLES.some((lifecycle) => lifecycle === current.lifecycle);
            if (terminal && transition.lifecycle !== current.lifecycle) {
                throw new WorkflowRunServiceError("currentness_conflict");
            }
            if (!terminal || transition.lifecycle !== current.lifecycle) {
                allInvocationTransitionsTerminalIdempotent = false;
            }
            await assertCurrentWorkflowInvocationTx(tx, current as InvocationRow);
            if (
                terminal
                || WORKFLOW_TERMINAL_INVOCATION_LIFECYCLES.some((lifecycle) => lifecycle === transition.lifecycle)
            ) reconciledTerminalInvocationIds.push(transition.id);
        }
        const transitionsToTerminal = AUTOMATION_RUN_TERMINAL_STATES.some(
            (candidate) => candidate === params.state,
        );
        if (params.custodyState === "settled") {
            if (!transitionsToTerminal) {
                throw new WorkflowRunServiceError("currentness_conflict");
            }
            const unsettled = await tx.workflowRunInvocation.findFirst({
                where: {
                    runId: params.runId,
                    lifecycle: { in: [...WORKFLOW_RECOVERY_INVOCATION_LIFECYCLES, "waiting_for_review"] },
                    ...(reconciledTerminalInvocationIds.length > 0 ? { id: { notIn: reconciledTerminalInvocationIds } } : {}),
                },
                select: { id: true },
            });
            if (unsettled) {
                throw new WorkflowRunServiceError("currentness_conflict");
            }
        }
        const now = new Date();
        const previous = await tx.automationRun.findFirst({
            where: {
                id: params.runId,
                accountId: params.accountId,
                claimedByMachineId: params.machineId,
                attempt: params.parentAttempt,
                assignments: { some: { machineId: params.machineId } },
                revision: params.expectedRevision,
                workflowCustodyState: { not: null },
            },
            select: {
                state: true,
                originKind: true,
                workflowCheckpointEnvelope: true,
                resultEnvelope: true,
                workflowCustodyState: true,
            },
        });
        if (!previous) throw new WorkflowRunServiceError("currentness_conflict");
        const sameTerminalCustodySettlement = transitionsToTerminal
            && previous.state === params.state
            && AUTOMATION_RUN_TERMINAL_STATES.some((candidate) => candidate === previous.state)
            && previous.workflowCustodyState === "pending"
            && params.custodyState === "settled"
            && previous.workflowCheckpointEnvelope === params.checkpointEnvelope
            && (params.resultEnvelope === undefined || previous.resultEnvelope === params.resultEnvelope)
            && allInvocationTransitionsTerminalIdempotent;
        if (AUTOMATION_RUN_TERMINAL_STATES.some((candidate) => candidate === previous.state)
            && !sameTerminalCustodySettlement) {
            throw new WorkflowRunServiceError("currentness_conflict");
        }
        const terminalAutomationState = transitionsToTerminal
            && previous.originKind === "automation"
            && !sameTerminalCustodySettlement;
        const previousAutomationState = terminalAutomationState
            ? automationPreviousStateForWorkflowTerminalEffects(previous.state as WorkflowRunState)
            : null;
        const updated = await tx.automationRun.updateMany({
            where: {
                id: params.runId,
                accountId: params.accountId,
                claimedByMachineId: params.machineId,
                attempt: params.parentAttempt,
                assignments: { some: { machineId: params.machineId } },
                revision: params.expectedRevision,
                ...(sameTerminalCustodySettlement
                    ? { state: params.state, workflowCustodyState: "pending" as const }
                    : { state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] }, workflowCustodyState: { not: null } }),
            },
            data: sameTerminalCustodySettlement
                ? { workflowCustodyState: "settled", revision: { increment: 1 } }
                : {
                    state: params.state,
                    workflowCheckpointEnvelope: params.checkpointEnvelope,
                    ...(params.resultEnvelope !== undefined ? { resultEnvelope: params.resultEnvelope } : {}),
                    ...(params.custodyState ? { workflowCustodyState: params.custodyState } : {}),
                    revision: { increment: 1 },
                    ...(parksForReview ? { workflowCustodyState: "pending", claimedByMachineId: null, claimedAt: null, leaseExpiresAt: null } : {}),
                    ...(transitionsToTerminal ? { finishedAt: now } : {}),
                },
        });
        if (updated.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
        if (!sameTerminalCustodySettlement) {
            for (const transition of params.invocationTransitions ?? []) {
                if (transition.lifecycle === transition.expectedLifecycle) continue;
                if (transition.expectedContentRevision === MAX_DATABASE_BIGINT) throw new WorkflowRunServiceError("currentness_conflict");
                const changed = await tx.workflowRunInvocation.updateMany({
                    where: { id: transition.id, runId: params.runId, lifecycle: transition.expectedLifecycle, contentRevision: transition.expectedContentRevision },
                    data: { lifecycle: transition.lifecycle, contentRevision: { increment: 1 } },
                });
                if (changed.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
            }
        }
        if (terminalAutomationState) {
            if (!previousAutomationState) throw new WorkflowRunServiceError("currentness_conflict");
            await applyAutomationRunTerminalEffectsTx({
                tx,
                accountId: params.accountId,
                runId: params.runId,
                previousState: previousAutomationState,
                state: params.state as "succeeded" | "failed" | "cancelled" | "outcome_uncertain",
                now,
                prepareWorkflowReplyHandoff: params.state === "succeeded",
                eventPayload: { machineId: params.machineId },
            });
        }
        const row = await tx.automationRun.findUniqueOrThrow({ where: { id: params.runId }, select: workflowRunSelect });
        await markWorkflowRunChangedTx(tx, params.accountId, params.runId, deliveryBefore);
        return await projectRunInTx(tx, row as WorkflowRunProjectionRow, params.accountId);
    }, {
        // Ordered publication locks/replay and mode/control/row predicates fence this mutation.
        isolationLevel: "ReadCommitted",
        transactionClass: "workflow-transition-run",
    });
}

async function controlWorkflowRun(params: Readonly<{
    accountId: string; runId: string; expectedRevision: number;
    transitions: readonly Readonly<{ eligibleStates: readonly WorkflowRunState[]; state: WorkflowRunState; clearClaim?: boolean; recordResume?: boolean }>[];
}>) {
    return await inTx(async (tx) => {
        if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) throw new WorkflowRunServiceError("invalid_input");
        const access = await resolveEditableWorkflowRunAccessTx(tx, { actorAccountId: params.accountId, runId: params.runId });
        const ownerAccountId = access.ownerAccountId;
        await loadAccountModeTx(tx, ownerAccountId, params.runId);
        const current = await tx.automationRun.findFirst({ where: { id: params.runId, accountId: ownerAccountId }, select: { revision: true, state: true } });
        if (!current) throw new WorkflowRunServiceError("run_not_found");
        if (current.revision !== params.expectedRevision) throw new WorkflowRunServiceError("currentness_conflict");
        if (!params.transitions.some((transition) => transition.eligibleStates.some((state) => state === current.state))) throw new WorkflowRunServiceError("ineligible_state");
        const deliveryBefore = await readOriginDeliverySignalTx(tx, ownerAccountId, params.runId);
        let matched = false;
        for (const transition of params.transitions) {
            const changed = await tx.automationRun.updateMany({ where: {
                id: params.runId,
                accountId: ownerAccountId,
                revision: params.expectedRevision,
                workflowCustodyState: { not: null },
                state: { in: [...transition.eligibleStates] },
            }, data: {
                state: transition.state,
                revision: { increment: 1 },
                workflowResumeRequestedRevision: transition.recordResume ? params.expectedRevision + 1 : null,
                ...(transition.clearClaim ? { claimedByMachineId: null, claimedAt: null, leaseExpiresAt: null } : {}),
            } });
            if (changed.count === 1) { matched = true; break; }
        }
        if (!matched) throw new WorkflowRunServiceError("currentness_conflict");
        const row = await tx.automationRun.findUniqueOrThrow({ where: { id: params.runId }, select: workflowRunSelect });
        const cursor = await markWorkflowRunChangedTx(tx, ownerAccountId, params.runId, deliveryBefore);
        if (row.state === "queued") {
            await publishManagedRunWakeInTx(tx, { accountId: ownerAccountId, runId: params.runId, cursor });
            const machineId = row.assignments[0]?.machineId;
            if (machineId) await publishWorkflowRunMachineWakeInTx(tx, { accountId: ownerAccountId,
                run: row as WorkflowRunFullRow, cursor });
        }
        return await projectRunInTx(tx, row as WorkflowRunProjectionRow, params.accountId);
    }, {
        // Ordered publication locks/replay and mode/control/row predicates fence this mutation.
        isolationLevel: "ReadCommitted",
        transactionClass: "workflow-control-run",
    });
}

export async function pauseWorkflowRun(params: Readonly<{ accountId: string; runId: string; expectedRevision: number }>) {
    const run = await controlWorkflowRun({ ...params, transitions: [
        { eligibleStates: ["queued", "waiting_for_review"], state: "paused", clearClaim: true },
        { eligibleStates: ["claimed", "running"], state: "pause_requested" },
    ] });
    return { run, intent: "pause_requested" as const };
}

export async function resumeWorkflowRunBoundary(params: Readonly<{ accountId: string; runId: string; expectedRevision: number }>) {
    const run = await controlWorkflowRun({ ...params, transitions: [
        { eligibleStates: ["paused"], state: "queued", clearClaim: true, recordResume: true },
    ] });
    return { run, intent: "resumed" as const };
}

export async function cancelWorkflowRunTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        runId: string;
        expectedRevision: number;
        cause?: "permanent_target_loss";
    }>,
) {
    const deliveryBefore = await readOriginDeliverySignalTx(tx, params.accountId, params.runId);
    const current = await tx.automationRun.findFirst({
        where: {
            id: params.runId,
            accountId: params.accountId,
            // Stop targets the same Run across claim/progress writes. Unlike
            // replacement/recovery, it does not depend on the viewed content.
            revision: { gte: params.expectedRevision },
            workflowCustodyState: { not: null },
            state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] },
        },
        select: {
            state: true,
            revision: true,
            originKind: true,
            leaseExpiresAt: true,
            workflowInvocations: { take: 1, select: { id: true } },
        },
    });
    if (!current) throw new WorkflowRunServiceError("currentness_conflict");
    const beforeRootAdmission = current.workflowInvocations.length === 0
        && (
            current.state === "queued"
            || current.state === "claimed"
            || current.state === "pause_requested"
        );
    const immediate = beforeRootAdmission || current.state === "paused" || current.state === "waiting_for_review";
    // Ordinary cancellation preserves active/unknown custody for the exact
    // Machine to reconcile. Permanent loss of that sole frozen target closes
    // the approved same-Run recovery path, so an admitted Run must instead
    // settle as uncertain rather than remain indefinitely actionable.
    const permanentTargetLoss = params.cause === "permanent_target_loss";
    const now = new Date();
    // Stop can end authored work after the incumbent claim has expired, even
    // when its exact Machine cannot reconcile physical child custody yet.
    const expiredClaim = !immediate && !permanentTargetLoss
        && current.leaseExpiresAt !== null && current.leaseExpiresAt < now;
    const settlesCustody = immediate || permanentTargetLoss;
    const settlesNow = settlesCustody || expiredClaim;
    const terminalState = permanentTargetLoss && !immediate ? "outcome_uncertain" as const : "cancelled" as const;
    const changed = await tx.automationRun.updateMany({
        where: {
            id: params.runId,
            accountId: params.accountId,
            revision: current.revision,
            state: {
                equals: current.state,
                notIn: [...AUTOMATION_RUN_TERMINAL_STATES],
            },
            // Heartbeats renew without changing revision. Do not close a
            // concurrently renewed incumbent on an expired read.
            ...(expiredClaim ? { leaseExpiresAt: { lt: now } } : {}),
        },
        data: {
            state: settlesNow ? terminalState : current.state,
            revision: { increment: 1 },
            workflowResumeRequestedRevision: null,
            ...(settlesNow ? {
                finishedAt: now,
            } : {}),
            ...(settlesCustody ? { workflowCustodyState: "settled" } : {}),
        },
    });
    if (changed.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
    const exhaustedRow = await tx.workflowRunInvocation.findFirst({ where: { runId: params.runId,
        lifecycle: { in: ["pending", "waiting_for_capacity", "admitting", "running", "waiting_for_approval", "waiting_for_review", "needs_attention", "cancel_requested"] },
        contentRevision: MAX_DATABASE_BIGINT }, select: { id: true } });
    if (exhaustedRow) throw new WorkflowRunServiceError("currentness_conflict");
    await tx.workflowRunInvocation.updateMany({
        where: {
            runId: params.runId,
            contentRevision: { lt: MAX_DATABASE_BIGINT },
            lifecycle: { in: settlesCustody
                ? ["pending", "waiting_for_capacity", "admitting", "running", "waiting_for_approval", "needs_attention", "cancel_requested"]
                : ["pending", "waiting_for_capacity", "admitting", "running", "waiting_for_approval", "needs_attention"] },
        },
        data: {
            lifecycle: settlesCustody
                ? terminalState
                : "cancel_requested",
            contentRevision: { increment: 1 },
        },
    });
    // A held leaf owns no active input; cancellation closes it even while a
    // sibling's real Machine custody still needs reconciliation.
    await tx.workflowRunInvocation.updateMany({ where: { runId: params.runId, lifecycle: "waiting_for_review", contentRevision: { lt: MAX_DATABASE_BIGINT } },
        data: { lifecycle: "cancelled", contentRevision: { increment: 1 } } });
    if (settlesNow && current.originKind === "automation") {
        await applyAutomationRunTerminalEffectsTx({
            tx,
            accountId: params.accountId,
            runId: params.runId,
            previousState: automationPreviousStateForWorkflowTerminalEffects(current.state as WorkflowRunState),
            state: terminalState,
            now,
            ...(permanentTargetLoss && !immediate
                ? { eventPayload: { reason: "permanent_target_loss" } }
                : {}),
        });
    }
    const row = await tx.automationRun.findUniqueOrThrow({ where: { id: params.runId }, select: workflowRunSelect });
    const cursor = await markWorkflowRunChangedTx(tx, params.accountId, params.runId, deliveryBefore);
    if (!settlesCustody) {
        const machineId = row.assignments[0]?.machineId;
        if (machineId) await publishWorkflowRunMachineWakeInTx(tx, {
            accountId: params.accountId,
            run: row as WorkflowRunFullRow,
            cursor,
            workflowControl: "cancel_requested",
        });
    }
    return {
        run: await projectRunInTx(tx, row as WorkflowRunProjectionRow, params.accountId),
        intent: settlesNow ? "cancelled" as const : "cancel_requested" as const,
    };
}

export async function cancelWorkflowRun(params: Readonly<{ accountId: string; runId: string; expectedRevision: number }>) {
    return await inTx(async (tx) => {
        const access = await resolveEditableWorkflowRunAccessTx(tx, { actorAccountId: params.accountId, runId: params.runId });
        await loadAccountModeTx(tx, access.ownerAccountId, params.runId);
        return await cancelWorkflowRunTx(tx, { ...params, accountId: access.ownerAccountId });
    }, {
        // Ordered publication locks/replay and mode/control/row predicates fence this mutation.
        isolationLevel: "ReadCommitted",
        transactionClass: "workflow-cancel-run",
    });
}

const workflowRunWaitSelect = {
    ...workflowRunProjectionSelect,
    resultEnvelope: true,
} satisfies Prisma.AutomationRunSelect;

async function readWorkflowRunWaitObservation(accountId: string, runId: string) {
    return await inTx(async (tx) => {
        const keyCensus = await withWorkflowRunAccess(() => readWorkflowRunKeyProjectionInTx(tx, { actorAccountId: accountId, runId }));
        const row = await tx.automationRun.findFirst({
            where: {
                id: runId,
                accountId: keyCensus.ownerAccountId,
                workflowCustodyState: { not: null },
            },
            select: workflowRunWaitSelect,
        });
        if (!row) throw new WorkflowRunServiceError("run_not_found");
        if (row.resultEnvelope !== null) {
            const mode = keyCensus.encryptionMode;
            assertWorkflowStoredEnvelopeOuterForMode({
                raw: row.resultEnvelope,
                mode,
                binding: { v: 1, purpose: "final_result", accountId: keyCensus.ownerAccountId, runId },
            });
        }
        const run = await projectRunInTx(tx, row as WorkflowRunProjectionRow, accountId);
        return { run, resultEnvelope: row.resultEnvelope, attention: run.attentionRequired, keyCensus };
    }, { isolationLevel: "ReadCommitted", transactionClass: "workflow-read-run-wait-observation" });
}

export async function waitWorkflowRun(params: Readonly<{
    accountId: string;
    runId: string;
    conditions?: readonly WorkflowRunWaitConditionV1[];
    timeoutSeconds?: 0;
    afterRevision?: number;
    signal?: AbortSignal;
}>) {
    // Exact durable observation only. Hosts park on the existing Account feed
    // and re-read here on changes/reconnect or their authored deadline. No
    // process-local server listener could cover another cluster node's writes.
    params.signal?.throwIfAborted();
    const current = await readWorkflowRunWaitObservation(params.accountId, params.runId);
    params.signal?.throwIfAborted();
    const state = current.run.state;
    const conditions = params.conditions ?? ["terminal", "attention", "paused"];
    if (current.attention && conditions.includes("attention")) return { observation: "needs_attention" as const, matchedCondition: "attention" as const, run: current.run };
    if (AUTOMATION_RUN_TERMINAL_STATES.some((candidate) => candidate === state)) {
        // A settled Run cannot reach an unselected pause/attention condition
        // during this observation. Preserve terminal evidence as a typed non-match.
        const terminal = conditions.includes("terminal")
            ? { observation: "terminal" as const, matchedCondition: "terminal" as const }
            : { observation: "not_matched_terminal" as const };
        return { ...terminal, run: current.run, ...(current.resultEnvelope ? { resultEnvelope: current.resultEnvelope, keyCensus: current.keyCensus } : {}) };
    }
    if (state === "paused" && conditions.includes("paused")) return { observation: "paused" as const, matchedCondition: "paused" as const, run: current.run };
    if (params.afterRevision !== undefined && current.run.revision !== params.afterRevision) {
        return { observation: "changed" as const, run: current.run };
    }
    if (params.timeoutSeconds === 0) return { observation: "timeout" as const, run: current.run };
    return { observation: "waiting" as const, run: current.run };
}

export async function recoverWorkflowInvocations(params: Readonly<{
    accountId: string;
    machineId: string;
    runId: string;
    expectedRevision: number;
    checkpointEnvelope: string;
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    recoveries: readonly Readonly<{
        invocationId: string;
        newInvocationId: string;
        contentEnvelope: string;
    }>[];
}>) {
    if (params.recoveries.length === 0) throw new WorkflowRunServiceError("invalid_input");
    return await inTx(async (tx) => {
        const mode = await loadCurrentWorkflowAccountModeTx(tx, params.accountId, params.accountCurrentness, params.runId);
        const deliveryBefore = await readOriginDeliverySignalTx(tx, params.accountId, params.runId);
        const ids = new Set<string>();
        for (const recovery of params.recoveries) {
            if (!WorkflowInvocationRecordIdSchema.safeParse(recovery.newInvocationId).success
                || ids.has(recovery.invocationId)
                || ids.has(recovery.newInvocationId)) throw new WorkflowRunServiceError("invalid_input");
            ids.add(recovery.invocationId);
            ids.add(recovery.newInvocationId);
        }
        const prior = await tx.workflowRunInvocation.findMany({
            where: { runId: params.runId, id: { in: params.recoveries.map((item) => item.invocationId) } },
            select: invocationSelect,
        }) as InvocationRow[];
        const priorById = new Map(prior.map((row) => [row.id, row]));
        const existing = await tx.workflowRunInvocation.findMany({
            where: { id: { in: params.recoveries.map((item) => item.newInvocationId) } },
            select: invocationSelect,
        }) as InvocationRow[];
        if (existing.length > 0) {
            const existingById = new Map(existing.map((row) => [row.id, row]));
            const parent = await tx.automationRun.findFirst({
                where: { id: params.runId, accountId: params.accountId, revision: params.expectedRevision + 1, assignments: { some: { machineId: params.machineId } } },
                select: workflowRunSelect,
            });
            const rejoinedRows: InvocationRow[] = [];
            const replacementByPriorId = new Map<string, string>();
            const rejoins = parent && params.recoveries.every((recovery) => {
                const previous = priorById.get(recovery.invocationId);
                const next = existingById.get(recovery.newInvocationId);
                if (!previous) return false;
                if (previous.parentRecordId !== null
                    && priorById.has(previous.parentRecordId)
                    && !replacementByPriorId.has(previous.parentRecordId)) return false;
                const expectedParentRecordId = previous.parentRecordId === null
                    ? null
                    : replacementByPriorId.get(previous.parentRecordId) ?? previous.parentRecordId;
                const exact = previous?.lifecycle === "superseded"
                    && next?.runId === params.runId
                    && next?.parentRecordId === expectedParentRecordId
                    && next?.memberOrdinal === previous.memberOrdinal
                    && next?.attempt === previous.attempt + 1n
                    && next?.contentEnvelope === recovery.contentEnvelope;
                if (exact && next) {
                    replacementByPriorId.set(previous.id, next.id);
                    rejoinedRows.push(next);
                }
                return exact;
            });
            if (rejoins && parent.workflowCheckpointEnvelope === params.checkpointEnvelope) return {
                disposition: "existing" as const,
                run: await projectRunInTx(tx, parent as WorkflowRunProjectionRow, params.accountId),
                invocations: rejoinedRows.map(projectInvocation),
            };
            throw new WorkflowRunServiceError("currentness_conflict");
        }
        const parent = await tx.automationRun.findFirst({
            where: {
                id: params.runId,
                accountId: params.accountId,
                revision: params.expectedRevision,
                state: "interrupted",
                workflowCustodyState: { not: null },
                assignments: { some: { machineId: params.machineId } },
            },
            select: { revision: true },
        });
        if (!parent || prior.length !== params.recoveries.length) throw new WorkflowRunServiceError("currentness_conflict");
        assertWorkflowStoredEnvelopeOuterForMode({ raw: params.checkpointEnvelope, mode, binding: { v: 1, purpose: "checkpoint", accountId: params.accountId, runId: params.runId } });
        const changed = await tx.automationRun.updateMany({
            where: { id: params.runId, accountId: params.accountId, revision: params.expectedRevision, state: "interrupted", assignments: { some: { machineId: params.machineId } } },
            data: { revision: { increment: 1 }, state: "queued", claimedByMachineId: null, claimedAt: null, leaseExpiresAt: null, workflowCheckpointEnvelope: params.checkpointEnvelope, workflowCustodyState: "pending", finishedAt: null },
        });
        if (changed.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
        const maximum = await tx.workflowRunInvocation.aggregate({ where: { runId: params.runId }, _max: { sequence: true } });
        const firstSequence = (maximum._max.sequence ?? -1n) + 1n;
        const created: InvocationRow[] = [];
        const replacementByPriorId = new Map<string, string>();
        for (const [index, recovery] of params.recoveries.entries()) {
            const previous = priorById.get(recovery.invocationId);
            if (!previous
                || !["failed", "cancelled", "needs_attention"].includes(previous.lifecycle)
                || previous.attempt >= MAX_DATABASE_BIGINT
                || previous.contentRevision >= MAX_DATABASE_BIGINT
                || firstSequence + BigInt(index) > MAX_DATABASE_BIGINT) throw new WorkflowRunServiceError("ineligible_state");
            if (previous.parentRecordId !== null
                && priorById.has(previous.parentRecordId)
                && !replacementByPriorId.has(previous.parentRecordId)) {
                throw new WorkflowRunServiceError("invalid_input");
            }
            const parentRecordId = previous.parentRecordId === null
                ? null
                : replacementByPriorId.get(previous.parentRecordId) ?? previous.parentRecordId;
            const newSequence = firstSequence + BigInt(index);
            if (!await isCurrentWorkflowInvocationTx(tx, previous)) throw new WorkflowRunServiceError("ineligible_state");
            const superseded = await tx.workflowRunInvocation.updateMany({ where: { id: previous.id,
                runId: params.runId, attempt: previous.attempt, lifecycle: previous.lifecycle,
                contentRevision: previous.contentRevision }, data: { lifecycle: "superseded", contentRevision: { increment: 1 } } });
            if (superseded.count !== 1) throw new WorkflowRunServiceError("currentness_conflict");
            assertWorkflowStoredEnvelopeOuterForMode({
                raw: recovery.contentEnvelope,
                mode,
                binding: {
                    v: 1,
                    purpose: "invocation_progress",
                    accountId: params.accountId,
                    runId: params.runId,
                    recordId: recovery.newInvocationId,
                    sequence: newSequence.toString(),
                    parentRecordId,
                    memberOrdinal: previous.memberOrdinal.toString(),
                    attempt: (previous.attempt + 1n).toString(),
                },
            });
            created.push(await tx.workflowRunInvocation.create({
                data: {
                    id: recovery.newInvocationId,
                    runId: params.runId,
                    sequence: newSequence,
                    parentRecordId,
                    memberOrdinal: previous.memberOrdinal,
                    attempt: previous.attempt + 1n,
                    lifecycle: "pending",
                    contentEnvelope: recovery.contentEnvelope,
                },
                select: invocationSelect,
            }) as InvocationRow);
            replacementByPriorId.set(previous.id, recovery.newInvocationId);
        }
        const updatedParent = await tx.automationRun.findUniqueOrThrow({ where: { id: params.runId }, select: workflowRunSelect });
        const cursor = await markWorkflowRunChangedTx(tx, params.accountId, params.runId, deliveryBefore);
        await publishWorkflowRunMachineWakeInTx(tx, { accountId: params.accountId,
            run: updatedParent as WorkflowRunFullRow, cursor });
        return { disposition: "accepted" as const, run: await projectRunInTx(tx, updatedParent as WorkflowRunProjectionRow, params.accountId), invocations: created.map(projectInvocation) };
    }, {
        // Ordered publication locks/replay and mode/control/row predicates fence this mutation.
        isolationLevel: "ReadCommitted",
        transactionClass: "workflow-recover-invocations",
    });
}

export async function deleteWorkflowRun(params: Readonly<{ accountId: string; runId: string; expectedRevision: number }>) {
    return await inTx(async (tx) => {
        await loadAccountModeTx(tx, params.accountId, params.runId);
        // A settled ancestor still supplies causality to actual live Run/turn
        // publishers. The same retained-history owner governs clear and delete.
        const candidate = await tx.automationRun.findFirst({ where: {
            id: params.runId, accountId: params.accountId,
            ...automationRunCustodyTerminalWhere(), workflowCustodyState: "settled",
        }, select: { id: true } });
        if (candidate && (await readAutomationLiveCauseRunIdsTx(tx, params.accountId)).has(candidate.id)) {
            throw new WorkflowRunServiceError("custody_pending");
        }
        const deleted = await tx.automationRun.deleteMany({
            where: {
                id: params.runId,
                accountId: params.accountId,
                revision: params.expectedRevision,
                ...automationRunCustodyTerminalWhere(),
                workflowCustodyState: "settled",
            },
        });
        if (deleted.count !== 1) {
            const exists = await tx.automationRun.findFirst({
                where: { id: params.runId, accountId: params.accountId },
                select: { state: true, workflowCustodyState: true },
            });
            if (!exists) throw new WorkflowRunServiceError("run_not_found");
            if (exists.workflowCustodyState === "pending") throw new WorkflowRunServiceError("custody_pending");
            if (AUTOMATION_RUN_TERMINAL_STATES.some((candidate) => candidate === exists.state)) {
                const custodyTerminal = await tx.automationRun.findFirst({
                    where: {
                        id: params.runId,
                        accountId: params.accountId,
                        ...automationRunCustodyTerminalWhere(),
                    },
                    select: { id: true },
                });
                if (!custodyTerminal) throw new WorkflowRunServiceError("custody_pending");
                // A settled workflow Run is deletable; only the caller's expected
                // revision is stale. Report the currentness conflict so the caller
                // refreshes instead of treating the settled Run as ineligible.
                if (exists.workflowCustodyState === "settled") throw new WorkflowRunServiceError("currentness_conflict");
            }
            throw new WorkflowRunServiceError("ineligible_state");
        }
        await markWorkflowRunChangedTx(tx, params.accountId, params.runId);
        return { deleted: true as const, runId: params.runId };
    }, {
        // Ordered publication locks/replay and mode/control/row predicates fence this mutation.
        isolationLevel: "ReadCommitted",
        transactionClass: "workflow-delete-run",
    });
}
