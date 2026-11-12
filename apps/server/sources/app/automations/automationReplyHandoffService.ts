import { AutomationAccountCurrentnessWitnessV1Schema, sameAutomationAccountContentIdentityV1, type AutomationAccountCurrentnessWitnessV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { AutomationReplyHandoffSettlementV1Schema, type AutomationReplyHandoffSettlementV1 } from '@happier-dev/protocol/automations/event';
import { nextAutomationReplyHandoffIdForRunV1 } from '@happier-dev/protocol/automations/automationReplyHandoffIdentityV1';
import { type AutomationRunCause } from '@happier-dev/protocol/automations/run-cause';
import type { Prisma } from "@prisma/client";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import {
    acquireAccountEncryptionTransitionFenceInTx,
} from "@/app/encryption/accountEncryptionTransition";
import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { db } from "@/storage/db";

import { resolveClaimLeaseExpiresAt } from "./automationClaimService";
import { emitAutomationRunUpdated } from "./automationChangePublisher";
import {
    automationAccountCurrentnessSelect,
    deriveAutomationAccountCurrentnessWitness,
} from "./automationAccountCurrentness";
import {
    automationRunCauseSelect,
    automationRunItemSelect,
} from "./automationPersistenceSelect";
import { classifyAutomationReplyHandoffDispatchability } from "./automationReplyHandoffDispatchability";
import { decodeAutomationRunCause, isAutomationCauseRow } from "./automationRunCauseCodec";
import type { AutomationRunItem } from "./automationTypes";

export const DEFAULT_AUTOMATION_REPLY_HANDOFF_LEASE_DURATION_MS = 30_000;

export type AutomationReplyHandoffClaim = Readonly<{
    accountId: string;
    automationId: string;
    runId: string;
    handoffId: string;
    occurrenceKey: string;
    cause: AutomationRunCause;
    attempt: number;
    /** The exact Account material authority under which these bytes were claimed. */
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    /** Run-row revision after the durable `ready -> handingOff` claim. */
    runRevision: number;
    recipeKind: "legacy" | "workflow-v2";
    resultEnvelope: string;
    replyContextEnvelope: string;
    target: Readonly<{
        actionPluginId: string;
        actionLocalId: string;
        machineId: string;
        machineInstallationId: string;
        materializationId: string;
    }>;
}>;

const automationReplyHandoffCandidateSelect = {
    ...automationRunCauseSelect,
    id: true,
    accountId: true,
    automationId: true,
    state: true,
    resultEnvelope: true,
    replyContextEnvelope: true,
    replyHandoffActionPluginId: true,
    replyHandoffActionLocalId: true,
    replyHandoffTargetMachineId: true,
    replyHandoffTargetMachineInstallationId: true,
    replyHandoffTargetMaterializationId: true,
    replyHandoffId: true,
    replyHandoffState: true,
    replyHandoffAttempt: true,
    replyHandoffDueAt: true,
    revision: true,
    workflowCustodyState: true,
    account: {
        select: automationAccountCurrentnessSelect,
    },
} satisfies Prisma.AutomationRunSelect;

const automationReplyHandoffDiscoverySelect = {
    id: true,
    accountId: true,
    replyHandoffDueAt: true,
    createdAt: true,
    account: {
        select: automationAccountCurrentnessSelect,
    },
} satisfies Prisma.AutomationRunSelect;

type AutomationReplyHandoffCandidate = Prisma.AutomationRunGetPayload<{
    select: typeof automationReplyHandoffCandidateSelect;
}>;

type AutomationReplyHandoffDiscoveryCandidate = Prisma.AutomationRunGetPayload<{
    select: typeof automationReplyHandoffDiscoverySelect;
}>;

const AUTOMATION_REPLY_HANDOFF_DISCOVERY_PAGE_SIZE = 32;

function isValidDate(value: Date): boolean {
    return Number.isFinite(value.getTime());
}

function isRetryOutcomeWithoutHint(value: unknown): value is Readonly<{ kind: "retry" }> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Readonly<Record<string, unknown>>;
    return Object.keys(record).length === 1 && record.kind === "retry";
}

