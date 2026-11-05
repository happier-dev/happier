import type { Tx } from '@/storage/inTx';
import type { SessionAccessAuthentication } from './sessionAccessAuthentication';

/** Content-capture cut only; a later readmission must not advance this witness. */
export async function readSessionObservationCursorInTx(
    tx: Tx,
    accountId: string,
    authentication: SessionAccessAuthentication,
): Promise<number | undefined> {
    // Only present-user Sync consumes this Account-wide fact. Automation and
    // restricted Session readers must not learn activity outside their scope.
    if (authentication.authority !== 'present_user' || authentication.sessionRuntimePrincipal) return undefined;
    return (await tx.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } })).seq;
}
