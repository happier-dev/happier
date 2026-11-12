import { db } from "@/storage/db";

/**
 * Records that the caller's client was seen now. Liveness only: a single upsert on the presence row,
 * with no account change entry, sequence bump or event, so other clients are not notified.
 * Idempotent apart from the timestamp.
 */
export async function connectedClientSeen(ctx: { readonly uid: string }, clientId: string, now: Date = new Date()): Promise<void> {
    await db.connectedClientPresence.upsert({
        where: { accountId_clientId: { accountId: ctx.uid, clientId } },
        create: { accountId: ctx.uid, clientId, lastSeenAt: now },
        update: { lastSeenAt: now },
    });
}