function normalizeAutomationReplyHandoffRetryOutcome(value: unknown): unknown {
    // Zero means no external deadline; retain the current claim's existing
    // recovery boundary rather than inventing an attempt-derived cadence.
    return isRetryOutcomeWithoutHint(value)
        ? { kind: "retry", retryAfterMs: 0 }
        : value;
}

function handoffCandidateWhere(candidate: AutomationReplyHandoffCandidate): Prisma.AutomationRunWhereInput {
    return {
        id: candidate.id,
        accountId: candidate.accountId,
        automationId: candidate.automationId,
        occurrenceKey: candidate.occurrenceKey,
        state: "succeeded",
        causeKind: "conversation",
        resultEnvelope: candidate.resultEnvelope,
        replyContextEnvelope: candidate.replyContextEnvelope,
        replyHandoffActionPluginId: candidate.replyHandoffActionPluginId,
        replyHandoffActionLocalId: candidate.replyHandoffActionLocalId,
        replyHandoffTargetMachineId: candidate.replyHandoffTargetMachineId,
        replyHandoffTargetMachineInstallationId: candidate.replyHandoffTargetMachineInstallationId,
        replyHandoffTargetMaterializationId: candidate.replyHandoffTargetMaterializationId,
        replyHandoffId: candidate.replyHandoffId,
        replyHandoffState: candidate.replyHandoffState,
        replyHandoffAttempt: candidate.replyHandoffAttempt,
        replyHandoffDueAt: candidate.replyHandoffDueAt,
        revision: candidate.revision,
    };
}

function hasClaimedFrozenIdentity(
    candidate: AutomationReplyHandoffCandidate,
    claim: AutomationReplyHandoffClaim,
): boolean {
    return candidate.accountId === claim.accountId
        && candidate.automationId === claim.automationId
        && candidate.id === claim.runId
        && candidate.replyHandoffId === claim.handoffId
        && candidate.occurrenceKey === claim.occurrenceKey
        && candidate.resultEnvelope === claim.resultEnvelope
        && candidate.replyContextEnvelope === claim.replyContextEnvelope
        && candidate.replyHandoffActionPluginId === claim.target.actionPluginId
        && candidate.replyHandoffActionLocalId === claim.target.actionLocalId
        && candidate.replyHandoffTargetMachineId === claim.target.machineId
        && candidate.replyHandoffTargetMachineInstallationId === claim.target.machineInstallationId
        && candidate.replyHandoffTargetMaterializationId === claim.target.materializationId
        && candidate.revision === claim.runRevision;
}

function isClaimCurrent(
    candidate: AutomationReplyHandoffCandidate,
    claim: AutomationReplyHandoffClaim,
): boolean {
    const currentness = deriveAutomationAccountCurrentnessWitness(candidate.account);
    return currentness !== null
        && sameAutomationAccountContentIdentityV1(claim.accountCurrentness, currentness)
        && hasClaimedFrozenIdentity(candidate, claim);
}

function isDispatchableCandidate(
    candidate: AutomationReplyHandoffCandidate,
): candidate is AutomationReplyHandoffCandidate & Readonly<{
    originKind: "automation";
    automationId: string;
    causeKind: NonNullable<AutomationReplyHandoffCandidate["causeKind"]>;
}> {
    if (!isAutomationCauseRow(candidate)) return false;
    const currentness = deriveAutomationAccountCurrentnessWitness(candidate.account);
    if (!currentness) return false;
    return classifyAutomationReplyHandoffDispatchability({
        facts: candidate,
        mode: currentness.mode,
    }) === "dispatchable";
}

function dueReplyHandoffWhere(now: Date): Prisma.AutomationRunWhereInput {
    return {
        state: "succeeded",
        causeKind: "conversation",
        OR: [
            { replyHandoffState: "ready", replyHandoffDueAt: { lte: now } },
            { replyHandoffState: "handingOff", replyHandoffDueAt: { lt: now } },
        ],
    };
}

