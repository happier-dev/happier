import type { z } from 'zod/mini';
import type { SessionTurnsProjectionV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { SESSION_ACCESS_SESSION_BATCH_SIZE } from '@/app/session/access/sessionAccess';
import { readSessionTranscriptRowsInTx } from '@/app/session/access/readSessionTranscriptRows';
import { isExternalShareableSessionTurnVisible, isSessionTranscriptShareable, resolveSessionTranscriptNonOwnerRecencyMs } from '@/app/session/sessionTranscriptPublicationPolicy';
import { parseStoredSessionTurns } from '@/app/session/turns/parseSessionTurnState';
import { inReadSnapshot } from '@/storage/inTx';
type TurnsInput = Readonly<{
    userId: string;
    authentication: SessionAccessAuthentication;
}>;
type TurnsResponse = {
    status: 200;
    body: z.infer<typeof SessionTurnsProjectionV1Schema>;
} | {
    status: 404;
    body: {
        error: 'Session not found';
    };
};
/** Scalar and batch reads share admission, publication and turn parsing. */
export async function readSessionTurnsBatch(input: TurnsInput & Readonly<{
    sessionIds: readonly string[];
}>): Promise<ReadonlyMap<string, PromiseSettledResult<TurnsResponse>>> {
    const ids = [...new Set(input.sessionIds)];
    const results = new Map<string, PromiseSettledResult<TurnsResponse>>();
    if (!ids.length)
        return results;
    const captured = await inReadSnapshot(async (tx) => {
        const chunks = [];
        for (let offset = 0; offset < ids.length; offset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
            const batch = ids.slice(offset, offset + SESSION_ACCESS_SESSION_BATCH_SIZE);
            const access = await readSessionTranscriptRowsInTx(tx, { accountId: input.userId, sessionIds: batch, authentication: input.authentication });
            const allowedIds = batch.filter(id => access.decisions.get(id)?.status === 'allowed');
            const turns = allowedIds.length ? await tx.sessionTurn.findMany({ where: { sessionId: { in: allowedIds } },
                orderBy: [{ updatedAt: 'asc' }, { createdAt: 'asc' }] }) : [];
            const bySession = new Map<string, typeof turns>();
            for (const turn of turns) {
                const rows = bySession.get(turn.sessionId) ?? [];
                rows.push(turn);
                bySession.set(turn.sessionId, rows);
            }
            chunks.push({ batch, access, bySession });
        }
        return chunks;
    });
    for (const { batch, access, bySession } of captured)
        for (const sessionId of batch) {
            try {
                const session = access.rows.get(sessionId);
                if (!session || access.decisions.get(sessionId)?.status !== 'allowed') {
                    results.set(sessionId, { status: 'fulfilled', value: { status: 404, body: { error: 'Session not found' } } });
                    continue;
                }
                const turns = parseStoredSessionTurns((bySession.get(sessionId) ?? []).filter(row => isExternalShareableSessionTurnVisible({ row, publication: session })));
                const visible = new Set(turns.map(turn => turn.turnId));
                results.set(sessionId, { status: 'fulfilled', value: { status: 200, body: {
                            v: 1, sessionId, ...(session.latestTurnId && visible.has(session.latestTurnId) ? { latestTurnId: session.latestTurnId } : {}),
                            updatedAt: isSessionTranscriptShareable(session) ? resolveSessionTranscriptNonOwnerRecencyMs(session, session.updatedAt) : 0,
                            turns,
                        } } });
            }
            catch (reason) {
                results.set(sessionId, { status: 'rejected', reason });
            }
        }
    return results;
}
export async function readSessionTurns(input: TurnsInput & Readonly<{
    sessionId: string;
}>): Promise<TurnsResponse> {
    const result = (await readSessionTurnsBatch({ ...input, sessionIds: [input.sessionId] })).get(input.sessionId)!;
    if (result.status === 'rejected')
        throw result.reason;
    return result.value;
}
