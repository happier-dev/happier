import { persistentMachineWhere } from "@/app/machines/machineSelection";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { readMachineAvailabilityStateInTx } from "@/app/machines/machineStateGuards";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import {
    AutomationV3WorkerClaimResponseSchema,
    AutomationV3WorkerClaimReceiptRunSchema,
    AutomationV3WorkerClaimedAutomationSchema,
    AutomationV3WorkerClaimedRunSchema,
    parseWorkflowStoredContentEnvelopeV1,
    validateWorkflowStoredEnvelopeOuterForModeV1,
    parseAutomationRunExecutionRecipeV1,
    validateAutomationRunExecutionRecipeOuterV1,
    type AutomationAccountCurrentnessWitnessV1,
    type AutomationV3WorkerClaimResponse,
    type AutomationV3WorkerClaimedAutomation,
    type AutomationV3WorkerClaimReceiptRun,
    type AutomationV3WorkerClaimedRun,
} from "@happier-dev/protocol";

import { emitAutomationRunTransition, emitAutomationRunUpdatedToMachineOnly } from "./automationChangePublisher";
import { lockScopedAutomationTriggerInTx } from "./automationScopedTrigger";
import { AUTOMATION_RUN_TERMINAL_STATES } from "./automationTypes";
import { fetchAutomationAccountCurrentnessWitnessTx } from "./automationAccountCurrentness";
import {
    automationRunCauseSelect,
    automationRunWithAutomationSelect,
} from "./automationPersistenceSelect";
import {
    validateAutomationStoredContentEnvelopeOuterForMode,
    validateRetainedAutomationRunExecutionInputV2OuterForMode,
} from "./automationStoredContentRead";
import {
    decodeAutomationRunCause,
    isAutomationCauseRow,
    projectAutomationOriginRun,
    retainedV2OriginKindForRun,
} from "./automationRunCauseCodec";
import {
    failInvalidAutomationRunBeforeClaimTx,
    markAbandonedAutomationExecutionDispatchOutcomeUnknownTx,
} from "./automationRunService";
import type {
    AutomationRunWithAutomation,
    AutomationTriggerKind,
} from "./automationTypes";
import {
    resolveAutomationRecipeFeaturePolicy,
    type AutomationRecipeFeaturePolicy,
} from "./automationRecipeFeaturePolicy";

type ClaimCandidateState = "queued" | "claimed" | "running" | "pause_requested";

type AutomationClaimResult = Readonly<{
    run: AutomationClaimRun | null;
    accountCurrentness: AutomationAccountCurrentnessWitnessV1 | null;
    /** Exact frozen V3 wire payload when this result rejoins a receipt. */
    receiptReplay?: Readonly<{
        run: AutomationV3WorkerClaimedRun;
        automation: AutomationV3WorkerClaimedAutomation | null;
    }>;
}>;

type AutomationClaimRun = Prisma.AutomationRunGetPayload<{
    select: typeof automationRunWithAutomationSelect;
}> & Readonly<{ triggerRetired?: boolean; recipeKind?: "legacy" | "workflow-v2"; causeWorkDepth?: number;
    lastSucceededRun?: Readonly<{ runId: string; checkpointEnvelope: string }> }>;

function recipeKindForClaimRun(run: Pick<AutomationClaimRun, "workflowCustodyState">): "legacy" | "workflow-v2" {
    return run.workflowCustodyState !== null ? "workflow-v2" : "legacy";
}

function assertAutomationClaimRun(
    run: AutomationClaimRun,
): asserts run is AutomationClaimRun & AutomationRunWithAutomation {
    if (
        !isAutomationCauseRow(run)
        || run.automation === null
    ) {
        throw new TypeError("Automation-origin claim has invalid origin correspondence");
    }
}

type AutomationClaimRequest = Readonly<{
    machineInstallationId: string;
    nonce: string;
    expiresAt: Date;
}>;

/** A signed claim request names one durable claim decision, including no-Run. */
function deriveClaimRequestNonceDigest(params: Readonly<{
    machineId: string;
    machineInstallationId: string;
    nonce: string;
}>): string {
    return createHash("sha256")
        .update("happier.automationClaimRequest.v1\0", "utf8")
        .update(JSON.stringify([
            params.machineId,
            params.machineInstallationId,
            params.nonce,
        ]), "utf8")
        .digest("base64url");
}

class AutomationClaimReceiptConflictError extends Error {}

type AutomationClaimReceiptResultV2 = Readonly<{
    v: 2;
    run: AutomationV3WorkerClaimReceiptRun | null;
    automation: AutomationV3WorkerClaimedAutomation | null;
}>;