function openReplyHandoffWhere(): Prisma.AutomationRunWhereInput {
    return {
        state: "succeeded",
        causeKind: "conversation",
        replyHandoffState: { in: ["ready", "handingOff"] },
        replyHandoffDueAt: { not: null },
    };
}

async function findReplyHandoffDiscoveryPage(params: Readonly<{
    reader: Pick<Tx, "automationRun">;
    where: Prisma.AutomationRunWhereInput;
    after?: Readonly<{
        dueAt: Date;
        createdAt: Date;
        id: string;
    }>;
}>): Promise<AutomationReplyHandoffDiscoveryCandidate[]> {
    const where: Prisma.AutomationRunWhereInput = params.after
        ? {
            AND: [
                params.where,
                {
                    OR: [
                        { replyHandoffDueAt: { gt: params.after.dueAt } },
                        {
                            replyHandoffDueAt: params.after.dueAt,
                            createdAt: { gt: params.after.createdAt },
                        },
                        {
                            replyHandoffDueAt: params.after.dueAt,
                            createdAt: params.after.createdAt,
                            id: { gt: params.after.id },
                        },
                    ],
                },
            ],
        }
        : params.where;
    const candidates = await params.reader.automationRun.findMany({
        where,
        orderBy: [{ replyHandoffDueAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: AUTOMATION_REPLY_HANDOFF_DISCOVERY_PAGE_SIZE,
        select: automationReplyHandoffDiscoverySelect,
    });
    return candidates as AutomationReplyHandoffDiscoveryCandidate[];
}

/**
 * Reads only Account currentness and Run ordering metadata while skipping
 * unresolved Accounts. The selected candidate is revalidated with the
 * canonical transition fence before its opaque payload is read or mutated.
 */
async function findFirstReadReadyAccountHandoffDiscovery(params: Readonly<{
    reader: Pick<Tx, "automationRun">;
    where: Prisma.AutomationRunWhereInput;
}>): Promise<AutomationReplyHandoffDiscoveryCandidate | null> {
    let after: Readonly<{ dueAt: Date; createdAt: Date; id: string }> | undefined;
    while (true) {
        const candidates = await findReplyHandoffDiscoveryPage({ ...params, after });
        if (candidates.length === 0) return null;

        for (const candidate of candidates) {
            if (deriveAutomationAccountCurrentnessWitness(candidate.account) !== null) return candidate;
        }

        const last = candidates[candidates.length - 1]!;
        if (!last.replyHandoffDueAt) return null;
        after = {
            dueAt: last.replyHandoffDueAt,
            createdAt: last.createdAt,
            id: last.id,
        };
    }
}

async function findDueCandidateTx(
    tx: Tx,
    now: Date,
    runId: string,
): Promise<AutomationReplyHandoffCandidate | null> {
    const candidate = await tx.automationRun.findFirst({
        where: { id: runId, ...dueReplyHandoffWhere(now) },
        select: automationReplyHandoffCandidateSelect,
    });
    return candidate as AutomationReplyHandoffCandidate | null;
}

async function fetchAutomationRunItemTx(
    tx: Tx,
    runId: string,
): Promise<AutomationRunItem | null> {
    const run = await tx.automationRun.findUnique({
        where: { id: runId },
        select: automationRunItemSelect,
    });
    return run as AutomationRunItem | null;
}

async function publishAutomationRunMutationTx(
    tx: Tx,
    run: AutomationRunItem,
): Promise<void> {
    const cursor = await markAccountChanged(tx, {
        accountId: run.accountId,
        kind: "automation",
        entityId: run.automationId,
    });
    afterTx(tx, () => {
        emitAutomationRunUpdated({ accountId: run.accountId, run, cursor: cursor.resolveCursor() });
    });
}

/**
 * Settles Conversation reply custody whose exact target machine has crossed
 * the permanent-revocation boundary. Reversible replacement deliberately does
 * not call this owner: preserving retryable custody lets undo restore the
 * original target without rewriting the admitted Run.
 *
 * A ready handoff that has never been attempted cannot have produced an
 * external effect and is suppressed. Once an attempt exists, or while a
 * handoff lease is active, the external outcome may be ambiguous and the
 * existing blocked state preserves that truth for explicit review.
 */
export async function settleAutomationReplyHandoffsForRevokedMachineTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    machineId: string;
    now?: Date;
}>): Promise<void> {
    const candidates = await params.tx.automationRun.findMany({
        where: {
            accountId: params.accountId,
            state: "succeeded",
            causeKind: "conversation",
            replyHandoffTargetMachineId: params.machineId,
            replyHandoffState: { in: ["ready", "handingOff"] },
        },
        select: {
            id: true,
            replyHandoffState: true,
            replyHandoffAttempt: true,
        },
    });
    if (candidates.length === 0) return;

    const now = params.now ?? new Date();
    const suppressIds = candidates
        .filter((candidate) => (
            candidate.replyHandoffState === "ready"
            && candidate.replyHandoffAttempt === 0
        ))
        .map((candidate) => candidate.id);
    const blockIds = candidates
        .filter((candidate) => (
            candidate.replyHandoffState === "handingOff"
            || candidate.replyHandoffAttempt > 0
        ))
        .map((candidate) => candidate.id);

    if (suppressIds.length > 0) {
        await params.tx.automationRun.updateMany({
            where: {
                id: { in: suppressIds },
                accountId: params.accountId,
                state: "succeeded",
                causeKind: "conversation",
                replyHandoffTargetMachineId: params.machineId,
                replyHandoffState: "ready",
                replyHandoffAttempt: 0,
            },
            data: {
                replyHandoffState: "suppressed",
                replyHandoffDueAt: null,
                revision: { increment: 1 },
                updatedAt: now,
            },
        });
    }
    if (blockIds.length > 0) {
        await params.tx.automationRun.updateMany({
            where: {
                id: { in: blockIds },
                accountId: params.accountId,
                state: "succeeded",
                causeKind: "conversation",
                replyHandoffTargetMachineId: params.machineId,
                OR: [
                    { replyHandoffState: "handingOff" },
                    { replyHandoffState: "ready", replyHandoffAttempt: { gt: 0 } },
                ],
            },
            data: {
                replyHandoffState: "blocked",
                replyHandoffDueAt: null,
                revision: { increment: 1 },
                updatedAt: now,
            },
        });
    }

    for (const candidate of candidates) {
        const run = await fetchAutomationRunItemTx(params.tx, candidate.id);
        if (
            run
            && (run.replyHandoffState === "suppressed" || run.replyHandoffState === "blocked")
        ) {
            await publishAutomationRunMutationTx(params.tx, run);
        }
    }
}

