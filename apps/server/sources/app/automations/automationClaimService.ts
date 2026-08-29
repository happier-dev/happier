import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { readMachineAvailabilityStateInTx } from "@/app/machines/machineStateGuards";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import {
    AutomationAccountCurrentnessWitnessV1Schema,
    parseAutomationRunExecutionRecipeV1,
    validateAutomationRunExecutionRecipeOuterV1,
    type AutomationAccountCurrentnessWitnessV1,
} from "@happier-dev/protocol";

import { emitAutomationRunTransition } from "./automationChangePublisher";
import { fetchAutomationAccountCurrentnessWitnessTx } from "./automationAccountCurrentness";
import { automationRunWithAutomationSelect } from "./automationPersistenceSelect";
import {
    RETAINED_AUTOMATION_RUN_EXECUTION_INPUT_V2_JSON_PREFIX,
    validateRetainedAutomationRunExecutionInputV2OuterForMode,
} from "./automationStoredContentRead";
import {
    decodeAutomationRunCause,
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

type ClaimCandidateState = "queued" | "claimed" | "running";

type AutomationClaimResult = Readonly<{
    run: AutomationRunWithAutomation | null;
    accountCurrentness: AutomationAccountCurrentnessWitnessV1 | null;
}>;

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

const AUTOMATION_CLAIM_REQUIRED_DATE_FIELDS = [
    "scheduledAt",
    "dueAt",
    "createdAt",
    "updatedAt",
] as const;

const AUTOMATION_CLAIM_NULLABLE_DATE_FIELDS = [
    "causeOccurredAt",
    "causeScheduledFor",
    "executionDispatchCommittedAt",
    "executionDispatchDueAt",
    "replyHandoffDueAt",
    "claimedAt",
    "startedAt",
    "finishedAt",
    "leaseExpiresAt",
] as const;

type AutomationClaimReceiptResultV1 = Readonly<{
    v: 1;
    run: Readonly<Record<string, unknown>> | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The receipt is the one idempotency owner for a signed claim. Persist the
 * exact bounded Run projection selected for that response rather than a
 * pointer back to mutable Run state. Dates are the only non-JSON values in the
 * canonical selection and are encoded explicitly as epoch milliseconds.
 */
function serializeAutomationClaimReceiptResultV1(result: AutomationClaimResult): string {
    if (!result.run) return JSON.stringify({ v: 1, run: null } satisfies AutomationClaimReceiptResultV1);
    const run: Record<string, unknown> = { ...result.run };
    for (const field of AUTOMATION_CLAIM_REQUIRED_DATE_FIELDS) {
        run[field] = result.run[field].getTime();
    }
    for (const field of AUTOMATION_CLAIM_NULLABLE_DATE_FIELDS) {
        run[field] = result.run[field]?.getTime() ?? null;
    }
    return JSON.stringify({ v: 1, run } satisfies AutomationClaimReceiptResultV1);
}

function parseAutomationClaimReceiptResultV1(
    serialized: string,
): Readonly<{ ok: true; run: AutomationRunWithAutomation | null }> | Readonly<{ ok: false }> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(serialized);
    } catch {
        return { ok: false };
    }
    if (!isRecord(parsed) || parsed.v !== 1 || !(parsed.run === null || isRecord(parsed.run))) {
        return { ok: false };
    }
    if (parsed.run === null) return { ok: true, run: null };

    const run = { ...parsed.run };
    for (const field of AUTOMATION_CLAIM_REQUIRED_DATE_FIELDS) {
        const value = run[field];
        if (typeof value !== "number" || !Number.isSafeInteger(value)) return { ok: false };
        run[field] = new Date(value);
    }
    for (const field of AUTOMATION_CLAIM_NULLABLE_DATE_FIELDS) {
        const value = run[field];
        if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
            return { ok: false };
        }
        run[field] = value === null ? null : new Date(value);
    }
    if (
        typeof run.id !== "string"
        || typeof run.accountId !== "string"
        || typeof run.automationId !== "string"
        || typeof run.claimedByMachineId !== "string"
        || !Number.isSafeInteger(run.attempt)
        || !Array.isArray(run.assignments)
        || !isRecord(run.automation)
        || typeof run.automation.id !== "string"
        || typeof run.automation.name !== "string"
        || typeof run.automation.enabled !== "boolean"
    ) {
        return { ok: false };
    }
    return { ok: true, run: run as unknown as AutomationRunWithAutomation };
}

