import type { Tx } from "@/storage/inTx";

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
