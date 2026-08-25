import {
    AutomationAccountCurrentnessWitnessV1Schema,
    AutomationReplyHandoffSettlementV1Schema,
    AutomationReplyHandoffTargetV1Schema,
    AutomationStoredContentEnvelopeV1Schema,
    sameAutomationAccountCurrentnessWitnessV1,
    validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1,
    type AutomationAccountCurrentnessWitnessV1,
    type AutomationReplyHandoffSettlementV1,
} from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import {
    acquireAccountEncryptionTransitionFenceInTx,
} from "@/app/encryption/accountEncryptionTransition";
import { afterTx, inTx, type Tx } from "@/storage/inTx";

import { resolveClaimLeaseExpiresAt } from "./automationClaimService";
import { emitAutomationRunUpdated } from "./automationChangePublisher";
import {
    automationAccountCurrentnessSelect,
    deriveAutomationAccountCurrentnessWitness,
    fetchAutomationAccountCurrentnessWitnessTx,
} from "./automationAccountCurrentness";
import { automationRunItemSelect } from "./automationPersistenceSelect";
import type { AutomationRunItem } from "./automationTypes";

export const DEFAULT_AUTOMATION_REPLY_HANDOFF_LEASE_DURATION_MS = 30_000;
/**
 * Durable retry cadence when a retrying daemon or Action does not supply a
 * positive timing hint. The Protocol schema remains the upper-bound owner for
 * supplied hints.
 */
export const DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS = 10_000;

export type AutomationReplyHandoffClaim = Readonly<{
    accountId: string;
    automationId: string;
    runId: string;
    handoffId: string;
    occurrenceKey: string;
    attempt: number;
    /** The exact Account material authority under which these bytes were claimed. */
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    /** Run-row revision after the durable `ready -> handingOff` claim. */
    runRevision: number;
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
    id: true,
    accountId: true,
    automationId: true,
    occurrenceKey: true,
    state: true,
    originKind: true,
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
    return isRetryOutcomeWithoutHint(value)
        ? { kind: "retry", retryAfterMs: DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS }
        : value;
}

function resolveAutomationReplyHandoffRetryAfterMs(retryAfterMs: number): number {
    return retryAfterMs === 0
        ? DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS
        : retryAfterMs;
}

function parseJson(raw: string | null): unknown | undefined {
    if (typeof raw !== "string") return undefined;
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}

