import type { Tx } from "@/storage/inTx";

import {
    emitAutomationMutationAfterTx,
    ensureAutomationEventCatalogStateTx,
    loadAutomationTx,
    markAutomationChangedTx,
} from "./automationCrudService";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import type { AccountEncryptionInconsistencyReason } from "@/app/encryption/accountContentKeyAdmission";
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { automationPortableQueryChunks } from "./automationPortableQueryChunks";
import { automationRunItemSelect } from "./automationPersistenceSelect";
import {
    cancelAutomationRunRowTx,
    publishCancelledAutomationRunsTx,
    type CancelledAutomationRunTxResult,
} from "./automationRunService";
import type { AutomationRunItem } from "./automationTypes";

export type AutomationMachineAssignmentRemovalResult = Readonly<{
    /** Live Automations whose definition-level assignment rows for this machine were removed. */
    affectedAutomationIds: readonly string[];
    /** Affected enabled Automations that lost their last enabled assignment and were atomically disabled. */
    disabledAutomationIds: readonly string[];
}>;

export type AutomationMachineAssignmentRemovalParams = Readonly<{
    tx: Tx;
    accountId: string;
    machineId: string;
    /**
     * The canonical machine owner mutation that makes `machineId`
     * permanently unavailable. It runs under this composition's Account
     * fence and before any definition or Run mutation.
     */
    markMachineUnavailableTx: (tx: Tx) => Promise<void>;
}>;

/**
 * The Account encryption transition fence refused this mutation. The approved
 * stranded-Run settlement is not optional, so the composition fails the whole
 * caller mutation closed instead of committing the structural removal while
 * silently skipping settlement (no sweeper or retry owner would ever finish
 * it). The caller's transaction rolls back, including the durable machine
 * revocation marking, and may retry once the Account is consistent.
 */
export class AutomationMachineAssignmentRemovalFenceUnavailableError extends Error {
    readonly statusCode = 409;
    readonly reason: "account_not_found" | AccountEncryptionInconsistencyReason;

    constructor(reason: "account_not_found" | AccountEncryptionInconsistencyReason) {
        super("automation_machine_assignment_removal_account_fence_unavailable");
        this.name = "AutomationMachineAssignmentRemovalFenceUnavailableError";
        this.reason = reason;
    }
}

/**
 * The one Automation-owned machine-assignment removal composition. The
 * canonical machine revoke writer calls it inside its own transaction and
 * supplies its machine mutation to this owner. Reversible replacement does not
 * call this composition: it preserves definitions and Runs. Nothing else may
 * remove definition assignments for a permanently revoked machine. This owner
 * acquires the Account fence first, then invokes that mutation, then removes
 * definition assignments and settles stranded Runs.
 *
 * Removing a machine's definition assignments must keep every persisted
 * definition inside the assignment-liveness invariant the definition writers
 * enforce ("an enabled Automation requires at least one enabled execution
 * assignment"). Per affected Automation, in the caller's transaction:
 *
 * 1. remove the machine's AutomationAssignment rows; frozen
 *    AutomationRunAssignment snapshots are never touched, rewritten, or
 *    transferred to another machine;
 * 2. when the enabled Automation has no remaining enabled assignment, disable
 *    it atomically (exact `enabled: true` CAS), clear its schedule cursors,
 *    and advance the Event source-definition catalog revision when an enabled
 *    Event definition left the visible projection, so watchers re-adopt
 *    through their canonical read;
 * 3. mark the Account/Automation change and publish the definition upsert plus
 *    assignment-updated wakes only after commit through the canonical
 *    mutation publication seam.
 *
 * On this explicit durable machine-revoke flow only, a
 * nonterminal Run whose complete immutable AutomationRunAssignment snapshot
 * has no assignment to a machine that remains available
 * settles through the one canonical cancellation transition: queued/claimed
 * Runs cancel, running Runs settle outcome-uncertain. Any frozen eligible
 * assignment leaves its Run untouched, and temporary offline/socket absence
 * is not eligibility loss. The supplied durable writer runs under the fence
 * before settlement; an unmarked machine stays eligible and settles nothing.
 * The settlement is independent of the
 * definition-assignment removal above: it also settles Runs whose frozen
 * snapshot still names the machine after its definition assignments were
 * already removed or changed.
 *
 * The whole mutation is gated by the one Account encryption transition fence:
 * when the fence is unavailable, the composition throws
 * `AutomationMachineAssignmentRemovalFenceUnavailableError` before any write,
 * so the caller's transaction rolls back atomically instead of committing a
 * half-transition that would permanently strand the settlement.
 */
