import { hasCurrentSessionScopedMachineAccessInTx } from "@/app/api/socket/sessionScopedBinding";
import type { CurrentSessionPublisherAuthority } from "@/app/presence/sessionPublisherPresence";
import type { Tx } from "@/storage/inTx";
import {
    acquireSessionAccountCursorLocksInTx,
    sessionAccountCursorLocksHoldSessionRows,
} from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";

type CurrentSessionPublisherReadAuthority =
    | CurrentSessionPublisherAuthority
    | (Omit<CurrentSessionPublisherAuthority, "committedFence"> & Readonly<{ publisherGeneration: bigint }>);

type PublisherAuthorityReadOptions = Readonly<{
    lockMachineAuthority?: boolean;
    /** Original input admission already decided access; only its publisher lifetime remains. */
    admittedWork?: true;
}>;

/** Reads the current fence from the same registration, or proves an exact heartbeat when one is required. */
export async function readExactCurrentPublisherAuthorityInTx(
    tx: Tx,
    authority: CurrentSessionPublisherReadAuthority,
    actorUserId: string,
    sessionId: string,
    expectedRuntimeActivityRevision?: number,
    options?: PublisherAuthorityReadOptions,
): Promise<CurrentSessionPublisherAuthority | null> {
    if (authority.accountId !== actorUserId || authority.sessionId !== sessionId) return null;
    if (!options?.admittedWork
        && !await hasCurrentSessionScopedMachineAccessInTx({ tx, ...authority, lockAuthority: options?.lockMachineAuthority })) return null;
    const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { accountId: true, active: true, archivedAt: true, lastActiveAt: true, runtimeActivityRevision: true,
            publisherGeneration: true, publisherGenerationLastActiveAt: true },
    });
    if (
        !session
        || session.accountId !== actorUserId
        || session.active !== true
        || session.archivedAt !== null
        || ("committedFence" in authority
            ? session.lastActiveAt.getTime() !== authority.committedFence.getTime()
            : session.publisherGeneration !== authority.publisherGeneration
                || session.publisherGenerationLastActiveAt?.getTime() !== session.lastActiveAt.getTime())
        || (expectedRuntimeActivityRevision !== undefined
            && session.runtimeActivityRevision !== BigInt(expectedRuntimeActivityRevision))
    ) return null;
    return { accountId: authority.accountId, machineId: authority.machineId, sessionId,
        committedFence: session.lastActiveAt };
}

export async function hasExactCurrentPublisherAuthorityInTx(
    tx: Tx,
    authority: CurrentSessionPublisherAuthority,
    actorUserId: string,
    sessionId: string,
    expectedRuntimeActivityRevision?: number,
    options?: PublisherAuthorityReadOptions,
): Promise<boolean> {
    return (await readExactCurrentPublisherAuthorityInTx(tx, authority, actorUserId,
        sessionId, expectedRuntimeActivityRevision, options)) !== null;
}

/**
 * Takes the Session row's publisher-replacement lock without changing any
 * user-visible Session timestamp: the audience cursor locks hold the row on
 * PostgreSQL/MySQL; on SQLite a guarded no-op update takes the writer lock. The updatedAt equality is part of the CAS so
 * the preserved value cannot overwrite a concurrent semantic update.
 * Metadata commits use the stable registration generation; exact-heartbeat
 * callers (including historical takeover) retain their timestamp precondition.
 */
type CurrentSessionPublisherCommitAuthority =
    | (CurrentSessionPublisherAuthority & Readonly<{ publisherGeneration?: bigint }>)
    | (Omit<CurrentSessionPublisherAuthority, "committedFence"> & Readonly<{ publisherGeneration: bigint }>);

export async function fenceExactCurrentPublisherAuthorityInTx(
    tx: Tx,
    authority: CurrentSessionPublisherCommitAuthority,
    actorUserId: string,
    sessionId: string,
    options?: PublisherAuthorityReadOptions,
): Promise<boolean> {
    if (authority.accountId !== actorUserId || authority.sessionId !== sessionId) return false;
    await acquireSessionAccountCursorLocksInTx(tx, [sessionId]);
    if (!options?.admittedWork && !await hasCurrentSessionScopedMachineAccessInTx({ tx, ...authority })) return false;
    const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: {
            accountId: true,
            active: true,
            archivedAt: true,
            lastActiveAt: true,
            updatedAt: true,
            publisherGeneration: true,
            publisherGenerationLastActiveAt: true,
        },
    });
    if (
        !session
        || session.accountId !== actorUserId
        || session.active !== true
        || session.archivedAt !== null
        || ("committedFence" in authority
            && session.lastActiveAt.getTime() !== authority.committedFence.getTime())
        || (authority.publisherGeneration !== undefined
            && (session.publisherGeneration !== authority.publisherGeneration
                || session.publisherGenerationLastActiveAt?.getTime() !== session.lastActiveAt.getTime()))
    ) {
        return false;
    }
    // The cursor locks above already hold this Session row where the dialect has row
    // locks, so the read is the fence. SQLite's guarded update is its writer lock.
    if (sessionAccountCursorLocksHoldSessionRows()) return true;
    const fenced = await tx.session.updateMany({
        where: {
            id: sessionId,
            active: true,
            archivedAt: null,
            lastActiveAt: session.lastActiveAt,
            updatedAt: session.updatedAt,
            ...(authority.publisherGeneration === undefined ? {} : {
                publisherGeneration: authority.publisherGeneration,
                publisherGenerationLastActiveAt: session.lastActiveAt,
            }),
        },
        data: {
            lastActiveAt: session.lastActiveAt,
            updatedAt: session.updatedAt,
        },
    });
    return fenced.count === 1;
}
