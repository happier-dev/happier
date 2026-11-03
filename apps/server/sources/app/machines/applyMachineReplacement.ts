import { acquireAccountChangePublicationLocksInTx, beforeAccountChangePublication, markAccountChanged } from "@/app/changes/markAccountChanged";
import { buildUpdateMachineUpdate, eventRouter } from "@/app/events/eventRouter";
import { activityCache } from "@/app/presence/sessionCache";
import { afterTx, TransactionReplayRequiredError } from "@/storage/inTx";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import type { Tx } from "@/storage/inTx";
import type { MachineReplacementSource } from "./validateMachineReplacement";
import { validateMachineReplacementTarget } from "./validateMachineReplacement";
import { readMachineAccessKeySessionBindingsInTx } from "@/app/accessKeys/sessionMachineAccessKeyMutations";
import { catchUpAutomationRunLifecycleSourcesForRestoredMachineTx } from "@/app/automations/automationRunLifecycleAdmission";
import { acquireWorkflowPublicationLocksInTx } from "@/app/workflows/acquireWorkflowPublicationLocksInTx";
import { readMachineDevcontainerChildInTx } from './managed/managedRows';
import { resolveMachineAccessInTx } from './machineAccess';

export type ApplyMachineReplacementParams = Readonly<{
    tx: Tx;
    accountId: string;
    oldMachineId: string;
    replacementMachineId: string;
    reason: string;
    source: MachineReplacementSource;
    actorUserId: string | null;
    confirmActiveOldMachine?: boolean;
    replacedAt?: Date;
}>;

export class MachineReplacementWriteConflictError extends Error {
    readonly statusCode = 409;
    readonly reason = "old_machine_replacement_conflict";

    constructor() {
        super("old_machine_replacement_conflict");
    }
}

export async function applyMachineReplacement(params: ApplyMachineReplacementParams): Promise<void> {
    await acquireAccountChangePublicationLocksInTx(params.tx, [params.accountId], { includeSingleAccount: true });
    const previous = await params.tx.machine.findUnique({ where: { id: params.oldMachineId }, select: { replacedByMachineId: true } });
    beforeAccountChangePublication(params.tx, [params.accountId], async tx => {
        const [oldMachine, replacementMachine] = await Promise.all([
            tx.machine.findUnique({ where: { id: params.oldMachineId } }),
            tx.machine.findUnique({ where: { id: params.replacementMachineId } }),
        ]);
        // Reciprocal replacements write distinct Machine rows but publish the
        // same custodian Account. Recheck after that existing terminal lock,
        // when the winning replacement/revocation is visible at ReadCommitted.
        if (!oldMachine || !replacementMachine || oldMachine.accountId !== params.accountId
            || replacementMachine.accountId !== params.accountId
            || (previous?.replacedByMachineId !== params.replacementMachineId
                && !validateMachineReplacementTarget({ oldMachine, replacementMachine }).ok)) {
            throw new TransactionReplayRequiredError('transaction-account-audience-changed');
        }
    });
    const replacedAt = params.replacedAt ?? new Date();
    const invalidatedSessionBindings = await readMachineAccessKeySessionBindingsInTx(params.tx, {
        accountId: params.accountId,
        machineId: params.oldMachineId,
    });
    const replacementData = {
        active: false,
        replacedByMachineId: params.replacementMachineId,
        replacedAt,
        replacementReason: params.reason,
        replacementSource: params.source,
        replacementActorUserId: params.actorUserId,
    };

    // Replacement is reversible machine-availability metadata, not permanent
    // revocation. Preserve Automation definition assignments and immutable Run
    // snapshots so clearing replacement naturally makes the old machine
    // eligible again. The canonical machine-availability owner keeps a
    // replaced machine out of new admission and claim while this marker is
    // present; permanent revoke remains the sole destructive Automation
    // assignment cleanup and stranded-Run settlement boundary.
    if (params.source === "automatic") {
        const update = await params.tx.machine.updateMany({
            where: {
                accountId: params.accountId,
                id: params.oldMachineId,
                OR: [
                    { replacedByMachineId: null },
                    { replacedByMachineId: params.replacementMachineId },
                ],
            },
            data: replacementData,
        });
        if (update.count === 0) {
            const current = await params.tx.machine.findFirst({
                where: { accountId: params.accountId, id: params.oldMachineId },
                select: { replacedByMachineId: true },
            });
            if (current?.replacedByMachineId !== params.replacementMachineId) {
                throw new MachineReplacementWriteConflictError();
            }
        }
    } else {
        const updated = await params.tx.machine.updateMany({
            where: { accountId: params.accountId, id: params.oldMachineId,
                ...(params.confirmActiveOldMachine === true ? {} : { active: false }) },
            data: replacementData,
        });
        if (updated.count !== 1) throw new TransactionReplayRequiredError('transaction-account-audience-changed');
    }

    const cursor = await markAccountChanged(params.tx, {
        accountId: params.accountId,
        kind: "machine",
        entityId: params.oldMachineId,
    });

    afterTx(params.tx, () => {
        activityCache.invalidateMachine(params.oldMachineId);
        eventRouter.disconnectMachineAndSessionSockets({
            accountId: params.accountId,
            machineId: params.oldMachineId,
            sessionBindings: invalidatedSessionBindings,
        });
        eventRouter.emitUpdate({
            userId: params.accountId,
            payload: buildUpdateMachineUpdate(
                params.oldMachineId,
                cursor.resolveCursor(),
                randomKeyNaked(12),
                undefined,
                undefined,
                {
                    active: false,
                    devcontainerChild: null,
                    replacedByMachineId: params.replacementMachineId,
                    replacedAt: replacedAt.getTime(),
                    replacementReason: params.reason,
                    replacementSource: params.source,
                    replacementActorUserId: params.actorUserId,
                },
            ),
            recipientFilter: { type: "user-scoped-only" },
        });
    });
}