async function blockInvalidCandidateTx(
    tx: Tx,
    candidate: AutomationReplyHandoffCandidate,
    now: Date,
): Promise<void> {
    const blocked = await tx.automationRun.updateMany({
        where: handoffCandidateWhere(candidate),
        data: {
            replyHandoffState: "blocked",
            replyHandoffDueAt: null,
            revision: { increment: 1 },
            updatedAt: now,
        },
    });
    if (blocked.count !== 1) return;

    const run = await fetchAutomationRunItemTx(tx, candidate.id);
    if (run) await publishAutomationRunMutationTx(tx, run);
}

/**
 * Finds and leases one due Conversation result handoff. The durable Run row is
 * the sole owner of recovery: a timed-out `handingOff` lease is reclaimed with
 * the same handoff id and a new attempt, never copied into another queue.
 */
export async function claimNextAutomationReplyHandoff(params: Readonly<{
    now: Date;
    leaseDurationMs?: number;
    /** One traversal's due work; leases still use the actual claim time. */
    dueThrough?: Date;
}>): Promise<AutomationReplyHandoffClaim | null> {
    if (!isValidDate(params.now)) return null;

    return await inTx(async (tx) => {
        const initialCandidate = await findFirstReadReadyAccountHandoffDiscovery({
            reader: tx,
            where: dueReplyHandoffWhere(params.dueThrough ?? params.now),
        });
        if (!initialCandidate) return null;

        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, initialCandidate.accountId, "content");
        if (accountFence.status !== "ready") return null;
        const candidate = await findDueCandidateTx(tx, params.now, initialCandidate.id);
        if (!candidate) return null;

        if (!isDispatchableCandidate(candidate)) {
            await blockInvalidCandidateTx(tx, candidate, params.now);
            return null;
        }

        const leaseExpiresAt = resolveClaimLeaseExpiresAt({
            now: params.now,
            leaseDurationMs: params.leaseDurationMs ?? DEFAULT_AUTOMATION_REPLY_HANDOFF_LEASE_DURATION_MS,
        });
        const claimed = await tx.automationRun.updateMany({
            where: {
                ...handoffCandidateWhere(candidate),
                // Account currentness is part of the same claim fence: a
                // transition that wins after the read leaves no stale bytes
                // leased to a daemon.
                account: { is: { seq: candidate.account.seq } },
            },
            data: {
                replyHandoffState: "handingOff",
                replyHandoffAttempt: { increment: 1 },
                replyHandoffDueAt: leaseExpiresAt,
                revision: { increment: 1 },
                updatedAt: params.now,
            },
        });
        if (claimed.count !== 1) return null;

        const run = await fetchAutomationRunItemTx(tx, candidate.id);
        if (!run) return null;
        await publishAutomationRunMutationTx(tx, run);

        if (
            typeof candidate.replyHandoffId !== "string"
            || typeof candidate.occurrenceKey !== "string"
            || typeof candidate.resultEnvelope !== "string"
            || typeof candidate.replyContextEnvelope !== "string"
            || typeof candidate.replyHandoffActionPluginId !== "string"
            || typeof candidate.replyHandoffActionLocalId !== "string"
            || typeof candidate.replyHandoffTargetMachineId !== "string"
            || typeof candidate.replyHandoffTargetMachineInstallationId !== "string"
            || typeof candidate.replyHandoffTargetMaterializationId !== "string"
        ) {
            return null;
        }
        const accountCurrentness = deriveAutomationAccountCurrentnessWitness(candidate.account);
        if (!accountCurrentness) return null;
        const claim = {
            accountId: candidate.accountId,
            automationId: candidate.automationId,
            runId: candidate.id,
            handoffId: candidate.replyHandoffId,
            occurrenceKey: candidate.occurrenceKey,
            cause: decodeAutomationRunCause(candidate),
            attempt: candidate.replyHandoffAttempt + 1,
            runRevision: candidate.revision + 1,
            recipeKind: candidate.workflowCustodyState !== null ? "workflow-v2" as const : "legacy" as const,
            resultEnvelope: candidate.resultEnvelope,
            replyContextEnvelope: candidate.replyContextEnvelope,
            target: {
                actionPluginId: candidate.replyHandoffActionPluginId,
                actionLocalId: candidate.replyHandoffActionLocalId,
                machineId: candidate.replyHandoffTargetMachineId,
                machineInstallationId: candidate.replyHandoffTargetMachineInstallationId,
                materializationId: candidate.replyHandoffTargetMaterializationId,
            },
        } satisfies Omit<AutomationReplyHandoffClaim, "accountCurrentness">;
        return { ...claim, accountCurrentness };
    }, { transactionClass: "automation-reply-handoff-claim" });
}

