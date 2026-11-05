import type { Tx } from '@/storage/inTx';
import { buildSessionAccessProjectionSelect, resolveSessionAccessForRowsInTx } from './sessionAccess';
import type { SessionAccessAuthentication } from './sessionAccessAuthentication';
/** One same-snapshot access/publication row set; content loaders consume only allowed ids. */
export async function readSessionTranscriptRowsInTx(tx: Tx, input: Readonly<{
    accountId: string;
    sessionIds: readonly string[];
    authentication: SessionAccessAuthentication;
}>) {
    const rows = await tx.session.findMany({
        where: { id: { in: [...input.sessionIds] } },
        select: { ...buildSessionAccessProjectionSelect(input.accountId), latestTurnId: true, updatedAt: true },
    });
    const decisions = await resolveSessionAccessForRowsInTx(tx, {
        accountId: input.accountId, authentication: input.authentication, capability: 'readTranscript',
    }, rows);
    return { rows: new Map(rows.map(row => [row.id, row])), decisions };
}