function handoffCandidateWhere(candidate: AutomationReplyHandoffCandidate): Prisma.AutomationRunWhereInput {
    return {
        id: candidate.id,
        accountId: candidate.accountId,
        automationId: candidate.automationId,
        occurrenceKey: candidate.occurrenceKey,
        state: "succeeded",
        originKind: "conversation",
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
        && sameAutomationAccountCurrentnessWitnessV1(claim.accountCurrentness, currentness)
        && hasClaimedFrozenIdentity(candidate, claim);
}

function isDispatchableCandidate(candidate: AutomationReplyHandoffCandidate): boolean {
    const currentness = deriveAutomationAccountCurrentnessWitness(candidate.account);
    if (!currentness || typeof candidate.occurrenceKey !== "string") return false;

    const target = AutomationReplyHandoffTargetV1Schema.safeParse({
        accountId: candidate.accountId,
        machineId: candidate.replyHandoffTargetMachineId,
        machineInstallationId: candidate.replyHandoffTargetMachineInstallationId,
        materializationId: candidate.replyHandoffTargetMaterializationId,
        actionRef: {
            pluginId: candidate.replyHandoffActionPluginId,
            localId: candidate.replyHandoffActionLocalId,
        },
    });
    if (!target.success || typeof candidate.replyHandoffId !== "string") return false;

    const result = validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1({
        content: "result",
        mode: currentness.mode,
        envelope: parseJson(candidate.resultEnvelope),
    });
    if (result.kind !== "available") return false;

    const replyContext = validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1({
        content: "replyContext",
        mode: currentness.mode,
        envelope: parseJson(candidate.replyContextEnvelope),
    });
    return replyContext.kind === "available";
}

function dueReplyHandoffWhere(now: Date): Prisma.AutomationRunWhereInput {
    return {
        state: "succeeded",
        originKind: "conversation",
        OR: [
            { replyHandoffState: "ready", replyHandoffDueAt: { lte: now } },
            { replyHandoffState: "handingOff", replyHandoffDueAt: { lt: now } },
        ],
    };
}

function openReplyHandoffWhere(): Prisma.AutomationRunWhereInput {
    return {
        state: "succeeded",
        originKind: "conversation",
        replyHandoffState: { in: ["ready", "handingOff"] },
        replyHandoffDueAt: { not: null },
    };
}

async function findReplyHandoffDiscoveryPageTx(params: Readonly<{
    tx: Tx;
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
    const candidates = await params.tx.automationRun.findMany({
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
async function findFirstReadReadyAccountHandoffDiscoveryTx(params: Readonly<{
    tx: Tx;
    where: Prisma.AutomationRunWhereInput;
}>): Promise<AutomationReplyHandoffDiscoveryCandidate | null> {
    let after: Readonly<{ dueAt: Date; createdAt: Date; id: string }> | undefined;
    while (true) {
        const candidates = await findReplyHandoffDiscoveryPageTx({ ...params, after });
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
        emitAutomationRunUpdated({ accountId: run.accountId, run, cursor });
    });
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
            replyHandoffReceiptEnvelope: null,
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
}>): Promise<AutomationReplyHandoffClaim | null> {
    if (!isValidDate(params.now)) return null;

    return await inTx(async (tx) => {
        const initialCandidate = await findFirstReadReadyAccountHandoffDiscoveryTx({
            tx,
            where: dueReplyHandoffWhere(params.now),
        });
        if (!initialCandidate) return null;

        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, initialCandidate.accountId);
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
        // Publishing the claimed Run advances Account.seq for the account
        // change cursor. Return the post-publication witness—the value a
        // daemon will read from the canonical currentness endpoint—not the
        // pre-claim sequence that this transaction intentionally advanced.
        const accountCurrentness = await fetchAutomationAccountCurrentnessWitnessTx(
            tx,
            candidate.accountId,
        );
        if (!accountCurrentness) return null;
        return {
            accountId: candidate.accountId,
            automationId: candidate.automationId,
            runId: candidate.id,
            handoffId: candidate.replyHandoffId,
            occurrenceKey: candidate.occurrenceKey,
            attempt: candidate.replyHandoffAttempt + 1,
            accountCurrentness,
            runRevision: candidate.revision + 1,
            resultEnvelope: candidate.resultEnvelope,
            replyContextEnvelope: candidate.replyContextEnvelope,
            target: {
                actionPluginId: candidate.replyHandoffActionPluginId,
                actionLocalId: candidate.replyHandoffActionLocalId,
                machineId: candidate.replyHandoffTargetMachineId,
                machineInstallationId: candidate.replyHandoffTargetMachineInstallationId,
                materializationId: candidate.replyHandoffTargetMaterializationId,
            },
        };
    });
}

/** Returns the next durable wake, including recovery of an expired handoff lease. */
export async function findNextAutomationReplyHandoffDueAt(_params: Readonly<{
    now: Date;
}>): Promise<Date | null> {
    return await inTx(async (tx) => {
        const next = await findFirstReadReadyAccountHandoffDiscoveryTx({
            tx,
            where: openReplyHandoffWhere(),
        });
        return next?.replyHandoffDueAt ?? null;
    });
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
            originKind: "conversation",
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
            replyHandoffReceiptEnvelope: null,
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
    receiptEnvelope?: unknown;
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
    const receipt = params.receiptEnvelope === undefined
        ? undefined
        : AutomationStoredContentEnvelopeV1Schema.safeParse(params.receiptEnvelope);
    if (receipt && !receipt.success) return { applied: false };
    if (
        (outcome.data.kind === "accepted" || outcome.data.kind === "suppressed")
        && (suppliedCurrentness === undefined || receipt === undefined)
    ) {
        return { applied: false };
    }
    if (receipt !== undefined && suppliedCurrentness === undefined) return { applied: false };

    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.claim.accountId);
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
            suppliedCurrentness !== undefined
            && (
                !suppliedCurrentness.success
                || !currentness
                || !sameAutomationAccountCurrentnessWitnessV1(suppliedCurrentness.data, currentness)
            )
        ) {
            return { applied: false };
        }
        if (receipt?.success) {
            if (!currentness || !suppliedCurrentness?.success) return { applied: false };
            const outer = validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1({
                content: "receipt",
                mode: currentness.mode,
                envelope: receipt.data,
            });
            if (outer.kind !== "available") return { applied: false };
        }

        let data: Prisma.AutomationRunUpdateManyMutationInput;
        if (isTerminalSettlement(outcome.data)) {
            data = {
                replyHandoffState: outcome.data.kind,
                replyHandoffDueAt: null,
                replyHandoffReceiptEnvelope: receipt?.success
                    ? JSON.stringify(receipt.data)
                    : null,
                updatedAt: params.now,
            };
        } else {
            data = {
                replyHandoffState: "ready",
                replyHandoffDueAt: new Date(
                    params.now.getTime() + resolveAutomationReplyHandoffRetryAfterMs(outcome.data.retryAfterMs),
                ),
                replyHandoffReceiptEnvelope: null,
                updatedAt: params.now,
            };
        }
        const updated = await tx.automationRun.updateMany({
            where: {
                id: candidate.id,
                accountId: candidate.accountId,
                automationId: candidate.automationId,
                state: "succeeded",
                originKind: "conversation",
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
    });
}
