import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import {
    parseAutomationRunExecutionRecipeV1,
    validateAutomationRunExecutionRecipeOuterV1,
    type AutomationAccountCurrentnessWitnessV1,
} from "@happier-dev/protocol";

import { emitAutomationRunTransition } from "./automationChangePublisher";
import { fetchAutomationAccountCurrentnessWitnessTx } from "./automationAccountCurrentness";
import { automationRunWithAutomationSelect } from "./automationPersistenceSelect";
import {
    failInvalidAutomationRunBeforeClaimTx,
    markAbandonedAutomationExecutionDispatchOutcomeUnknownTx,
    terminalizeRetiredAutomationRunAfterLeaseExpiryTx,
} from "./automationRunService";
import { validateRetainedAutomationRunExecutionInputV2OuterForMode } from "./automationStoredContentRead";
import type {
    AutomationRunOriginKind,
    AutomationRunWithAutomation,
    AutomationTriggerKind,
} from "./automationTypes";

type ClaimCandidateState = "queued" | "claimed" | "running";

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
    originKind?: AutomationRunOriginKind;
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    requireV2RunRepresentability?: boolean;
}): boolean {
    if (params.requireV2RunRepresentability) {
        if (params.executionInputEnvelope === null) return false;
        return validateRetainedAutomationRunExecutionInputV2OuterForMode({
            raw: params.executionInputEnvelope,
            mode: params.accountCurrentness.mode,
            originKind: params.originKind,
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
    return validateRetainedAutomationRunExecutionInputV2OuterForMode({
        raw: params.executionInputEnvelope,
        mode: params.accountCurrentness.mode,
        originKind: params.originKind,
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

function activeAutomationClaimWhere(params: {
    machineId: string;
    expectedTriggerKind?: AutomationTriggerKind;
}) {
    return {
        enabled: true,
        deletedAt: null,
        ...(params.expectedTriggerKind
            ? { triggerKind: params.expectedTriggerKind }
            : {}),
        assignments: {
            some: {
                machineId: params.machineId,
                enabled: true,
            },
        },
    };
}

/**
 * Which expired leases a machine may recover because their Definition retired.
 *
 * Retirement is a property of the durable Run's own claimant, never of the
 * machine that happens to be scanning. The first disjunct covers a Definition
 * that no machine can reach any more (disabled, deleted, or left with no
 * enabled assignment): its expired lease is recoverable by any Account
 * machine, so a claimant that never returns cannot wedge the row. The second
 * keeps the incumbent claimant able to resolve a Definition that is still live
 * but was reassigned away from it.
 *
 * This is the only owner of that predicate. `findClaimCandidates` selects the
 * rows to resolve and `listDaemonAssignments` projects the recovery wake that
 * makes the scan reachable; both must ask the identical question, so the wake
 * consumes this builder rather than restating it.
 *
 * It only widens who can observe the row. The terminality owner still
 * re-checks retirement against the stored claimant inside its own update and
 * resolves the row before any claim is attempted, and `tryClaimRun` still
 * requires an active assignment for the scanning machine. A recovering machine
 * therefore terminalizes a retired Run and can never execute it.
 */
export function retiredAutomationLeaseRecoveryDisjuncts(params: {
    machineId: string;
    accountId?: string;
    expectedTriggerKind?: AutomationTriggerKind;
}) {
    const automationScope = {
        ...(params.accountId ? { accountId: params.accountId } : {}),
        ...(params.expectedTriggerKind
            ? { triggerKind: params.expectedTriggerKind }
            : {}),
    };
    return [
        {
            claimedByMachineId: { not: null },
            automation: {
                ...automationScope,
                OR: [
                    { enabled: false },
                    { deletedAt: { not: null } },
                    { assignments: { none: { enabled: true } } },
                ],
            },
        },
        {
            claimedByMachineId: params.machineId,
            automation: {
                ...automationScope,
                assignments: {
                    none: {
                        machineId: params.machineId,
                        enabled: true,
                    },
                },
            },
        },
    ];
}

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
            OR: [
                {
                    state: "queued",
                    automation: activeAutomationClaimWhere({
                        machineId: params.machineId,
                        expectedTriggerKind: params.expectedTriggerKind,
                    }),
                },
                {
                    state: "claimed",
                    leaseExpiresAt: { lt: params.now },
                    OR: [
                        {
                            automation: activeAutomationClaimWhere({
                                machineId: params.machineId,
                                expectedTriggerKind: params.expectedTriggerKind,
                            }),
                        },
                        ...retiredAutomationLeaseRecoveryDisjuncts({
                            machineId: params.machineId,
                            expectedTriggerKind: params.expectedTriggerKind,
                        }),
                    ],
                },
                {
                    state: "running",
                    leaseExpiresAt: { lt: params.now },
                    OR: [
                        {
                            automation: activeAutomationClaimWhere({
                                machineId: params.machineId,
                                expectedTriggerKind: params.expectedTriggerKind,
                            }),
                        },
                        ...retiredAutomationLeaseRecoveryDisjuncts({
                            machineId: params.machineId,
                            expectedTriggerKind: params.expectedTriggerKind,
                        }),
                    ],
                },
            ],
        },
        orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: params.limit,
        ...(params.cursor
            ? { cursor: { id: params.cursor }, skip: 1 }
            : {}),
        select: {
            id: true,
            automationId: true,
            state: true,
            claimedByMachineId: true,
            leaseExpiresAt: true,
            revision: true,
            originKind: true,
            executionInputEnvelope: true,
            executionDispatchState: true,
        },
    });
}

async function tryClaimRun(params: {
    tx: Tx;
    runId: string;
    previousState: string;
    expectedRunRevision: number;
    executionInputEnvelope: string | null;
    originKind?: AutomationRunOriginKind;
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
                ...(params.originKind ? { originKind: params.originKind } : {}),
                automation: activeAutomationClaimWhere({
                    machineId: params.machineId,
                    expectedTriggerKind: params.expectedTriggerKind,
                }),
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
            ...(params.normalizeNullExecutionDispatchState
                ? { executionDispatchState: null }
                : {}),
            ...(params.originKind ? { originKind: params.originKind } : {}),
            automation: activeAutomationClaimWhere({
                machineId: params.machineId,
                expectedTriggerKind: params.expectedTriggerKind,
            }),
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

export async function claimAutomationRun(params: {
    accountId: string;
    machineId: string;
    leaseDurationMs: number;
    expectedTriggerKind?: AutomationTriggerKind;
    requireV2RunRepresentability?: boolean;
}): Promise<{
    run: AutomationRunWithAutomation | null;
    /** C: read after the claim's Account change marker in the same transaction. */
    accountCurrentness: AutomationAccountCurrentnessWitnessV1 | null;
}> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return { run: null, accountCurrentness: null };
        const machine = await tx.machine.findFirst({
            where: {
                accountId: params.accountId,
                id: params.machineId,
            },
            select: { id: true },
        });
        if (!machine) {
            return { run: null, accountCurrentness: null };
        }

        const now = new Date();
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
                return { run: null, accountCurrentness: null };
            }
            const hasV2FrozenRecipe = params.requireV2RunRepresentability
                ? hasClaimableFrozenRecipe({
                    executionInputEnvelope: candidate.executionInputEnvelope,
                    originKind: candidate.originKind,
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
            if (candidate.state !== "queued" && candidate.claimedByMachineId !== null) {
                const terminalizedRetirement = await terminalizeRetiredAutomationRunAfterLeaseExpiryTx({
                    tx,
                    accountId: params.accountId,
                    automationId: candidate.automationId,
                    runId: candidate.id,
                    state: candidate.state,
                    runRevision: candidate.revision,
                    claimedByMachineId: candidate.claimedByMachineId,
                    executionInputEnvelope: candidate.executionInputEnvelope,
                    originKind: candidate.originKind,
                    executionDispatchState: candidate.executionDispatchState,
                    accountCurrentness: preclaimCurrentness,
                    now,
                    expectedTriggerKind: params.expectedTriggerKind,
                    requireV2RunRepresentability: params.requireV2RunRepresentability,
                });
                if (terminalizedRetirement) {
                    continue;
                }
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
                    expectedTriggerKind: params.expectedTriggerKind,
                });
                continue;
            }
            if (
                !params.requireV2RunRepresentability
                && !hasClaimableFrozenRecipe({
                    executionInputEnvelope: candidate.executionInputEnvelope,
                    originKind: candidate.originKind,
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
                    expectedTriggerKind: params.expectedTriggerKind,
                });
                continue;
            }

            const updated = await tryClaimRun({
                tx,
                runId: candidate.id,
                previousState: candidate.state,
                expectedRunRevision: candidate.revision,
                executionInputEnvelope: candidate.executionInputEnvelope,
                originKind: candidate.originKind,
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
                    run,
                    previousState: candidate.state,
                    cursor,
                });
            });

                return { run, accountCurrentness };
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

        return { run: null, accountCurrentness: null };
    });
}

