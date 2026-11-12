import { db } from "@/storage/db";

/** Lists when each of the caller's clients was last seen (one row per client the account has used). */
export async function connectedClientList(ctx: { readonly uid: string }): Promise<Array<{ clientId: string; lastSeenAt: number }>> {
    const rows = await db.connectedClientPresence.findMany({
        where: { accountId: ctx.uid },
        select: { clientId: true, lastSeenAt: true },
    });
    return rows.map((row) => ({ clientId: row.clientId, lastSeenAt: row.lastSeenAt.getTime() }));
}