function isClaimCandidateState(state: string): state is ClaimCandidateState {
    return state === "queued" || state === "claimed" || state === "running";
}

/**
 * Current recipe bytes are admitted only through Protocol. The retained V2
 * parser is a read-only compatibility boundary while released V2 workers can
 * still surface their frozen bytes; it never produces or rewrites a recipe.
 */
function hasClaimableFrozenRecipe(params: {
    executionInputEnvelope: string | null;
    retainedV2OriginKind?: "scheduled" | "manual";
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    requireV2RunRepresentability?: boolean;
}): boolean {
    if (params.requireV2RunRepresentability) {
        if (params.executionInputEnvelope === null) return false;
        return validateRetainedAutomationRunExecutionInputV2OuterForMode({
            raw: params.executionInputEnvelope,
            mode: params.accountCurrentness.mode,
            retainedV2OriginKind: params.retainedV2OriginKind,
        })?.kind === "available";
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
    if (params.state !== "claimed" && params.state !== "running") return false;
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
    id: true,
    automationId: true,
    triggerId: true,
    state: true,
    revision: true,
    attempt: true,
    executionDispatchState: true,
    executionAttempt: true,
    executionInputEnvelope: true,
    leaseExpiresAt: true,
    dueAt: true,
    causeKind: true,
    causeTriggerKind: true,
    causeTriggerRevision: true,
    causeOccurredAt: true,
    causeEventPluginId: true,
    causeEventLocalId: true,
    causeScheduledFor: true,
    causeSessionLifecycleEvent: true,
    causeSourceSessionId: true,
    causeSourceTurnId: true,
    occurrenceKey: true,
    causeSourceSelectorId: true,
    createdAt: true,
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
    requireV2RunRepresentability?: boolean;
}) {
    return await params.tx.automationRun.findMany({
        where: {
            accountId: params.accountId,
            dueAt: { lte: params.now },
            ...expectedRunTriggerCauseWhere(params.expectedTriggerKind),
            // A released V2 claimant can only ever claim retained V2 frozen
            // bytes. The persisted-bytes discriminator bounds the scan to one
            // query instead of paging past current-recipe Runs; the parsed
            // retained-V2 predicate at claim time remains the admission
            // decision.
            ...(params.requireV2RunRepresentability
                ? { executionInputEnvelope: { startsWith: RETAINED_AUTOMATION_RUN_EXECUTION_INPUT_V2_JSON_PREFIX } }
                : {}),
            OR: [
                {
                    state: "queued",
                    assignments: runAssignmentClaimWhere(params.machineId),
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
                claimedAt: params.now,
                claimedByMachineId: params.machineId,
                leaseExpiresAt: params.leaseExpiresAt,
                attempt: { increment: 1 },
                revision: { increment: 1 },
            },
        });
    }

    const previousState = params.previousState === "running" ? "running" : "claimed";
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
            state: "claimed",
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

async function fetchClaimedRun(tx: Tx, runId: string): Promise<AutomationRunWithAutomation | null> {
    const row = await tx.automationRun.findUnique({
        where: { id: runId },
        select: automationRunWithAutomationSelect,
    });

    if (!row) return null;
    return row;
}

async function projectClaimedRunWithTriggerCurrentness(
    tx: Tx,
    run: AutomationRunWithAutomation,
): Promise<AutomationRunWithAutomation> {
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
    };
}

/**
 * Rejoins the already-committed effect of the same signed claim request without
 * mutating anything: no attempt increment, no lease extension, no re-emitted
 * transition. The replay validates the frozen recipe under the committed
 * post-claim witness persisted beside the claim, so a retried request receives
 * exactly the response the original claim committed — never a freshly minted
 * Account sequence. A receipt without that committed witness is stale and
 * fails closed as the same no-Run shape.
 */
async function resolveClaimReceiptTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    machineId: string;
    machineInstallationId: string;
    claimRequestNonceDigest: string;
    now: Date;
    expectedTriggerKind?: AutomationTriggerKind;
}>): Promise<AutomationClaimResult | undefined> {
    const receipt = await params.tx.automationWorkerClaimReceipt.findUnique({
        where: { id: params.claimRequestNonceDigest },
        select: {
            accountId: true,
            machineId: true,
            machineInstallationId: true,
            runId: true,
            claimedAttempt: true,
            accountCurrentnessWitnessJson: true,
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
    const committedResult = typeof receipt.claimResultJson === "string"
        ? parseAutomationClaimReceiptResultV1(receipt.claimResultJson)
        : { ok: false as const };
    if (!committedResult.ok) return { run: null, accountCurrentness: null };
    if (receipt.runId === null || receipt.claimedAttempt === null) {
        return committedResult.run === null
            ? { run: null, accountCurrentness: null }
            : { run: null, accountCurrentness: null };
    }
    let committedWitness: AutomationAccountCurrentnessWitnessV1 | null = null;
    if (typeof receipt.accountCurrentnessWitnessJson === "string") {
        try {
            committedWitness = AutomationAccountCurrentnessWitnessV1Schema.parse(
                JSON.parse(receipt.accountCurrentnessWitnessJson),
            );
        } catch {
            committedWitness = null;
        }
    }
    if (!committedWitness) return { run: null, accountCurrentness: null };

    const run = committedResult.run;
    if (
        !run
        || run.id !== receipt.runId
        || run.accountId !== params.accountId
        || run.claimedByMachineId !== params.machineId
        || run.attempt !== receipt.claimedAttempt
        || (params.expectedTriggerKind !== undefined && run.causeTriggerKind !== params.expectedTriggerKind)
    ) return { run: null, accountCurrentness: null };
    // A newer lease attempt supersedes the old claim authority. Read only that
    // currentness fact from the live row; every response field still comes
    // from the frozen receipt so normal state/revision/settlement changes
    // cannot rewrite the result of the original signed request.
    const currentAttempt = await params.tx.automationRun.findFirst({
        where: { id: run.id, accountId: params.accountId },
        select: { attempt: true },
    });
    if (!currentAttempt || currentAttempt.attempt !== receipt.claimedAttempt) {
        return { run: null, accountCurrentness: null };
    }
    if (
        !hasClaimableFrozenRecipe({
            executionInputEnvelope: run.executionInputEnvelope,
            retainedV2OriginKind: retainedV2OriginKindForRun(run),
            accountCurrentness: committedWitness,
        })
    ) {
        return { run: null, accountCurrentness: null };
    }
    return {
        run,
        accountCurrentness: committedWitness,
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
                runId: params.result.run?.id ?? null,
                claimedAttempt: params.result.run?.attempt ?? null,
                // The exact committed post-claim witness travels with the
                // claimed outcome; empty outcomes carry none. A claimed result
                // always carries one — the claim aborts its transaction
                // otherwise.
                accountCurrentnessWitnessJson: params.result.accountCurrentness
                    ? JSON.stringify(params.result.accountCurrentness)
                    : null,
                claimResultJson: serializeAutomationClaimReceiptResultV1(params.result),
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
    requireV2RunRepresentability?: boolean;
    /** Exact V3 signed request identity; omitted only by the released V2 seam. */
    claimRequest?: AutomationClaimRequest;
}): Promise<AutomationClaimResult> {
    const execute = async (): Promise<AutomationClaimResult> => await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status === "account_not_found") {
            return { run: null, accountCurrentness: null };
        }
        const machine = await tx.machine.findFirst({
            where: {
                accountId: params.accountId,
                id: params.machineId,
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
        // One bounded candidate page per claim attempt. The released-V2
        // discriminator keeps that page free of current-recipe Runs, so no
        // claim path pages through incompatible work.
        const candidates = await findClaimCandidates({
            tx,
            accountId: params.accountId,
            machineId: params.machineId,
            now,
            limit: candidatePageSize,
            expectedTriggerKind: params.expectedTriggerKind,
            requireV2RunRepresentability: params.requireV2RunRepresentability,
        });

        for (const candidate of candidates) {
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
            if (!hasExactDerivedAssignmentIndex(candidate)) {
                if (candidate.state === "queued") {
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
            const hasV2FrozenRecipe = params.requireV2RunRepresentability
                ? hasClaimableFrozenRecipe({
                    executionInputEnvelope: candidate.executionInputEnvelope,
                    retainedV2OriginKind: retainedV2OriginKindForRun(candidate),
                    accountCurrentness: preclaimCurrentness,
                    requireV2RunRepresentability: true,
                })
                : null;
            const parsedCandidateRecipe = parseAutomationRunExecutionRecipeV1(candidate.executionInputEnvelope);
            const isExecutionRun = parsedCandidateRecipe.kind === "available"
                && parsedCandidateRecipe.recipe.target.kind === "executionRun";
            if (hasV2FrozenRecipe === false) {
                // The persisted discriminator already proves this is retained
                // V2 input, while the parsed predicate proves that its frozen
                // origin/mode contradicts the immutable Run. No current or V2
                // worker can execute it, so leave terminality to the incumbent
                // Run owner instead of letting one poisoned page starve later
                // compatible work forever.
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
                continue;
            }
            if (
                candidate.state !== "queued"
                && (
                    candidate.executionDispatchState === "dispatchPermitted"
                    || (
                        isExecutionRun
                        && candidate.state === "running"
                        && candidate.executionDispatchState === null
                    )
                )
            ) {
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
                !params.requireV2RunRepresentability
                && !hasClaimableFrozenRecipe({
                    executionInputEnvelope: candidate.executionInputEnvelope,
                    retainedV2OriginKind: retainedV2OriginKindForRun(candidate),
                    accountCurrentness: preclaimCurrentness,
                })
            ) {
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

            const cursor = await markAccountChanged(tx, {
                accountId: params.accountId,
                kind: "automation",
                entityId: run.automationId,
            });
            const accountCurrentness = await fetchAutomationAccountCurrentnessWitnessTx(tx, params.accountId);
            if (!accountCurrentness) {
                // Returning after the claim would commit a Run a worker cannot
                // safely start, so abort the transaction instead.
                throw new Error("Automation Account currentness became unavailable during claim");
            }

            afterTx(tx, () => {
                emitAutomationRunTransition({
                    accountId: params.accountId,
                    run: projectedRun,
                    previousState: candidate.state,
                    cursor,
                });
            });

            return await settleClaimRequest({ run: projectedRun, accountCurrentness });
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
    /** Released V2 workers omitted this token; their adapter resolves it from the current same-machine lease. */
    attempt?: number;
    leaseDurationMs: number;
    expectedTriggerKind?: AutomationTriggerKind;
    requireV2RunRepresentability?: boolean;
}): Promise<{ ok: boolean; leaseExpiresAt: Date | null }> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return { ok: false, leaseExpiresAt: null };
        if (
            params.requireV2RunRepresentability
            && await readMachineAvailabilityStateInTx({
                tx,
                accountId: params.accountId,
                machineId: params.machineId,
            }) !== "available"
        ) return { ok: false, leaseExpiresAt: null };
        const now = new Date();
        const leaseExpiresAt = resolveClaimLeaseExpiresAt({ now, leaseDurationMs: params.leaseDurationMs });

        const candidate = params.requireV2RunRepresentability
            ? await tx.automationRun.findFirst({
                where: {
                    id: params.runId,
                    accountId: params.accountId,
                    claimedByMachineId: params.machineId,
                    ...(params.attempt === undefined ? {} : { attempt: params.attempt }),
                    state: { in: ["claimed", "running"] },
                    leaseExpiresAt: { gt: now },
                    ...expectedRunTriggerCauseWhere(params.expectedTriggerKind),
                },
                select: automationRunWithAutomationSelect,
            })
            : null;
        if (
            params.requireV2RunRepresentability
            && (
                !candidate?.executionInputEnvelope
                || validateRetainedAutomationRunExecutionInputV2OuterForMode({
                    raw: candidate.executionInputEnvelope,
                    mode: accountFence.account.currentness.encryptionMode,
                    retainedV2OriginKind: retainedV2OriginKindForRun(candidate),
                })?.kind !== "available"
            )
        ) {
            return { ok: false, leaseExpiresAt: null };
        }
        const expectedAttempt = candidate?.attempt ?? params.attempt;
        if (expectedAttempt === undefined) {
            return { ok: false, leaseExpiresAt: null };
        }

        const updated = await tx.automationRun.updateMany({
            where: {
                id: params.runId,
                accountId: params.accountId,
                claimedByMachineId: params.machineId,
                attempt: expectedAttempt,
                state: { in: ["claimed", "running"] },
                leaseExpiresAt: { gt: now },
                ...expectedRunTriggerCauseWhere(params.expectedTriggerKind),
                ...(candidate
                    ? {
                        executionInputEnvelope: candidate.executionInputEnvelope,
                    }
                    : {}),
            },
            data: {
                leaseExpiresAt,
                revision: { increment: 1 },
                updatedAt: now,
            },
        });

        if (updated.count !== 1) {
            return { ok: false, leaseExpiresAt: null };
        }

        return { ok: true, leaseExpiresAt };
    });
}
