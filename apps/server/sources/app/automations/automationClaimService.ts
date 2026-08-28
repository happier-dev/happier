import { createHash } from "node:crypto";
import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { readMachineAvailabilityStateInTx } from "@/app/machines/machineStateGuards";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import {
    parseAutomationRunExecutionRecipeV1,
    validateAutomationRunExecutionRecipeOuterV1,
    type AutomationAccountCurrentnessWitnessV1,
} from "@happier-dev/protocol";

import { emitAutomationRunTransition } from "./automationChangePublisher";
import { fetchAutomationAccountCurrentnessWitnessTx } from "./automationAccountCurrentness";
import { automationRunWithAutomationSelect } from "./automationPersistenceSelect";
import { decodeAutomationRunCause } from "./automationRunCauseCodec";
import {
    failInvalidAutomationRunBeforeClaimTx,
    markAbandonedAutomationExecutionDispatchOutcomeUnknownTx,
} from "./automationRunService";
import { validateRetainedAutomationRunExecutionInputV2OuterForMode } from "./automationStoredContentRead";
import type {
    AutomationRunItem,
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

function retainedV2OriginKindForRun(run: AutomationRunItem): "scheduled" | "manual" | undefined {
    const cause = decodeAutomationRunCause(run);
    if (cause.kind === "manual") return "manual";
    return cause.kind === "trigger" && cause.triggerKind === "schedule"
        ? "scheduled"
        : undefined;
}

/**
 * Current Run recipes are the immutable assignment snapshot. The child rows
 * are only the queryable claim index written from that snapshot by admission.
 */
function hasExactDerivedAssignmentIndex(run: AutomationRunWithAutomation): boolean {
    const parsed = parseAutomationRunExecutionRecipeV1(run.executionInputEnvelope);
    if (parsed.kind !== "available") return true;
    const recipeIds = [...parsed.recipe.assignmentMachineIds].sort();
    const indexIds = run.assignments.map((assignment) => assignment.machineId).sort();
    return recipeIds.length === indexIds.length
        && recipeIds.every((machineId, index) => machineId === indexIds[index]);
}

/** Reads only frozen Run state and the recipe-derived assignment index. */
async function findClaimCandidates(params: {
    tx: Tx;
    accountId: string;
    machineId: string;
    now: Date;
    limit: number;
    cursor?: string;
    expectedTriggerKind?: AutomationTriggerKind;
}) {
    return await params.tx.automationRun.findMany({
        where: {
            accountId: params.accountId,
            dueAt: { lte: params.now },
            ...expectedRunTriggerCauseWhere(params.expectedTriggerKind),
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
        ...(params.cursor
            ? { cursor: { id: params.cursor }, skip: 1 }
            : {}),
        select: automationRunWithAutomationSelect,
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
    return row as AutomationRunWithAutomation;
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
 * transition. The frozen recipe is revalidated against current Account
 * currentness so a replay can never hand a worker bytes its current keys can no
 * longer open; anything else fails closed as the same no-Run shape.
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
    if (receipt.runId === null || receipt.claimedAttempt === null) {
        return { run: null, accountCurrentness: null };
    }

    const run = await params.tx.automationRun.findFirst({
        where: {
            id: receipt.runId,
            accountId: params.accountId,
            claimedByMachineId: params.machineId,
            attempt: receipt.claimedAttempt,
            ...expectedRunTriggerCauseWhere(params.expectedTriggerKind),
        },
        select: automationRunWithAutomationSelect,
    });
    if (!run) return { run: null, accountCurrentness: null };
    const claimedRun = run as AutomationRunWithAutomation;
    const accountCurrentness = await fetchAutomationAccountCurrentnessWitnessTx(
        params.tx,
        params.accountId,
    );
    if (!accountCurrentness) return { run: null, accountCurrentness: null };
    if (
        !hasClaimableFrozenRecipe({
            executionInputEnvelope: claimedRun.executionInputEnvelope,
            retainedV2OriginKind: retainedV2OriginKindForRun(claimedRun),
            accountCurrentness,
        })
    ) {
        return { run: null, accountCurrentness: null };
    }
    return {
        run: await projectClaimedRunWithTriggerCurrentness(params.tx, claimedRun),
        accountCurrentness,
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
        let candidateCursor: string | undefined;
        while (true) {
            const candidates = await findClaimCandidates({
                tx,
                accountId: params.accountId,
                machineId: params.machineId,
                now,
                limit: candidatePageSize,
                cursor: candidateCursor,
                expectedTriggerKind: params.expectedTriggerKind,
            });
            let skippedIncompatibleRetainedV2Candidate = false;

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
                // This Run may be valid for a current worker. A released V2
                // claimant has no authority to classify or mutate it.
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
                if (
                    candidate.executionInputEnvelope !== null
                    && validateRetainedAutomationRunExecutionInputV2OuterForMode({
                        raw: candidate.executionInputEnvelope,
                        mode: preclaimCurrentness.mode,
                    })?.kind === "available"
                ) {
                    // Retained V2 bytes whose frozen origin disagrees with the
                    // durable Run are incompatible, not malformed-current input.
                    skippedIncompatibleRetainedV2Candidate = true;
                    continue;
                }
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

            if (
                candidates.length < candidatePageSize
                || (
                    !params.requireV2RunRepresentability
                    && !skippedIncompatibleRetainedV2Candidate
                )
            ) break;
            candidateCursor = candidates[candidates.length - 1]?.id;
            if (!candidateCursor) break;
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