function projectAutomationV3ClaimReceiptResult(
    result: AutomationClaimResult,
    accountId?: string,
): Readonly<{ v: 2; run: AutomationV3WorkerClaimedRun | null; automation: AutomationV3WorkerClaimedAutomation | null }> {
    if (result.receiptReplay) {
        return {
            v: 2,
            run: result.receiptReplay.run,
            automation: result.receiptReplay.automation,
        };
    }
    if (!result.run) return { v: 2, run: null, automation: null };
    if (result.run.originKind === "direct") {
        return {
            v: 2,
            run: AutomationV3WorkerClaimedRunSchema.parse({
                id: result.run.id,
                automationId: null,
                attempt: result.run.attempt,
                revision: result.run.revision,
                ...(result.run.workflowResumeRequestedRevision === null ? {} : {
                    workflowResumeRequestedRevision: result.run.workflowResumeRequestedRevision,
                }),
                recipeKind: "workflow-v2",
                origin: {
                    kind: "direct",
                    ...(result.run.originSessionId === null ? {} : { originSessionId: result.run.originSessionId }),
                },
                workflowAcceptedSnapshotEnvelope: result.run.workflowAcceptedSnapshotEnvelope,
                triggerId: null,
                triggerRetired: false,
            }),
            automation: null,
        };
    }
    assertAutomationClaimRun(result.run);
    const cause = decodeAutomationRunCause(result.run);
    return {
        v: 2,
        run: AutomationV3WorkerClaimedRunSchema.parse({
            id: result.run.id,
            automationId: result.run.automationId,
            triggerId: result.run.triggerId,
            triggerRetired: result.run.triggerRetired ?? false,
            attempt: result.run.attempt,
            revision: result.run.revision,
            ...(result.run.workflowResumeRequestedRevision === null ? {} : {
                workflowResumeRequestedRevision: result.run.workflowResumeRequestedRevision,
            }),
            recipeKind: result.run.recipeKind ?? recipeKindForClaimRun(result.run),
            executionInputEnvelope: result.run.executionInputEnvelope,
            ...(result.run.workflowAcceptedSnapshotEnvelope === null ? {} : {
                workflowAcceptedSnapshotEnvelope: result.run.workflowAcceptedSnapshotEnvelope,
            }),
            ...(result.run.workflowCustodyState !== null
                ? { automationEvidenceEnvelope: result.run.triggerEvidenceEnvelope }
                : {}),
            cause,
            causeWorkDepth: result.run.causeWorkDepth,
            ...(result.run.lastSucceededRun ? { lastSucceededRun: result.run.lastSucceededRun } : {}),
            ...(cause.kind === "conversation"
                && result.run.replyHandoffState === "awaitingResult"
                && typeof result.run.replyHandoffId === "string"
                && result.run.replyHandoffId.trim().length > 0
                ? {
                    resultDelivery: {
                        kind: "finalResult" as const,
                        accountId: accountId ?? result.run.accountId,
                        handoffId: result.run.replyHandoffId,
                    },
                }
                : {}),
        }),
        automation: AutomationV3WorkerClaimedAutomationSchema.parse({
            id: result.run.automation.id,
            name: result.run.automation.name,
            enabled: result.run.automation.enabled,
            workflowDefinitionId: result.run.automation.workflowDefinitionId,
            scopeSessionId: result.run.automation.scopeSessionId,
        }),
    };
}

/**
 * The receipt is the one idempotency owner for a signed claim. It stores the
 * bounded V3 wire projection selected for that response rather than the broad
 * internal Run row or a pointer back to mutable Run state — except the private
 * Run recipe envelope. Those bytes are owned by the AutomationRun row, which
 * the Account encryption transition rewrites in place; a receipt copy would
 * sit outside that transition census and resurface mode-stale private content
 * on replay. Replay therefore re-reads the envelope from the Run row and
 * validates it under the current Account content witness instead.
 */
function serializeAutomationClaimReceiptResultV2(result: AutomationClaimResult): string {
    const projected = projectAutomationV3ClaimReceiptResult(result);
    if (projected.run === null) return JSON.stringify(projected);
    if (projected.run.automationId === null) {
        return JSON.stringify({
            ...projected,
            run: { ...projected.run, workflowAcceptedSnapshotEnvelope: null },
        });
    }
    const { automationEvidenceEnvelope: _automationEvidenceEnvelope,
        workflowAcceptedSnapshotEnvelope: _workflowAcceptedSnapshotEnvelope, ...receiptRun } = projected.run;
    return JSON.stringify({
        ...projected,
        run: {
            ...receiptRun,
            executionInputEnvelope: null,
            ...(receiptRun.lastSucceededRun ? { lastSucceededRun: {
                runId: receiptRun.lastSucceededRun.runId, checkpointEnvelope: null,
            } } : {}),
        },
    });
}

function parseAutomationClaimReceiptResultV2(
    serialized: string,
): Readonly<{ ok: true; result: AutomationClaimReceiptResultV2 }> | Readonly<{ ok: false }> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(serialized);
    } catch {
        return { ok: false };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
    const record = parsed as Record<string, unknown>;
    if (record.v !== 2) return { ok: false };
    const run = record.run === null
        ? null
        : AutomationV3WorkerClaimReceiptRunSchema.safeParse(record.run);
    const automation = record.automation === null
        ? null
        : AutomationV3WorkerClaimedAutomationSchema.safeParse(record.automation);
    if (run !== null && !run.success) return { ok: false };
    if (automation !== null && !automation.success) return { ok: false };
    const parsedRun = run === null ? null : run.data;
    const parsedAutomation = automation === null ? null : automation.data;
    if (
        (parsedRun === null && parsedAutomation !== null)
        || (parsedRun?.automationId !== null && parsedAutomation === null)
        || (parsedRun?.automationId === null && parsedAutomation !== null)
    ) return { ok: false };
    return {
        ok: true,
        result: { v: 2, run: parsedRun, automation: parsedAutomation },
    };
}

/** The sole V3 claim wire projector, shared by first response and receipt replay. */
export function toAutomationV3WorkerClaimResponse(
    result: AutomationClaimResult,
    accountId?: string,
): AutomationV3WorkerClaimResponse {
    const projected = projectAutomationV3ClaimReceiptResult(result, accountId);
    return AutomationV3WorkerClaimResponseSchema.parse({
        run: projected.run,
        automation: projected.automation,
        accountCurrentness: projected.run ? result.accountCurrentness : null,
    });
}

