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

/**
 * Takes the Session row's publisher-replacement lock without changing any
 * user-visible Session timestamp. The updatedAt equality is part of the CAS so
 * the preserved value cannot overwrite a concurrent semantic update.
 */
export async function fenceExactCurrentPublisherAuthorityInTx(
    tx: Tx,
    authority: CurrentSessionPublisherAuthority,
    actorUserId: string,
    sessionId: string,
): Promise<boolean> {
    if (authority.accountId !== actorUserId || authority.sessionId !== sessionId) return false;
    if (!await hasCurrentSessionScopedMachineAccessInTx({ tx, ...authority })) return false;
    const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: {
            active: true,
            archivedAt: true,
            lastActiveAt: true,
            updatedAt: true,
        },
    });
    if (
        !session
        || session.active !== true
        || session.archivedAt !== null
        || session.lastActiveAt.getTime() !== authority.committedFence.getTime()
    ) {
        return false;
    }
    const fenced = await tx.session.updateMany({
        where: {
            id: sessionId,
            active: true,
            archivedAt: null,
            lastActiveAt: authority.committedFence,
            updatedAt: session.updatedAt,
        },
        data: {
            lastActiveAt: authority.committedFence,
            updatedAt: session.updatedAt,
        },
    });
    return fenced.count === 1;
}
