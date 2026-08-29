import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { buildUpdateMachineUpdate, eventRouter } from "@/app/events/eventRouter";
import { activityCache } from "@/app/presence/sessionCache";
import { afterTx } from "@/storage/inTx";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import type { Tx } from "@/storage/inTx";
import type { MachineReplacementSource } from "./validateMachineReplacement";

export type ApplyMachineReplacementParams = Readonly<{
    tx: Tx;
    accountId: string;
    oldMachineId: string;
    replacementMachineId: string;
    reason: string;
    source: MachineReplacementSource;
    actorUserId: string | null;
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
    const replacedAt = params.replacedAt ?? new Date();
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
        await params.tx.machine.update({
            where: { accountId_id: { accountId: params.accountId, id: params.oldMachineId } },
            data: replacementData,
        });
    }

    const cursor = await markAccountChanged(params.tx, {
        accountId: params.accountId,
        kind: "machine",
        entityId: params.oldMachineId,
    });

    afterTx(params.tx, () => {
        activityCache.invalidateMachine(params.oldMachineId);
        for (const connection of eventRouter.getConnections(params.accountId) ?? []) {
            if (connection.connectionType === "machine-scoped" && connection.machineId === params.oldMachineId) {
                connection.socket.disconnect(true);
            }
        }
        eventRouter.emitUpdate({
            userId: params.accountId,
            payload: buildUpdateMachineUpdate(
                params.oldMachineId,
                cursor,
                randomKeyNaked(12),
                undefined,
                undefined,
                {
                    active: false,
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
                cursor,
                randomKeyNaked(12),
                undefined,
                undefined,
                {
                    replacedByMachineId: null,
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
