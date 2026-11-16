import type { Tx } from "@/storage/inTx";
import { TransactionReplayRequiredError } from "@/storage/inTx";
import { assertAccountChangePublicationAudienceInTx, beforeAccountChangePublication } from "@/app/changes/markAccountChanged";

import {
    emitAutomationAssignmentMutationAfterTx,
    ensureAutomationEventCatalogStateTx,
    loadAutomationTx,
    markAutomationChangedTx,
} from "./automationCrudService";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { acquireWorkflowPublicationLocksInTx } from "@/app/workflows/acquireWorkflowPublicationLocksInTx";
import { getWorkflowPublicationAudienceInTx, type WorkflowPublicationScope, type WorkflowPublicationAudience } from "@/app/workflows/workflowPublicationAudience";
import type { AccountEncryptionInconsistencyReason } from "@/app/encryption/accountContentKeyAdmission";
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { cancelWorkflowRunTx, WorkflowRunServiceError } from "@/app/workflows/workflowRunService";
import { portableQueryChunks as automationPortableQueryChunks } from "@/storage/portableQueryChunks";
import { automationRunItemSelect } from "./automationPersistenceSelect";
import {
    AUTOMATION_RUN_TERMINAL_STATES,
} from "./automationTypes";
import { settleAutomationReplyHandoffsForRevokedMachineTx } from "./automationReplyHandoffService";

export type AutomationMachineAssignmentRemovalResult = Readonly<{
    /** Live definitions whose ordinary assignment was removed or derived controller became unavailable. */
    affectedAutomationIds: readonly string[];
    /** Enabled definitions that lost their last eligible assignment and were atomically disabled. */
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

async function machineAssignmentRemovalPublicationScope(tx: Tx,
    params: Readonly<{ accountId: string; machineId: string }>,
): Promise<Readonly<{ scope: WorkflowPublicationScope; contentAccountIds: readonly string[] }>> {
    // Exact assigned definitions and open Runs determine their real content-fence owners.
    const [definitions, runs] = await Promise.all([
        tx.automation.findMany({ where: { assignments: { some: { machineId: params.machineId } } },
            select: { id: true, accountId: true } }),
        tx.automationRun.findMany({ where: { assignments: { some: { machineId: params.machineId } },
            state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] } }, select: { id: true, accountId: true } }),
    ]);
    const contentAccountIds = [...new Set([params.accountId, ...definitions.map(row => row.accountId), ...runs.map(row => row.accountId)])].sort();
    return { contentAccountIds, scope: { accountId: params.accountId,
        automationIds: definitions.map(row => row.id), runIds: runs.map(row => row.id),
        machineTargets: contentAccountIds.map(accountId => ({ accountId, machineId: params.machineId })),
    } };
}

/** Enclosing deletion admits the same definition/stranded-Run effects as revocation. */
export async function readAutomationMachineAssignmentRemovalPublicationAudienceInTx(
    tx: Tx, params: Readonly<{ accountId: string; machineId: string }>,
): Promise<WorkflowPublicationAudience> {
    return getWorkflowPublicationAudienceInTx(tx, (await machineAssignmentRemovalPublicationScope(tx, params)).scope);
}

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
 * 1. remove ordinary AutomationAssignment rows; Environment-derived placement
 *    stays explicit until controller.set moves it, while its definition pauses. Frozen
 *    AutomationRunAssignment snapshots are never touched, rewritten, or
 *    transferred to another machine;
 * 2. when the enabled Automation has no remaining eligible enabled assignment, disable
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
 * The whole mutation fences each affected definition/Run Account before the
 * Machine write. When any fence is unavailable, the composition throws
 * `AutomationMachineAssignmentRemovalFenceUnavailableError` before any write,
 * so the caller's transaction rolls back atomically instead of committing a
 * half-transition that would permanently strand the settlement.
 */