function isClaimCandidateState(state: string): state is ClaimCandidateState {
    return state === "queued" || state === "claimed" || state === "running" || state === "pause_requested";
}

/**
 * Current recipe bytes are admitted only through Protocol. The retained V2
 * parser reads frozen Run data created by 0.2 for current V3 claims; it never
 * grants predecessor worker authority or produces or rewrites a recipe.
 */
function hasClaimableFrozenRecipe(params: {
    accountId: string;
    runId: string;
    executionInputEnvelope: string | null;
    originKind?: string;
    workflowAcceptedSnapshotEnvelope?: string | null;
    workflowCustodyState?: string | null;
    retainedV2OriginKind?: "scheduled" | "manual";
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;

}): boolean {
    if (params.originKind === "direct") {
        if (params.workflowAcceptedSnapshotEnvelope === null) return false;
        const envelope = parseWorkflowStoredContentEnvelopeV1(params.workflowAcceptedSnapshotEnvelope);
        return envelope !== null && validateWorkflowStoredEnvelopeOuterForModeV1({
            mode: params.accountCurrentness.mode,
            binding: {
                v: 1,
                purpose: "accepted_snapshot",
                accountId: params.accountId,
                runId: params.runId,
            },
            envelope,
        }).kind === "available";
    }

    if (params.workflowCustodyState === "pending") {
        if (params.executionInputEnvelope === null) return false;
        return validateAutomationStoredContentEnvelopeOuterForMode({
            raw: params.executionInputEnvelope,
            mode: params.accountCurrentness.mode,
        }).kind === "available";
    }
    const strictRecipe = parseAutomationRunExecutionRecipeV1(params.executionInputEnvelope);
    if (strictRecipe.kind === "available") {
        return validateAutomationRunExecutionRecipeOuterV1({
            recipe: strictRecipe.recipe,
            accountCurrentness: params.accountCurrentness,
        }).kind === "available";
    }

    if (params.executionInputEnvelope === null) return false;
    if (params.retainedV2OriginKind === undefined) return false;
    return validateRetainedAutomationRunExecutionInputV2OuterForMode({
        raw: params.executionInputEnvelope,
        mode: params.accountCurrentness.mode,
        retainedV2OriginKind: params.retainedV2OriginKind,
    })?.kind === "available";
}

export function resolveClaimLeaseExpiresAt(params: { now: Date; leaseDurationMs: number }): Date {
    const leaseMs = Number.isFinite(params.leaseDurationMs)
        ? Math.min(Math.max(Math.floor(params.leaseDurationMs), 5_000), 15 * 60_000)
        : 30_000;
    return new Date(params.now.getTime() + leaseMs);
}

export function isRunClaimableState(params: {
    state: string;
    leaseExpiresAt: Date | null;
    now: Date;
}): boolean {
    if (params.state === "queued") return true;
    if (params.state !== "claimed" && params.state !== "running" && params.state !== "pause_requested") return false;
    if (!params.leaseExpiresAt) return false;
    return params.leaseExpiresAt.getTime() < params.now.getTime();
}

function runAssignmentClaimWhere(machineId: string) {
    return { some: { machineId } };
}

function expectedRunTriggerCauseWhere(expectedTriggerKind?: AutomationTriggerKind) {
    return expectedTriggerKind
        ? { causeKind: "trigger" as const, causeTriggerKind: expectedTriggerKind }
        : {};
}

/**
 * Current Run recipes are the immutable assignment snapshot. The child rows
 * are only the queryable claim index written from that snapshot by admission.
 */
function hasExactDerivedAssignmentIndex(
    run: Readonly<{
        executionInputEnvelope: string | null;
        assignments: readonly Readonly<{ machineId: string }>[];
    }>,
): boolean {
    const parsed = parseAutomationRunExecutionRecipeV1(run.executionInputEnvelope);
    if (parsed.kind !== "available") return true;
    const recipeIds = [...parsed.recipe.assignmentMachineIds].sort();
    const indexIds = run.assignments.map((assignment) => assignment.machineId).sort();
    return recipeIds.length === indexIds.length
        && recipeIds.every((machineId, index) => machineId === indexIds[index]);
}

/**
 * The claim-candidate read: exactly the frozen state, immutable cause, and
 * recipe-derived assignment facts the claim decision consumes. The claimed
 * Run's full shape is re-read through the canonical Run select after the CAS.
 */
const automationClaimCandidateSelect = {
    ...automationRunCauseSelect,
    id: true,
    automationId: true,
    originKind: true,
    workflowAcceptedSnapshotEnvelope: true,
    workflowResumeRequestedRevision: true,
    state: true,
    revision: true,
    attempt: true,
    executionDispatchState: true,
    executionAttempt: true,
    executionInputEnvelope: true,
    workflowCustodyState: true,
    automation: { select: { scopeSessionId: true } },
    leaseExpiresAt: true,
    dueAt: true,
    assignments: { select: { machineId: true } },
} satisfies Prisma.AutomationRunSelect;