export async function heartbeatAutomationRun(params: {
    accountId: string;
    runId: string;
    machineId: string;
    attempt: number;
    leaseDurationMs: number;
    expectedTriggerKind?: AutomationTriggerKind;
    requireV2RunRepresentability?: boolean;
}): Promise<{ ok: boolean; leaseExpiresAt: Date | null }> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return { ok: false, leaseExpiresAt: null };
        const now = new Date();
        const leaseExpiresAt = resolveClaimLeaseExpiresAt({ now, leaseDurationMs: params.leaseDurationMs });

        const candidate = params.requireV2RunRepresentability
            ? await tx.automationRun.findFirst({
                where: {
                    id: params.runId,
                    accountId: params.accountId,
                    claimedByMachineId: params.machineId,
                    attempt: params.attempt,
                    state: { in: ["claimed", "running"] },
                    leaseExpiresAt: { gt: now },
                    ...(params.expectedTriggerKind
                        ? { automation: { triggerKind: params.expectedTriggerKind } }
                        : {}),
                },
                select: { executionInputEnvelope: true, originKind: true },
            })
            : null;
        if (
            params.requireV2RunRepresentability
            && (
                !candidate?.executionInputEnvelope
                || validateRetainedAutomationRunExecutionInputV2OuterForMode({
                    raw: candidate.executionInputEnvelope,
                    mode: accountFence.account.currentness.encryptionMode,
                    originKind: candidate.originKind,
                })?.kind !== "available"
            )
        ) {
            return { ok: false, leaseExpiresAt: null };
        }

        const updated = await tx.automationRun.updateMany({
            where: {
                id: params.runId,
                accountId: params.accountId,
                claimedByMachineId: params.machineId,
                attempt: params.attempt,
                state: { in: ["claimed", "running"] },
                leaseExpiresAt: { gt: now },
                ...(candidate
                    ? {
                        executionInputEnvelope: candidate.executionInputEnvelope,
                        originKind: candidate.originKind,
                    }
                    : {}),
                ...(params.expectedTriggerKind
                    ? { automation: { triggerKind: params.expectedTriggerKind } }
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
