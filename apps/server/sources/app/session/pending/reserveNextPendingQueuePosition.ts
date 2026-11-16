import { isDeepStrictEqual } from "node:util";
import { inTx, TransactionReplayRequiredError, type ResolvedTransactionResult, type Tx } from "@/storage/inTx";
import { assertAccountChangePublicationAudienceInTx, beforeAccountChangePublication } from "@/app/changes/markAccountChanged";
import { acquireSessionAccountCursorLocksInTx, sessionAccountCursorLocksHoldSessionRows } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { readPendingActivationControllerAccountIdsInTx } from "./pendingActivationAuthorization";
import { readStoredCommittedSessionInputMachineTarget } from "@/app/session/messages/sessionInputAdmission";

/** The lock audience comes from stored placement alone: controllers grant no authority, so Machine admission is decided once, under the lock. */
async function readStoredPlacementMachineIdInTx(tx: Tx, sessionId: string): Promise<string | undefined> {
    const session = await tx.session.findUnique({ where: { id: sessionId },
        select: { accountId: true, archivedAt: true, runtimeMachineTarget: true } });
    return session ? readStoredCommittedSessionInputMachineTarget({ ...session, id: sessionId })?.machineId : undefined;
}

export async function inPendingQueuePositionTx<T>(
    sessionId: string,
    fn: (tx: Tx) => Promise<T>,
    targetMachineId?: string,
    readAdditionalPublicationAccountsInTx?: (tx: Tx) => Promise<readonly string[]>,
): Promise<ResolvedTransactionResult<T>> {
    return inTx(async (tx) => {
        const readAudience = async (client: Tx, machineId: string | undefined) => ({
            machineId,
            controllerAccountIds: await readPendingActivationControllerAccountIdsInTx(client, machineId),
            additionalAccountIds: await readAdditionalPublicationAccountsInTx?.(client) ?? [],
        });
        const audience = await readAudience(tx, targetMachineId ?? await readStoredPlacementMachineIdInTx(tx, sessionId));
        const audienceAccountIds = [...new Set([...audience.controllerAccountIds, ...audience.additionalAccountIds])];
        if (!sessionAccountCursorLocksHoldSessionRows()) {
            // A single-writer database serializes this whole transaction: the
            // audience read above cannot move before publication.
            beforeAccountChangePublication(tx, audienceAccountIds, async () => undefined);
            return fn(tx);
        }
        // Admit the complete Account audience, then serialize Pending work at
        // the canonical Session resource fence. Publication remains terminal.
        await acquireSessionAccountCursorLocksInTx(tx, [sessionId], [...audience.controllerAccountIds, ...audience.additionalAccountIds]);
        // A placement changed before the Session lock must replay before Session
        // locking can turn a new lower Account into an inversion against another
        // publisher's ordered acquisition. Under the lock placement cannot move.
        const locked = await readAudience(tx, targetMachineId ?? await readStoredPlacementMachineIdInTx(tx, sessionId));
        if (!isDeepStrictEqual(audience, locked)) {
            throw new TransactionReplayRequiredError("pending-activation-target-changed");
        }
        beforeAccountChangePublication(tx, audienceAccountIds, async client => {
            const current = await readAudience(client, locked.machineId);
            assertAccountChangePublicationAudienceInTx(client, [...current.controllerAccountIds, ...current.additionalAccountIds]);
        });
        return fn(tx);
    }, { transactionClass: "pending-input-admission" });
}

export async function reserveNextPendingQueuePosition(tx: Tx, sessionId: string): Promise<number> {
    const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { pendingQueueSeq: true },
    });

    const highestQueued = await tx.sessionPendingMessage.findFirst({
        where: { sessionId, status: "queued" },
        orderBy: [{ position: "desc" }, { createdAt: "desc" }, { localId: "desc" }],
        select: { position: true },
    });

    const normalizedPendingQueueSeq = Math.max(session?.pendingQueueSeq ?? 0, highestQueued?.position ?? 0);
    if ((session?.pendingQueueSeq ?? 0) !== normalizedPendingQueueSeq) {
        await tx.session.update({
            where: { id: sessionId },
            data: { pendingQueueSeq: normalizedPendingQueueSeq },
        });
    }

    const updated = await tx.session.update({
        where: { id: sessionId },
        data: { pendingQueueSeq: { increment: 1 } },
        select: { pendingQueueSeq: true },
    });

    return updated.pendingQueueSeq;
}