/** Reads only frozen Run state and the recipe-derived assignment index. */
async function findClaimCandidates(params: {
    tx: Tx;
    accountId: string;
    machineId: string;
    now: Date;
    limit: number;
    expectedTriggerKind?: AutomationTriggerKind;

    recipeFeaturePolicy: AutomationRecipeFeaturePolicy;
    scope?: "session_scoped";
}) {
    const activeScoped = await params.tx.automationRun.findMany({
        where: { accountId: params.accountId, triggerId: { not: null },
            automation: { is: { scopeSessionId: { not: null } } },
            state: { notIn: ["queued", ...AUTOMATION_RUN_TERMINAL_STATES] } },
        select: { triggerId: true }, distinct: ["triggerId"],
    });
    const activeTriggerIds = activeScoped.flatMap((run) => run.triggerId ? [run.triggerId] : []);
    return await params.tx.automationRun.findMany({
        where: {
            accountId: params.accountId,
            ...(params.scope === "session_scoped" ? { automation: { is: { scopeSessionId: { not: null } } } } : {}),
            dueAt: { lte: params.now },
            ...expectedRunTriggerCauseWhere(params.expectedTriggerKind),
            ...(!params.recipeFeaturePolicy.workflowsEnabled
                ? { workflowCustodyState: null }
                : {}),
            OR: [
                {
                    state: "queued",
                    assignments: runAssignmentClaimWhere(params.machineId),
                    ...(activeTriggerIds.length ? { OR: [{ triggerId: null }, { triggerId: { notIn: activeTriggerIds } }] } : {}),
                },
                {
                    state: "claimed",
                    leaseExpiresAt: { lt: params.now },
                    assignments: runAssignmentClaimWhere(params.machineId),
                },
                {
                    state: "running",
                    leaseExpiresAt: { lt: params.now },
                    assignments: runAssignmentClaimWhere(params.machineId),
                },
                {
                    state: "pause_requested",
                    workflowCustodyState: "pending",
                    leaseExpiresAt: { lt: params.now },
                    assignments: runAssignmentClaimWhere(params.machineId),
                },
            ],
        },
        orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: params.limit,
        select: automationClaimCandidateSelect,
    });
}

async function tryClaimRun(params: {
    tx: Tx;
    runId: string;
    previousState: string;
    expectedRunRevision: number;
    executionInputEnvelope: string | null;
    now: Date;
    machineId: string;
    leaseExpiresAt: Date;
    normalizeNullExecutionDispatchState?: boolean;
    expectedTriggerKind?: AutomationTriggerKind;
}) {
    if (params.previousState === "queued") {
        return await params.tx.automationRun.updateMany({
            where: {
                id: params.runId,
                state: "queued",
                revision: params.expectedRunRevision,
                executionInputEnvelope: params.executionInputEnvelope,
                ...expectedRunTriggerCauseWhere(params.expectedTriggerKind),
                assignments: runAssignmentClaimWhere(params.machineId),
            },
            data: {
                state: "claimed",
                workflowResumeRequestedRevision: null,
                claimedAt: params.now,
                claimedByMachineId: params.machineId,
                leaseExpiresAt: params.leaseExpiresAt,
                attempt: { increment: 1 },
                revision: { increment: 1 },
            },
        });
    }

    const previousState = params.previousState === "pause_requested"
        ? "pause_requested"
        : params.previousState === "running" ? "running" : "claimed";
    return await params.tx.automationRun.updateMany({
        where: {
            id: params.runId,
            state: previousState,
            leaseExpiresAt: { lt: params.now },
            revision: params.expectedRunRevision,
            executionInputEnvelope: params.executionInputEnvelope,
            ...expectedRunTriggerCauseWhere(params.expectedTriggerKind),
            ...(params.normalizeNullExecutionDispatchState
                ? { executionDispatchState: null }
                : {}),
            assignments: runAssignmentClaimWhere(params.machineId),
        },
        data: {
            state: previousState === "pause_requested" ? "pause_requested" : "claimed",
            workflowResumeRequestedRevision: null,
            claimedAt: params.now,
            claimedByMachineId: params.machineId,
            leaseExpiresAt: params.leaseExpiresAt,
            ...(params.normalizeNullExecutionDispatchState
                ? { executionDispatchState: "notStarted" }
                : {}),
            attempt: { increment: 1 },
            revision: { increment: 1 },
        },
    });
}

async function fetchClaimedRun(tx: Tx, runId: string): Promise<AutomationClaimRun | null> {
    const row = await tx.automationRun.findUnique({
        where: { id: runId },
        select: automationRunWithAutomationSelect,
    });

    if (!row) return null;
    return row;
}

async function projectClaimedRunWithTriggerCurrentness(
    tx: Tx,
    run: AutomationClaimRun,
): Promise<AutomationClaimRun> {
    if (run.originKind === "direct") return { ...run, triggerRetired: false };
    assertAutomationClaimRun(run);
    const currentTrigger = run.triggerId === null
        ? null
        : await tx.automationTrigger.findFirst({
            where: {
                id: run.triggerId,
                automationId: run.automationId,
                deletedAt: null,
            },
            select: { id: true },
        });
    return {
        ...run,
        triggerRetired: run.triggerId !== null && currentTrigger === null,
        ...await readLastSucceededTriggerRunTx(tx, run),
    };
}

/** Private checkpoint bytes always come from their transition-managed Run owner. */
async function readSucceededCheckpointTx(tx: Tx, params: Readonly<{
    accountId: string; runId: string; triggerId: string;
}>): Promise<Readonly<{ runId: string; checkpointEnvelope: string }> | undefined> {
    const previous = await tx.automationRun.findFirst({
        where: { id: params.runId, accountId: params.accountId, triggerId: params.triggerId, state: "succeeded" },
        select: { id: true, workflowCheckpointEnvelope: true },
    });
    if (!previous?.workflowCheckpointEnvelope) return undefined;
    const witness = await fetchAutomationAccountCurrentnessWitnessTx(tx, params.accountId);
    const parsed = parseWorkflowStoredContentEnvelopeV1(previous.workflowCheckpointEnvelope);
    if (!witness || parsed === null
        || validateWorkflowStoredEnvelopeOuterForModeV1({ mode: witness.mode,
            binding: { v: 1, purpose: "checkpoint", accountId: params.accountId, runId: previous.id },
            envelope: parsed,
        }).kind !== "available") return undefined;
    return { runId: previous.id, checkpointEnvelope: previous.workflowCheckpointEnvelope };
}

