import { hasCurrentSessionScopedMachineAccessInTx } from "@/app/api/socket/sessionScopedBinding";
import type { CurrentSessionPublisherAuthority } from "@/app/presence/sessionPublisherPresence";
import type { Tx } from "@/storage/inTx";

export async function hasExactCurrentPublisherAuthorityInTx(
    tx: Tx,
    authority: CurrentSessionPublisherAuthority,
    actorUserId: string,
    sessionId: string,
    expectedRuntimeActivityRevision?: number,
): Promise<boolean> {
    if (authority.accountId !== actorUserId || authority.sessionId !== sessionId) return false;
    if (!await hasCurrentSessionScopedMachineAccessInTx({ tx, ...authority })) return false;
    const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { active: true, archivedAt: true, lastActiveAt: true, runtimeActivityRevision: true },
    });
    if (
        !session
        || session.active !== true
        || session.archivedAt !== null
        || session.lastActiveAt.getTime() !== authority.committedFence.getTime()
    ) return false;
    return expectedRuntimeActivityRevision === undefined
        || session.runtimeActivityRevision === BigInt(expectedRuntimeActivityRevision);
}