export async function clearMachineReplacement(params: Readonly<{
    tx: Tx;
    accountId: string;
    oldMachineId: string;
}>): Promise<void> {
    await acquireWorkflowPublicationLocksInTx(params.tx, {
        accountId: params.accountId,
        automationWhere: { accountId: params.accountId, enabled: true, deletedAt: null,
            assignments: { some: { machineId: params.oldMachineId, enabled: true } } },
        runSourceTriggerWhere: { enabled: true, remainingOccurrences: 1, automation: { accountId: params.accountId,
            enabled: true, deletedAt: null, assignments: { some: { machineId: params.oldMachineId, enabled: true } } } },
    });
    await params.tx.machine.update({
        where: { accountId_id: { accountId: params.accountId, id: params.oldMachineId } },
        data: {
            replacedByMachineId: null,
            replacedAt: null,
            replacementReason: null,
            replacementSource: null,
            replacementActorUserId: null,
        },
    });

    await catchUpAutomationRunLifecycleSourcesForRestoredMachineTx(params.tx, params.accountId, params.oldMachineId);
    const child = await readMachineDevcontainerChildInTx(params.tx, params.oldMachineId);
    const access = await resolveMachineAccessInTx(params.tx, { actorAccountId: params.accountId, machineId: params.oldMachineId });
    const devcontainerChild = access?.accessState === 'ready' ? child : null;

    const cursor = await markAccountChanged(params.tx, {
        accountId: params.accountId,
        kind: "machine",
        entityId: params.oldMachineId,
    });

    afterTx(params.tx, () => {
        activityCache.invalidateMachine(params.oldMachineId);
        eventRouter.emitUpdate({
            userId: params.accountId,
            payload: buildUpdateMachineUpdate(
                params.oldMachineId,
                cursor.resolveCursor(),
                randomKeyNaked(12),
                undefined,
                undefined,
                {
                    replacedByMachineId: null,
                    devcontainerChild,
                    replacedAt: null,
                    replacementReason: null,
                    replacementSource: null,
                    replacementActorUserId: null,
                },
            ),
            recipientFilter: { type: "user-scoped-only" },
        });
    });
}