export async function removeAutomationMachineAssignmentsTx(
    params: AutomationMachineAssignmentRemovalParams,
): Promise<AutomationMachineAssignmentRemovalResult> {
    // The Account-first fence orders this composition with every other
    // Account-fenced Automation writer before any of its writes. It is taken
    // unconditionally — including when no current definition assignment
    // remains — because stranded-Run settlement below is independent of
    // definition-assignment presence and is not optional.
    const accountFence = await acquireAccountEncryptionTransitionFenceInTx(
        params.tx,
        params.accountId,
    );
    if (accountFence.status !== "ready") {
        throw new AutomationMachineAssignmentRemovalFenceUnavailableError(
            accountFence.status === "account_not_found"
                ? "account_not_found"
                : accountFence.reason,
        );
    }

    // The canonical machine writer is deliberately invoked here rather than
    // by the caller before this composition. That preserves the required lock
    // order (Account fence -> permanent machine mutation -> Automation
    // removal/settlement) through one fence owner. Any later failure rejects
    // the caller's enclosing transaction and rolls this mutation back too.
    await params.markMachineUnavailableTx(params.tx);

    const removedRows = await params.tx.automationAssignment.findMany({
        where: { machineId: params.machineId },
        select: {
            automationId: true,
            machineId: true,
            enabled: true,
            priority: true,
            updatedAt: true,
        },
    });

    const removedRowsByAutomationId = new Map<string, typeof removedRows>();
    for (const row of removedRows) {
        const group = removedRowsByAutomationId.get(row.automationId);
        if (group) group.push(row);
        else removedRowsByAutomationId.set(row.automationId, [row]);
    }

    if (removedRows.length > 0) {
        await params.tx.automationAssignment.deleteMany({
            where: { machineId: params.machineId },
        });
    }

    const affectedAutomationIds: string[] = [];
    const disabledAutomationIds: string[] = [];
    const now = new Date();
    for (const [automationId, removed] of removedRowsByAutomationId) {
        const automation = await loadAutomationTx(params.tx, {
            accountId: params.accountId,
            automationId,
        });
        // A soft-deleted Automation has no live definition to keep valid; its
        // delete owner already removed assignments and disabled its triggers.
        if (!automation) continue;
        affectedAutomationIds.push(automationId);

        const hasRemainingEnabledAssignment = automation.assignments.some(
            (assignment) => assignment.enabled,
        );
        let disabled = false;
        if (automation.enabled && !hasRemainingEnabledAssignment) {
            // Assignment-liveness: an enabled Automation cannot survive the
            // loss of its last enabled execution assignment. The exact CAS
            // makes concurrent definition writers pick one winner instead of
            // double-publishing the disable transition.
            const updated = await params.tx.automation.updateMany({
                where: {
                    id: automationId,
                    accountId: params.accountId,
                    enabled: true,
                    deletedAt: null,
                },
                data: { enabled: false, updatedAt: now },
            });
            disabled = updated.count === 1;
            if (disabled) {
                // Canonical disable composition: a disabled Automation owns no
                // due schedule cursor; re-enable re-seeds cursors through the
                // canonical cursor owner.
                await params.tx.automationTrigger.updateMany({
                    where: { automationId, kind: "schedule", deletedAt: null },
                    data: { nextRunAt: null },
                });
                if (automation.triggers.some((trigger) => (
                    trigger.kind === "pluginEvent" && trigger.enabled
                ))) {
                    // The enabled Event definition left the visible source
                    // projection, so watchers must re-adopt through the
                    // canonical catalog revision owner.
                    await ensureAutomationEventCatalogStateTx({
                        tx: params.tx,
                        accountId: params.accountId,
                        projectionChanged: true,
                    });
                }
                disabledAutomationIds.push(automationId);
            }
        }
        if (!disabled) {
            // The definition mutation is real even without an enablement flip;
            // keep updatedAt truthful for the published upsert payload.
            await params.tx.automation.updateMany({
                where: {
                    id: automationId,
                    accountId: params.accountId,
                    deletedAt: null,
                },
                data: { updatedAt: now },
            });
        }

        const cursor = await markAutomationChangedTx(params.tx, {
            accountId: params.accountId,
            automationId,
        });
        // Reload after the mutation so the post-commit publication carries the
        // committed definition state.
        const publishedAutomation = await loadAutomationTx(params.tx, {
            accountId: params.accountId,
            automationId,
        });
        if (!publishedAutomation) continue;
        emitAutomationMutationAfterTx({
            tx: params.tx,
            accountId: params.accountId,
            automation: publishedAutomation,
            cursor,
            previousAssignments: removed,
        });
    }

    await settleRunsStrandedByDurableMachineLossTx({
        tx: params.tx,
        accountId: params.accountId,
        machineId: params.machineId,
        accountEncryptionMode: accountFence.account.currentness.encryptionMode,
    });

    return { affectedAutomationIds, disabledAutomationIds };
}

