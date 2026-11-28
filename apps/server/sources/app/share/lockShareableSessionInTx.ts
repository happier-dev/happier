import type { Tx } from '@/storage/inTx';

export async function lockShareableSessionInTx(tx: Tx, sessionId: string) {
    const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { cloudCopyLeftAt: true, encryptionMode: true, updatedAt: true },
    });
    if (!session || session.cloudCopyLeftAt !== null) return null;
    // Share creation and cloud copy removal serialize on the same Session row.
    const claim = await tx.session.updateMany({
        where: { id: sessionId, cloudCopyLeftAt: null, updatedAt: session.updatedAt },
        data: { updatedAt: session.updatedAt },
    });
    return claim.count === 1 ? session : null;
}