async function readLastSucceededTriggerRunTx(tx: Tx, run: AutomationClaimRun) {
    if (run.triggerId === null || run.automation?.scopeSessionId == null) return {};
    // Do not filter missing checkpoints: an uncertified latest success means always review.
    const previous = await tx.automationRun.findFirst({
        where: { accountId: run.accountId, triggerId: run.triggerId, state: "succeeded" },
        orderBy: [{ finishedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }], select: { id: true },
    });
    if (!previous) return {};
    const lastSucceededRun = await readSucceededCheckpointTx(tx, {
        accountId: run.accountId, runId: previous.id, triggerId: run.triggerId,
    });
    return lastSucceededRun ? { lastSucceededRun } : {};
}

/** Reads the host-stamped firing fact and scoped source; missing facts never imply depth zero. */
async function readAutomationCauseWorkDepthTx(tx: Tx, run: Readonly<{
    accountId: string;
    causeKind: string | null;
    causeTriggerKind: string | null;
    causeSourceSessionId: string | null;
    causeSourceTurnId: string | null;
    automation: Readonly<{ scopeSessionId: string | null }> | null;
}>): Promise<Readonly<{ kind: "available"; workDepth: number }>
    | Readonly<{ kind: "unavailable"; errorCode: "source_unavailable" }>> {
    const isLifecycleCause = run.causeKind === "trigger" && run.causeTriggerKind === "sessionLifecycle";
    const scopeSessionId = run.automation?.scopeSessionId;
    // A lifecycle source read below also proves its identical scoped Session.
    if (scopeSessionId && (!isLifecycleCause || scopeSessionId !== run.causeSourceSessionId)
        && !await tx.session.findFirst({ where: { id: scopeSessionId, accountId: run.accountId }, select: { id: true } })) {
        return { kind: "unavailable", errorCode: "source_unavailable" };
    }
    if (!isLifecycleCause) return { kind: "available", workDepth: 0 };
    if (run.causeSourceSessionId === null) return { kind: "unavailable", errorCode: "source_unavailable" };
    const source = run.causeSourceTurnId === null
        ? await tx.session.findFirst({
            where: { id: run.causeSourceSessionId, accountId: run.accountId }, select: { workDepth: true },
        })
        : await tx.sessionTurn.findFirst({
            where: { sessionId: run.causeSourceSessionId, turnId: run.causeSourceTurnId,
                session: { accountId: run.accountId } }, select: { workDepth: true },
        });
    if (!source || !Number.isSafeInteger(source.workDepth) || source.workDepth < 0) {
        return { kind: "unavailable", errorCode: "source_unavailable" };
    }
    return { kind: "available", workDepth: source.workDepth };
}

/**
 * Rejoins the already-committed effect of the same signed claim request without
 * mutating anything: no attempt increment, no lease extension, no re-emitted
 * transition. The replay validates the Run's canonical recipe envelope, re-read
 * from its transition-managed row, under the current Account witness, so a
 * retried request receives the same committed claim effect — same Run and
 * attempt — without resurfacing a mode-stale recipe or Account witness. Any
 * receipt whose strict result no longer re-verifies against current canonical
 * state fails closed as the same no-Run shape.
 */