/**
 * Settles the nonterminal Runs whose complete frozen assignment snapshot is
 * proven permanently revoked. The durable revoke writer has already run under
 * this composition's Account fence before this stage, so the removed machine
 * itself cannot keep a Run alive. A snapshot that still names an available or
 * reversibly replaced machine remains untouched: clearing replacement can make
 * that admitted authority usable again. Frozen snapshot rows are never
 * rewritten, transferred, or deleted — only the Run's own lifecycle settles.
 *
 * The affected set is expressed exactly through the existing indexed
 * relations: the machine index on `AutomationRunAssignment`, one batched
 * snapshot read for the candidate Runs, one batched machine read, and the
 * Run-state filter — chunked only at the portable provider bind seam. No
 * full-table scan, arbitrary batch limit, sweeper, or second transition
 * owner exists.
 */
async function settleRunsStrandedByDurableMachineLossTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    machineId: string;
    accountEncryptionMode: "plain" | "e2ee";
}>): Promise<void> {
    const strandedRefs = await params.tx.automationRunAssignment.findMany({
        where: { machineId: params.machineId },
        select: { runId: true },
    });
    if (strandedRefs.length === 0) return;

    const candidateRunIds = [...new Set(strandedRefs.map((ref) => ref.runId))];
    const snapshotRows = (await Promise.all(automationPortableQueryChunks({
        values: candidateRunIds,
        bindingsPerValue: 1,
    }).map((chunk) => params.tx.automationRunAssignment.findMany({
        where: { runId: { in: [...chunk] } },
        select: { runId: true, machineId: true },
    })))).flat();

    const machinesById = new Map(
        (await Promise.all(automationPortableQueryChunks({
            values: [...new Set(snapshotRows.map((row) => row.machineId))],
            bindingsPerValue: 1,
        }).map((chunk) => params.tx.machine.findMany({
            where: { id: { in: [...chunk] } },
            select: {
                id: true,
                accountId: true,
                revokedAt: true,
                replacedByMachineId: true,
            },
        })))).flat().map((machine) => [machine.id, machine] as const),
    );

    const snapshotsByRunId = new Map<string, typeof snapshotRows>();
    for (const row of snapshotRows) {
        const existing = snapshotsByRunId.get(row.runId);
        if (existing) {
            existing.push(row);
        } else {
            snapshotsByRunId.set(row.runId, [row]);
        }
    }

    // Settlement requires positive proof that the complete snapshot points
    // only at permanently revoked machines belonging to this Account.
    // Replacement is deliberately not enough: it is reversible, and undo can
    // make that exact frozen assignment usable again without rewriting it.
    // Missing rows and foreign-Account rows are neither eligible execution
    // authority nor evidence of durable local machine loss, so both
    // fail closed and leave the Run for an explicit repair owner.
    const strandedRunIds = candidateRunIds.filter((runId) => {
        const runSnapshot = snapshotsByRunId.get(runId) ?? [];
        return runSnapshot.length > 0 && runSnapshot.every((row) => {
            const machine = machinesById.get(row.machineId);
            if (!machine || machine.accountId !== params.accountId) return false;
            return classifyMachineAvailabilityState(machine) === "revoked";
        });
    });
    if (strandedRunIds.length === 0) return;

    const strandedRuns = (await Promise.all(automationPortableQueryChunks({
        values: strandedRunIds,
        bindingsPerValue: 1,
        fixedBindings: 5,
    }).map((chunk) => params.tx.automationRun.findMany({
        where: {
            id: { in: [...chunk] },
            accountId: params.accountId,
            state: { in: ["queued", "claimed", "running"] },
        },
        select: automationRunItemSelect,
        orderBy: [{ id: "asc" }],
    })))).flat();
    if (strandedRuns.length === 0) return;

    const results: CancelledAutomationRunTxResult[] = [];
    for (const previousRun of strandedRuns) {
        const result = await cancelAutomationRunRowTx({
            tx: params.tx,
            accountId: params.accountId,
            previousRun: previousRun as AutomationRunItem,
            accountEncryptionMode: params.accountEncryptionMode,
        });
        if (result) results.push(result);
    }
    if (results.length === 0) return;
    await publishCancelledAutomationRunsTx({
        tx: params.tx,
        accountId: params.accountId,
        results,
    });
}