/** Returns the next durable wake, including recovery of an expired handoff lease. */
export async function findNextAutomationReplyHandoffDueAt(): Promise<Date | null> {
    // Scheduling reads only ordering/currentness metadata. The claim still
    // acquires its transition fence and re-reads the due candidate inTx.
    const next = await findFirstReadReadyAccountHandoffDiscovery({
        reader: db,
        where: {
            ...openReplyHandoffWhere(),
        },
    });
    return next?.replyHandoffDueAt ?? null;
}

/**
 * Present-user recovery for durable blocked custody. The Run remains the sole
 * owner: recovery changes only `blocked -> ready`, retaining the exact frozen
 * result, target, context, and handoff id so the ordinary claim/rejoin path
 * performs the next attempt. A response-loss replay rejoins an already-ready
 * or currently leased retry instead of creating another obligation.
 *
 * A Run whose frozen handoff facts are themselves invalid is refused rather
 * than moved: the claim path uses the same classifier and would immediately
 * re-block it, so offering that retry would only churn revisions and tell the
 * user something untrue about their options. Nothing here repairs the frozen
 * bytes; recovery exists only for blocks an external change can actually fix.
 */
export async function retryBlockedAutomationReplyHandoff(params: Readonly<{
    accountId: string;
    runId: string;
    now?: Date;
}>): Promise<AutomationRunItem | null> {
    const now = params.now ?? new Date();
    if (!isValidDate(now)) return null;

    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId, "content");
        if (accountFence.status !== "ready") return null;
        const current = await tx.automationRun.findFirst({
            where: {
                id: params.runId,
                accountId: params.accountId,
                state: "succeeded",
                causeKind: "conversation",
                replyHandoffState: { in: ["blocked", "ready", "handingOff"] },
            },
            select: automationReplyHandoffCandidateSelect,
        });
        if (!current) return null;
        const candidate = current as AutomationReplyHandoffCandidate;
        if (candidate.replyHandoffState !== "blocked") {
            return await fetchAutomationRunItemTx(tx, candidate.id);
        }
        const currentness = deriveAutomationAccountCurrentnessWitness(candidate.account);
        if (!currentness) return null;
        if (classifyAutomationReplyHandoffDispatchability({
            facts: candidate,
            mode: currentness.mode,
        }) !== "dispatchable") {
            return null;
        }

        const retried = await tx.automationRun.updateMany({
            where: handoffCandidateWhere(candidate),
            data: {
                replyHandoffState: "ready",
                replyHandoffDueAt: now,
                revision: { increment: 1 },
                updatedAt: now,
            },
        });
        if (retried.count !== 1) return null;

        const run = await fetchAutomationRunItemTx(tx, candidate.id);
        if (!run) return null;
        await publishAutomationRunMutationTx(tx, run);
        return run;
    }, { transactionClass: "automation-reply-handoff-retry" });
}