async function resolveClaimReceiptTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    machineId: string;
    machineInstallationId: string;
    claimRequestNonceDigest: string;
    now: Date;
    expectedTriggerKind?: AutomationTriggerKind;
    recipeFeaturePolicy: AutomationRecipeFeaturePolicy;
}>): Promise<AutomationClaimResult | undefined> {
    const receipt = await params.tx.automationWorkerClaimReceipt.findUnique({
        where: { id: params.claimRequestNonceDigest },
        select: {
            accountId: true,
            machineId: true,
            machineInstallationId: true,
            claimResultJson: true,
            expiresAt: true,
        },
    });
    if (!receipt) return undefined;
    if (
        receipt.accountId !== params.accountId
        || receipt.machineId !== params.machineId
        || receipt.machineInstallationId !== params.machineInstallationId
        || receipt.expiresAt.getTime() <= params.now.getTime()
    ) {
        return { run: null, accountCurrentness: null };
    }
    const committedResult = parseAutomationClaimReceiptResultV2(receipt.claimResultJson);
    if (!committedResult.ok) return { run: null, accountCurrentness: null };

    // The strict committed result is the receipt's only outcome owner: it
    // names the claimed Run and attempt, or the empty outcome, for this signed
    // request.
    const run = committedResult.result.run;
    const automation = committedResult.result.automation;
    if (
        !run
        || (!params.recipeFeaturePolicy.workflowsEnabled && run.recipeKind === "workflow-v2")
        || (run.automationId !== null && !automation)
        || (run.automationId === null && automation !== null)
        || (params.expectedTriggerKind !== undefined && (
            run.automationId === null
            || !("cause" in run)
            ||
            run.cause.kind !== "trigger"
            || run.cause.triggerKind !== params.expectedTriggerKind
        ))
    ) return { run: null, accountCurrentness: null };
    // A newer lease attempt supersedes the old claim authority. Read only the
    // attempt and the canonical recipe envelope from the live row; every other
    // response field still comes from the frozen receipt so normal
    // state/revision/settlement changes cannot rewrite the result of the
    // original signed request. The envelope is not stored in the receipt (its
    // canonical owner is the transition-managed Run row), so replay validates
    // the live bytes under the current Account witness instead of resurfacing
    // stale private content or delaying this claimed attempt until lease expiry.
    const currentAttempt = await params.tx.automationRun.findFirst({
        where: {
            id: run.id,
            accountId: params.accountId,
        },
        select: {
            attempt: true,
            executionInputEnvelope: true,
            triggerEvidenceEnvelope: true,
            workflowCustodyState: true,
            originKind: true,
            workflowAcceptedSnapshotEnvelope: true,
        },
    });
    if (!currentAttempt || currentAttempt.attempt !== run.attempt) {
        return { run: null, accountCurrentness: null };
    }
    const retainedV2OriginKind = run.automationId !== null && run.cause.kind === "manual"
        ? "manual" as const
        : run.automationId !== null && run.cause.kind === "trigger" && run.cause.triggerKind === "schedule"
            ? "scheduled" as const
            : undefined;
    const replayWitness = await fetchAutomationAccountCurrentnessWitnessTx(
        params.tx,
        params.accountId,
    );
    if (!replayWitness || !hasClaimableFrozenRecipe({
        accountId: params.accountId,
        runId: run.id,
        originKind: currentAttempt.originKind,
        executionInputEnvelope: currentAttempt.executionInputEnvelope,
        workflowAcceptedSnapshotEnvelope: currentAttempt.workflowAcceptedSnapshotEnvelope,
        workflowCustodyState: currentAttempt.workflowCustodyState,
        retainedV2OriginKind,
        accountCurrentness: replayWitness,
    })) return { run: null, accountCurrentness: null };
    const lastSucceededRun = run.automationId !== null && run.lastSucceededRun && run.triggerId !== null
        ? await readSucceededCheckpointTx(params.tx, {
            accountId: params.accountId, runId: run.lastSucceededRun.runId, triggerId: run.triggerId,
        }) : undefined;
    return {
        run: null,
        accountCurrentness: replayWitness,
        receiptReplay: {
            run: AutomationV3WorkerClaimedRunSchema.parse(run.automationId === null
                ? {
                    ...run,
                    workflowAcceptedSnapshotEnvelope: currentAttempt.workflowAcceptedSnapshotEnvelope,
                }
                : {
                    ...run,
                    executionInputEnvelope: currentAttempt.executionInputEnvelope,
                    ...(currentAttempt.workflowAcceptedSnapshotEnvelope === null ? {} : {
                        workflowAcceptedSnapshotEnvelope: currentAttempt.workflowAcceptedSnapshotEnvelope,
                    }),
                    lastSucceededRun,
                    ...(currentAttempt.workflowCustodyState !== null
                        ? { automationEvidenceEnvelope: currentAttempt.triggerEvidenceEnvelope }
                        : {}),
                }),
            automation,
        },
    };
}

async function createClaimReceiptTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    machineId: string;
    machineInstallationId: string;
    claimRequestNonceDigest: string;
    expiresAt: Date;
    result: AutomationClaimResult;
}>): Promise<AutomationClaimResult> {
    try {
        await params.tx.automationWorkerClaimReceipt.create({
            data: {
                id: params.claimRequestNonceDigest,
                accountId: params.accountId,
                machineId: params.machineId,
                machineInstallationId: params.machineInstallationId,
                claimResultJson: serializeAutomationClaimReceiptResultV2(params.result),
                expiresAt: params.expiresAt,
            },
        });
    } catch (error) {
        if (isPrismaErrorCode(error, "P2002")) {
            throw new AutomationClaimReceiptConflictError();
        }
        throw error;
    }
    return params.result;
}

