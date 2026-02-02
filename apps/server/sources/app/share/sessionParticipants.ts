import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";

export async function getSessionParticipantUserIds(params: {
    sessionId: string;
    tx?: Tx;
}): Promise<string[]> {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    if (!sessionId) return [];

    const client = params.tx ?? db;
    const session = await client.session.findUnique({
        where: { id: sessionId },
        select: {
            accountId: true,
            shares: {
                select: {
                    sharedWithUserId: true,
                },
            },
        },
    });

    if (!session) {
        return [];
    }

    const ids = new Set<string>();
    ids.add(session.accountId);
    for (const share of session.shares) {
        ids.add(share.sharedWithUserId);
    }
    return Array.from(ids);
}