/**
 * The present user's conscious decision to deliver this result again after the
 * previous delivery's external outcome stayed ambiguous.
 *
 * It is deliberately not a retry. A retry reuses the frozen handoff identity so
 * Channels rejoins the exact custody it already accepted and produces no second
 * effect — which is what the user wants when the outcome is merely unconfirmed,
 * and exactly what they do not want when they have decided the message never
 * arrived. So this mints the Run's next distinct delivery identity instead, and
 * changes nothing about the previous one: the ambiguous custody row stays with
 * its own evidence in Channels, and the attempt count that produced it is kept
 * rather than reset.
 *
 * Only `accepted` custody can reach here, because that is the one state in
 * which an external effect may have occurred without a truthful outcome. The
 * exact revision the user acted on is required, so a replayed authorization —
 * a lost response, a double press — loses its compare-and-swap and mints
 * nothing. Frozen handoff facts that can never be dispatched are refused for
 * the same reason the blocked retry refuses them.
 */
export async function authorizeAutomationReplyHandoffRedelivery(params: Readonly<{
    accountId: string;
    runId: string;
    expectedRevision: number;
    now?: Date;
}>): Promise<AutomationRunItem | null> {
    const now = params.now ?? new Date();
    if (!isValidDate(now)) return null;
    if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) return null;

    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId, "content");
        if (accountFence.status !== "ready") return null;
        const current = await tx.automationRun.findFirst({
            where: {
                id: params.runId,
                accountId: params.accountId,
                state: "succeeded",
                causeKind: "conversation",
                replyHandoffState: "accepted",
                revision: params.expectedRevision,
            },
            select: automationReplyHandoffCandidateSelect,
        });
        if (!current) return null;
        const candidate = current as AutomationReplyHandoffCandidate;
        if (!isDispatchableCandidate(candidate)) return null;
        const nextHandoffId = nextAutomationReplyHandoffIdForRunV1({
            runId: candidate.id,
            handoffId: candidate.replyHandoffId,
        });
        if (nextHandoffId === null) return null;

        const authorized = await tx.automationRun.updateMany({
            where: handoffCandidateWhere(candidate),
            data: {
                replyHandoffId: nextHandoffId,
                replyHandoffState: "ready",
                replyHandoffDueAt: now,
                revision: { increment: 1 },
                updatedAt: now,
            },
        });
        if (authorized.count !== 1) return null;

        const run = await fetchAutomationRunItemTx(tx, candidate.id);
        if (!run) return null;
        await publishAutomationRunMutationTx(tx, run);
        return run;
    }, { transactionClass: "automation-reply-handoff-redelivery-authorize" });
}