export async function removeAutomationMachineAssignmentsTx(
    params: AutomationMachineAssignmentRemovalParams,
): Promise<AutomationMachineAssignmentRemovalResult> {
    const census = await machineAssignmentRemovalPublicationScope(params.tx, params);
    const publicationScope = census.scope;
    await acquireWorkflowPublicationLocksInTx(params.tx, publicationScope);
    const admittedRunIds = new Set((await getWorkflowPublicationAudienceInTx(params.tx, publicationScope)).runIds);
    beforeAccountChangePublication(params.tx, [params.accountId], async tx => {
        // A definition or Run may commit while this withdrawal's Machine write
        // is uncommitted. Publication orders their shared Account, so replay rather
        // than miss assignments or stranded Runs enumerated before that commit.
        const [remainingAssignments, current] = await Promise.all([
            tx.automationAssignment.count({ where: { machineId: params.machineId, automation: { OR: [
                { deploymentEnvironmentId: null }, { deploymentEnvironmentId: { not: null }, enabled: true, deletedAt: null },
            ] } } }),
            machineAssignmentRemovalPublicationScope(tx, params).then(current => getWorkflowPublicationAudienceInTx(tx, current.scope)),
        ]);
        assertAccountChangePublicationAudienceInTx(tx, current.accountIds);
        if (remainingAssignments > 0 || current.runIds.some(runId => !admittedRunIds.has(runId))) {
            throw new TransactionReplayRequiredError("automation-assignment-admission-changed");
        }
    });
    // The Account-first fence orders this composition with every other
    // Account-fenced Automation writer before any of its writes. It is taken
    // unconditionally — including when no current definition assignment
    // remains — because stranded-Run settlement below is independent of
    // definition-assignment presence and is not optional.
    const accountModes = new Map<string, "plain" | "e2ee">();
    for (const accountId of census.contentAccountIds) {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(params.tx, accountId, "content");
        if (accountFence.status !== "ready") {
            throw new AutomationMachineAssignmentRemovalFenceUnavailableError(
                accountFence.status === "account_not_found" ? "account_not_found" : accountFence.reason,
            );
        }
        accountModes.set(accountId, accountFence.account.currentness.encryptionMode);
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
            automation: { select: { accountId: true, deploymentEnvironmentId: true } },
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
            where: { machineId: params.machineId, automation: { deploymentEnvironmentId: null } },
        });
    }

    const affectedAutomationIds: string[] = [];
    const disabledAutomationIds: string[] = [];
    const now = new Date();
    for (const [automationId, removed] of removedRowsByAutomationId) {
        const automationAccountId = removed[0]?.automation.accountId;
        if (!automationAccountId) throw new Error('Machine assignment group has no Automation Account');
        const automation = await loadAutomationTx(params.tx, {
            accountId: automationAccountId,
            automationId,
        });
        // A soft-deleted Automation has no live definition to keep valid; its
        // delete owner already removed assignments and disabled its triggers.
        if (!automation) continue;
        affectedAutomationIds.push(automationId);

        const hasRemainingEnabledAssignment = automation.assignments.some(
            (assignment) => assignment.enabled && assignment.machineId !== params.machineId,
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
                    accountId: automationAccountId,
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
                        accountId: automationAccountId,
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
                    accountId: automationAccountId,
                    deletedAt: null,
                },
                data: { updatedAt: now },
            });
        }

        // Reload after the mutation so the post-commit publication carries the
        // committed definition state.
        const publishedAutomation = await loadAutomationTx(params.tx, {
            accountId: automationAccountId,
            automationId,
        });
        if (!publishedAutomation) continue;
        const cursor = await markAutomationChangedTx(params.tx, {
            accountId: automationAccountId, automationId,
            publication: { previous: automation, current: publishedAutomation },
        });
        emitAutomationAssignmentMutationAfterTx({
            tx: params.tx,
            accountId: automationAccountId,
            automation: publishedAutomation,
            cursor,
            previousAssignments: removed,
        });
    }

    for (const [accountId, accountEncryptionMode] of accountModes) {
        await settleRunsStrandedByDurableMachineLossTx({ tx: params.tx, accountId,
            machineId: params.machineId, accountEncryptionMode });
        await settleAutomationReplyHandoffsForRevokedMachineTx({ tx: params.tx, accountId,
            machineId: params.machineId, now });
    }

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
        where: { machineId: params.machineId,
            run: { accountId: params.accountId, state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] } } },
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
    // only at permanently revoked Machines. The Run keeps its own Account custody;
    // a Team-granted controller need not belong to that same Account.
    // Replacement is deliberately not enough: it is reversible, and undo can
    // make that exact frozen assignment usable again without rewriting it.
    // Missing rows are not proof of durable Machine loss and fail closed.
    // This physical-loss fact grants no claim or dispatch authority.
    const strandedRunIds = candidateRunIds.filter((runId) => {
        const runSnapshot = snapshotsByRunId.get(runId) ?? [];
        return runSnapshot.length > 0 && runSnapshot.every((row) => {
            const machine = machinesById.get(row.machineId);
            if (!machine) return false;
            return classifyMachineAvailabilityState(machine) === "revoked";
        });
    });
    if (strandedRunIds.length === 0) return;

    const strandedRuns = (await Promise.all(automationPortableQueryChunks({
        values: strandedRunIds,
        bindingsPerValue: 1,
        fixedBindings: 1 + AUTOMATION_RUN_TERMINAL_STATES.length,
    }).map((chunk) => params.tx.automationRun.findMany({
        where: {
            id: { in: [...chunk] },
            accountId: params.accountId,
            state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] },
        },
        select: automationRunItemSelect,
        orderBy: [{ id: "asc" }],
    })))).flat();
    if (strandedRuns.length === 0) return;

    for (const previousRun of strandedRuns) {
        try {
            await cancelWorkflowRunTx(params.tx, {
                accountId: params.accountId,
                runId: previousRun.id,
                expectedRevision: previousRun.revision,
                accountEncryptionMode: params.accountEncryptionMode,
                cause: "permanent_target_loss",
            });
        } catch (error) {
            if (error instanceof WorkflowRunServiceError && error.code === "currentness_conflict") continue;
            throw error;
        }
    }
}
