import { inTx } from "@/storage/inTx";

export type ReconciledSessionPendingQueueState = Readonly<{
    pendingCount: number;
    pendingVersion: number;
    didRepair: boolean;
}>;

type PendingStateInput = Readonly<{
    sessionId: string;
    pendingCount: number;
    pendingVersion: number;
}>;

export async function reconcileSessionPendingQueueState(
    params: PendingStateInput,
): Promise<ReconciledSessionPendingQueueState> {
    return await inTx(async (tx) => {
        const queuedCount = await tx.sessionPendingMessage.count({
            where: { sessionId: params.sessionId, status: "queued" },
        });

        const current = await tx.session.findUniqueOrThrow({
            where: { id: params.sessionId },
            select: { pendingCount: true, pendingVersion: true },
        });

        if (queuedCount === current.pendingCount) {
            return {
                pendingCount: current.pendingCount,
                pendingVersion: current.pendingVersion,
                didRepair: false,
            };
        }

        const repair = await tx.session.updateMany({
            where: {
                id: params.sessionId,
                pendingCount: current.pendingCount,
                pendingVersion: current.pendingVersion,
            },
            data: { pendingCount: queuedCount, pendingVersion: { increment: 1 } },
        });

        if (repair.count <= 0) {
            const latest = await tx.session.findUniqueOrThrow({
                where: { id: params.sessionId },
                select: { pendingCount: true, pendingVersion: true },
            });

            return {
                pendingCount: latest.pendingCount,
                pendingVersion: latest.pendingVersion,
                didRepair: false,
            };
        }

        const repaired = await tx.session.findUniqueOrThrow({
            where: { id: params.sessionId },
            select: { pendingCount: true, pendingVersion: true },
        });

        return {
            pendingCount: repaired.pendingCount,
            pendingVersion: repaired.pendingVersion,
            didRepair: true,
        };
    });
}