function isTerminalSettlement(
    outcome: AutomationReplyHandoffSettlementV1,
): outcome is Exclude<
    AutomationReplyHandoffSettlementV1,
    { kind: "retry" } | { kind: "staleClaim" }
> {
    return outcome.kind !== "retry" && outcome.kind !== "staleClaim";
}

async function returnStaleClaimToReadyTx(params: Readonly<{
    tx: Tx;
    candidate: AutomationReplyHandoffCandidate;
    claim: AutomationReplyHandoffClaim;
    now: Date;
}>): Promise<Readonly<{ applied: boolean }>> {
    const requeued = await params.tx.automationRun.updateMany({
        where: {
            id: params.candidate.id,
            accountId: params.candidate.accountId,
            automationId: params.candidate.automationId,
            state: "succeeded",
            causeKind: "conversation",
            replyHandoffId: params.claim.handoffId,
            replyHandoffAttempt: params.claim.attempt,
            replyHandoffState: "handingOff",
            // Fence only the current row version. Do not write any frozen
            // payload/target columns back over an Account-transition rewrite.
            revision: params.candidate.revision,
        },
        data: {
            replyHandoffState: "ready",
            replyHandoffDueAt: params.now,
            revision: { increment: 1 },
            updatedAt: params.now,
        },
    });
    if (requeued.count !== 1) return { applied: false };

    const run = await fetchAutomationRunItemTx(params.tx, params.candidate.id);
    if (!run) return { applied: false };
    await publishAutomationRunMutationTx(params.tx, run);
    return { applied: true };
}

async function requeueClaimIfCurrentAuthorityMovedTx(params: Readonly<{
    tx: Tx;
    candidate: AutomationReplyHandoffCandidate;
    claim: AutomationReplyHandoffClaim;
    now: Date;
}>): Promise<Readonly<{ applied: boolean }>> {
    if (
        params.candidate.replyHandoffState !== "handingOff"
        || params.candidate.replyHandoffAttempt !== params.claim.attempt
    ) {
        return { applied: false };
    }
    if (isClaimCurrent(params.candidate, params.claim)) return { applied: false };

    return await returnStaleClaimToReadyTx(params);
}

async function rereadAndRequeueStaleClaimTx(params: Readonly<{
    tx: Tx;
    claim: AutomationReplyHandoffClaim;
    now: Date;
}>): Promise<Readonly<{ applied: boolean }>> {
    const reread = await params.tx.automationRun.findFirst({
        where: {
            id: params.claim.runId,
            replyHandoffId: params.claim.handoffId,
        },
        select: automationReplyHandoffCandidateSelect,
    });
    if (!reread) return { applied: false };

    return await requeueClaimIfCurrentAuthorityMovedTx({
        ...params,
        candidate: reread as AutomationReplyHandoffCandidate,
    });
}

/**
 * Fences settlement by the claim-time Account witness and Run revision. A
 * response for transformed/rekeyed bytes is returned to the one durable
 * `ready` handoff instead of terminally classifying current content as bad.
 */