export async function claimAutomationRun(params: {
    accountId: string;
    machineId: string;
    leaseDurationMs: number;
    expectedTriggerKind?: AutomationTriggerKind;

    /** Exact signed HTTP claim identity; direct service callers may omit a receipt. */
    claimRequest?: AutomationClaimRequest;
    recipeFeaturePolicy?: AutomationRecipeFeaturePolicy;
    scope?: "session_scoped";
}): Promise<AutomationClaimResult> {
    const recipeFeaturePolicy = params.recipeFeaturePolicy ?? await resolveAutomationRecipeFeaturePolicy();
    const execute = async (): Promise<AutomationClaimResult> => await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status === "account_not_found") {
            return { run: null, accountCurrentness: null };
        }
        const machine = await tx.machine.findFirst({
            where: {
                accountId: params.accountId,
                id: params.machineId,
                ...persistentMachineWhere,
                revokedAt: null,
                replacedByMachineId: null,
            },
            select: { id: true, installationId: true },
        });
        if (!machine) {
            return { run: null, accountCurrentness: null };
        }

        const now = new Date();
        const claimRequestNonceDigest = params.claimRequest
            ? deriveClaimRequestNonceDigest({
                machineId: params.machineId,
                machineInstallationId: params.claimRequest.machineInstallationId,
                nonce: params.claimRequest.nonce,
            })
            : null;
        if (
            params.claimRequest
            && (
                machine.installationId !== params.claimRequest.machineInstallationId
                || params.claimRequest.expiresAt.getTime() <= now.getTime()
            )
        ) {
            return { run: null, accountCurrentness: null };
        }
        if (claimRequestNonceDigest) {
            const replayed = await resolveClaimReceiptTx({
                tx,
                accountId: params.accountId,
                machineId: params.machineId,
                machineInstallationId: params.claimRequest!.machineInstallationId,
                claimRequestNonceDigest,
                now,
                expectedTriggerKind: params.expectedTriggerKind,
                recipeFeaturePolicy,
            });
            if (replayed !== undefined) return replayed;
        }
        const settleClaimRequest = async (result: AutomationClaimResult) =>
            claimRequestNonceDigest
                ? await createClaimReceiptTx({
                    tx,
                    accountId: params.accountId,
                    machineId: params.machineId,
                    machineInstallationId: params.claimRequest!.machineInstallationId,
                    claimRequestNonceDigest,
                    expiresAt: params.claimRequest!.expiresAt,
                    result,
                })
                : result;
        if (accountFence.status !== "ready") {
            return await settleClaimRequest({ run: null, accountCurrentness: null });
        }
        const leaseExpiresAt = resolveClaimLeaseExpiresAt({ now, leaseDurationMs: params.leaseDurationMs });

        const candidatePageSize = 25;
        // One bounded candidate page per claim attempt; frozen input validation
        // decides admission for both current recipes and retained 0.2 data.
        const candidates = await findClaimCandidates({
            tx,
            accountId: params.accountId,
            machineId: params.machineId,
            now,
            limit: candidatePageSize,
            expectedTriggerKind: params.expectedTriggerKind,
            recipeFeaturePolicy,
            scope: params.scope,
        });

        for (const candidate of candidates) {
            if (candidate.triggerId) {
                const scoped = await lockScopedAutomationTriggerInTx(tx, params.accountId, candidate.triggerId);
                if (scoped && candidate.state === "queued") {
                    const active = await tx.automationRun.findFirst({ where: {
                        accountId: params.accountId, triggerId: candidate.triggerId,
                        state: { notIn: ["queued", ...AUTOMATION_RUN_TERMINAL_STATES] },
                    }, select: { id: true } });
                    if (active) continue;
                }
            }
            if (!isClaimCandidateState(candidate.state)) {
                continue;
            }
            if (!isRunClaimableState({
                state: candidate.state,
                leaseExpiresAt: candidate.leaseExpiresAt,
                now,
            })) {
                continue;
            }
            const preclaimCurrentness = await fetchAutomationAccountCurrentnessWitnessTx(tx, params.accountId);
            if (!preclaimCurrentness) {
                return await settleClaimRequest({ run: null, accountCurrentness: null });
            }
            const causeWorkDepth = await readAutomationCauseWorkDepthTx(tx, { ...candidate, accountId: params.accountId });
            if (causeWorkDepth.kind === "unavailable") {
                if (candidate.state === "queued" && candidate.automationId !== null
                    && (candidate.workflowCustodyState === null || candidate.workflowCustodyState === "pending")) {
                    await failInvalidAutomationRunBeforeClaimTx({
                        tx, accountId: params.accountId, automationId: candidate.automationId,
                        runId: candidate.id, state: candidate.state, runRevision: candidate.revision,
                        executionInputEnvelope: candidate.executionInputEnvelope,
                        workflowCustodyState: candidate.workflowCustodyState,
                        errorCode: causeWorkDepth.errorCode, accountCurrentness: preclaimCurrentness, now,
                    });
                }
                // Reclaim never terminalizes already-started custody from a missing source.
                continue;
            }
            if (!hasExactDerivedAssignmentIndex(candidate)) {
                if (candidate.state === "queued" && candidate.automationId !== null) {
                    await failInvalidAutomationRunBeforeClaimTx({
                        tx,
                        accountId: params.accountId,
                        automationId: candidate.automationId,
                        runId: candidate.id,
                        state: candidate.state,
                        runRevision: candidate.revision,
                        executionInputEnvelope: candidate.executionInputEnvelope,
                        accountCurrentness: preclaimCurrentness,
                        now,
                    });
                }
                continue;
            }

            const parsedCandidateRecipe = parseAutomationRunExecutionRecipeV1(candidate.executionInputEnvelope);
            const isExecutionRun = parsedCandidateRecipe.kind === "available"
                && parsedCandidateRecipe.recipe.target.kind === "executionRun";

            if (
                candidate.state !== "queued" && candidate.state !== "pause_requested"
                && (
                    candidate.executionDispatchState === "dispatchPermitted"
                    || (
                        isExecutionRun
                        && candidate.state === "running"
                        && candidate.executionDispatchState === null
                    )
                )
            ) {
                if (!isAutomationCauseRow(candidate)) continue;
                await markAbandonedAutomationExecutionDispatchOutcomeUnknownTx({
                    tx,
                    accountId: params.accountId,
                    automationId: candidate.automationId,
                    runId: candidate.id,
                    state: candidate.state,
                    runRevision: candidate.revision,
                    executionInputEnvelope: candidate.executionInputEnvelope,
                    expectedExecutionDispatchState: candidate.executionDispatchState,
                    accountCurrentness: preclaimCurrentness,
                    now,
                });
                continue;
            }
            if (
                !hasClaimableFrozenRecipe({
                    accountId: params.accountId,
                    runId: candidate.id,
                    originKind: candidate.originKind,
                    executionInputEnvelope: candidate.executionInputEnvelope,
                    workflowAcceptedSnapshotEnvelope: candidate.workflowAcceptedSnapshotEnvelope,
                    workflowCustodyState: candidate.workflowCustodyState,
                    retainedV2OriginKind: candidate.originKind === "automation"
                        ? retainedV2OriginKindForRun(candidate)
                        : undefined,
                    accountCurrentness: preclaimCurrentness,
                })
            ) {
                if (candidate.automationId !== null && candidate.state !== "pause_requested") await failInvalidAutomationRunBeforeClaimTx({
                    tx,
                    accountId: params.accountId,
                    automationId: candidate.automationId,
                    runId: candidate.id,
                    state: candidate.state,
                    runRevision: candidate.revision,
                    executionInputEnvelope: candidate.executionInputEnvelope,
                    accountCurrentness: preclaimCurrentness,
                    now,
                });
                continue;
            }

            const updated = await tryClaimRun({
                tx,
                runId: candidate.id,
                previousState: candidate.state,
                expectedRunRevision: candidate.revision,
                executionInputEnvelope: candidate.executionInputEnvelope,
                now,
                machineId: params.machineId,
                leaseExpiresAt,
                normalizeNullExecutionDispatchState: isExecutionRun
                    && candidate.state === "claimed"
                    && candidate.executionDispatchState === null,
                expectedTriggerKind: params.expectedTriggerKind,
            });
            if (updated.count !== 1) {
                continue;
            }

            const run = await fetchClaimedRun(tx, candidate.id);
            if (!run) {
                continue;
            }
            const projectedRun = await projectClaimedRunWithTriggerCurrentness(tx, run);

            let cursor: number;
            if (run.originKind === "direct") {
                cursor = await markAccountChanged(tx, {
                    accountId: params.accountId,
                    kind: "account",
                    entityId: `workflow-run:${run.id}`,
                });
            } else {
                assertAutomationClaimRun(run);
                cursor = await markAccountChanged(tx, {
                    accountId: params.accountId,
                    kind: "automation",
                    entityId: run.automationId,
                });
            }
            const accountCurrentness = await fetchAutomationAccountCurrentnessWitnessTx(tx, params.accountId);
            if (!accountCurrentness) {
                // Returning after the claim would commit a Run a worker cannot
                // safely start, so abort the transaction instead.
                throw new Error("Automation Account currentness became unavailable during claim");
            }

            if (candidate.state === "pause_requested") {
                // Workflow control states use the existing machine-only
                // projection; they are not Automation lifecycle enum members.
                afterTx(tx, () => emitAutomationRunUpdatedToMachineOnly({
                    accountId: params.accountId,
                    machineId: params.machineId,
                    run: { ...run, state: "pause_requested" },
                    cursor,
                }));
            } else if (run.originKind === "automation") {
                const automationRun = projectAutomationOriginRun(projectedRun);
                if (!automationRun) throw new Error("Claimed Automation Run has invalid origin correspondence");
                const previousState = candidate.state;
                afterTx(tx, () => {
                    emitAutomationRunTransition({
                        accountId: params.accountId,
                        run: automationRun,
                        previousState,
                        cursor,
                    });
                });
            }

            return await settleClaimRequest({
                run: { ...projectedRun, recipeKind: recipeKindForClaimRun(projectedRun),
                    // The CAS consumed this request. Keep it only in this exact
                    // claim/receipt, never in the re-read mutable Run row.
                    workflowResumeRequestedRevision: candidate.workflowResumeRequestedRevision,
                    causeWorkDepth: causeWorkDepth.workDepth },
                accountCurrentness,
            });
        }

        return await settleClaimRequest({ run: null, accountCurrentness: null });
    });

    try {
        return await execute();
    } catch (error) {
        if (!params.claimRequest || !(error instanceof AutomationClaimReceiptConflictError)) {
            throw error;
        }
        const claimRequestNonceDigest = deriveClaimRequestNonceDigest({
            machineId: params.machineId,
            machineInstallationId: params.claimRequest.machineInstallationId,
            nonce: params.claimRequest.nonce,
        });
        return await inTx(async (tx) => {
            const replayed = await resolveClaimReceiptTx({
                tx,
                accountId: params.accountId,
                machineId: params.machineId,
                machineInstallationId: params.claimRequest!.machineInstallationId,
                claimRequestNonceDigest,
                now: new Date(),
                expectedTriggerKind: params.expectedTriggerKind,
                recipeFeaturePolicy,
            });
            // A conflicting request never retries the non-idempotent effect.
            // The winner should be visible after the unique-key conflict; if a
            // provider cannot expose it, fail closed as the same no-Run shape.
            return replayed ?? { run: null, accountCurrentness: null };
        });
    }
}

export async function heartbeatAutomationRun(params: {
    accountId: string;
    runId: string;
    machineId: string;
    attempt?: number;
    leaseDurationMs: number;
    expectedTriggerKind?: AutomationTriggerKind;

}): Promise<{ ok: boolean; leaseExpiresAt: Date | null }> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return { ok: false, leaseExpiresAt: null };

        const now = new Date();
        const leaseExpiresAt = resolveClaimLeaseExpiresAt({ now, leaseDurationMs: params.leaseDurationMs });


        const expectedAttempt = params.attempt;
        if (expectedAttempt === undefined) {
            return { ok: false, leaseExpiresAt: null };
        }

        const updated = await tx.automationRun.updateMany({
            where: {
                id: params.runId,
                accountId: params.accountId,
                claimedByMachineId: params.machineId,
                attempt: expectedAttempt,
                state: { in: ["claimed", "running", "pause_requested"] },
                leaseExpiresAt: { gt: now },
                ...expectedRunTriggerCauseWhere(params.expectedTriggerKind),
            },
            data: {
                leaseExpiresAt,
                updatedAt: now,
            },
        });

        if (updated.count !== 1) {
            return { ok: false, leaseExpiresAt: null };
        }

        return { ok: true, leaseExpiresAt };
    });
}