export async function settleAutomationReplyHandoff(params: Readonly<{
    claim: AutomationReplyHandoffClaim;
    now: Date;
    outcome: unknown;
    accountCurrentness?: unknown;
}>): Promise<Readonly<{ applied: boolean }>> {
    if (!isValidDate(params.now)) return { applied: false };
    const outcome = AutomationReplyHandoffSettlementV1Schema.safeParse(
        normalizeAutomationReplyHandoffRetryOutcome(params.outcome),
    );
    if (!outcome.success) return { applied: false };
    const suppliedCurrentness = params.accountCurrentness === undefined
        ? undefined
        : AutomationAccountCurrentnessWitnessV1Schema.safeParse(params.accountCurrentness);
    if (suppliedCurrentness && !suppliedCurrentness.success) return { applied: false };
    // A settled custody report must name the content identity it consumed.
    const settledExternalCustody = outcome.data.kind === "accepted"
        || outcome.data.kind === "suppressed";
    if (settledExternalCustody && suppliedCurrentness === undefined) {
        return { applied: false };
    }

    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.claim.accountId, "content");
        if (accountFence.status !== "ready") return { applied: false };
        const current = await tx.automationRun.findFirst({
            where: {
                id: params.claim.runId,
                replyHandoffId: params.claim.handoffId,
            },
            select: automationReplyHandoffCandidateSelect,
        });
        if (!current) return { applied: false };

        const candidate = current as AutomationReplyHandoffCandidate;
        if (
            candidate.replyHandoffState !== "handingOff"
            || candidate.replyHandoffAttempt !== params.claim.attempt
        ) {
            return { applied: false };
        }
        const suppliedWitness = suppliedCurrentness?.success
            ? suppliedCurrentness.data
            : undefined;
        if (!isClaimCurrent(candidate, params.claim)) {
            return await returnStaleClaimToReadyTx({
                tx,
                candidate,
                claim: params.claim,
                now: params.now,
            });
        }
        const currentness = deriveAutomationAccountCurrentnessWitness(candidate.account);
        if (!currentness) return { applied: false };
        if (outcome.data.kind === "staleClaim") {
            // The daemon may only make this claim when its fresh witness or
            // the server's later reread proves it. A fabricated stale result
            // cannot reopen an otherwise current lease.
            return { applied: false };
        }
        if (
            suppliedWitness !== undefined
            && !sameAutomationAccountContentIdentityV1(suppliedWitness, currentness)
        ) {
            return { applied: false };
        }

        let data: Prisma.AutomationRunUpdateManyMutationInput;
        if (isTerminalSettlement(outcome.data)) {
            data = {
                replyHandoffState: outcome.data.kind,
                replyHandoffDueAt: null,
                updatedAt: params.now,
            };
        } else {
            data = {
                replyHandoffState: "ready",
                // The strict external settlement schema owns positive hints.
                // Without one, this exact lease expiry is already persisted;
                // it is a recovery boundary, not a new cooldown or active lease.
                replyHandoffDueAt: outcome.data.retryAfterMs > 0
                    ? new Date(params.now.getTime() + outcome.data.retryAfterMs)
                    : candidate.replyHandoffDueAt,
                updatedAt: params.now,
            };
        }
        const updated = await tx.automationRun.updateMany({
            where: {
                id: candidate.id,
                accountId: candidate.accountId,
                automationId: candidate.automationId,
                state: "succeeded",
                causeKind: "conversation",
                replyHandoffId: params.claim.handoffId,
                replyHandoffAttempt: params.claim.attempt,
                replyHandoffState: "handingOff",
                revision: candidate.revision,
                account: { is: { seq: candidate.account.seq } },
            },
            data: { ...data, revision: { increment: 1 } },
        });
        if (updated.count !== 1) {
            // An Account/Run transition can commit after the initial reread
            // and before this CAS. Re-read once so its newer bytes rejoin the
            // same durable handoff rather than waiting on a stale lease.
            return await rereadAndRequeueStaleClaimTx({
                tx,
                claim: params.claim,
                now: params.now,
            });
        }

        const run = await fetchAutomationRunItemTx(tx, candidate.id);
        if (!run) return { applied: false };
        await publishAutomationRunMutationTx(tx, run);
        return { applied: true };
    }, { transactionClass: "automation-reply-handoff-settle" });
}
