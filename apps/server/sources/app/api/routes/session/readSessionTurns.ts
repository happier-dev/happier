import type { z } from 'zod/mini';
import type { SessionTurnsProjectionV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { SESSION_ACCESS_SESSION_BATCH_SIZE } from '@/app/session/access/sessionAccess';
import { readSessionTranscriptRowsInTx } from '@/app/session/access/readSessionTranscriptRows';
import { isExternalShareableSessionTurnVisible, isSessionTranscriptShareable, resolveSessionTranscriptNonOwnerRecencyMs } from '@/app/session/sessionTranscriptPublicationPolicy';
import { parseStoredSessionTurns } from '@/app/session/turns/parseSessionTurnState';
import { inReadSnapshot } from '@/storage/inTx';
import type { Tx } from '@/storage/inTx';
import { resolveSessionAccessForRowsInTx, type SessionAccessOperationDecision } from '@/app/session/access/sessionAccess';
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
type TranscriptRows = Awaited<ReturnType<typeof readSessionTranscriptRowsInTx>>['rows'];
type TranscriptRow = TranscriptRows extends ReadonlyMap<string, infer Row> ? Row : never;

/**
 * Turns for Sessions whose rows the caller already read in this snapshot. The caller's
 * row read may serve other components; the `readTranscript` decision is this component's own.
 */
export async function readSessionTurnsForRowsInTx(tx: Tx, input: TurnsInput & Readonly<{
    sessionIds: readonly string[];
    rows: ReadonlyMap<string, TranscriptRow>;
    decisions?: ReadonlyMap<string, SessionAccessOperationDecision>;
}>): Promise<ReadonlyMap<string, PromiseSettledResult<TurnsResponse>>> {
    const rows = input.sessionIds.flatMap(id => { const row = input.rows.get(id); return row ? [row] : []; });
    const decisions = input.decisions ?? await resolveSessionAccessForRowsInTx(tx, {
        accountId: input.userId, authentication: input.authentication, capability: 'readTranscript',
    }, rows);
    return projectTurns(input.sessionIds, { rows: new Map(rows.map(row => [row.id, row])), decisions },
        await readTurnRowsInTx(tx, { access: { decisions }, sessionIds: input.sessionIds }));
}

async function readTurnRowsInTx(tx: Tx, input: Readonly<{
    access: Readonly<{ decisions: ReadonlyMap<string, { status: string }>; rows?: TranscriptRows }>;
    sessionIds: readonly string[];
    recentCommittedTurns?: number;
}>) {
    const allowedIds = input.sessionIds.filter(id => input.access.decisions.get(id)?.status === 'allowed');
    const readTurns = (remaining?: number, cursor?: { sessionId: string; turnId: string }) => tx.sessionTurn.findMany({
        where: { sessionId: { in: allowedIds }, ...(remaining === undefined ? {} : { status: { not: 'in_progress' } }) },
        orderBy: remaining === undefined ? [{ updatedAt: 'asc' }, { createdAt: 'asc' }]
            : [{ startedAt: 'desc' }, { createdAt: 'desc' }, { turnId: 'desc' }],
        ...(remaining === undefined ? {} : { take: remaining }),
        ...(cursor ? { cursor: { sessionId_turnId: cursor }, skip: 1 } : {}),
    });
    const turns: Awaited<ReturnType<typeof readTurns>> = [];
    if (allowedIds.length) {
        if (input.recentCommittedTurns === undefined) turns.push(...await readTurns());
        else if (isSessionTranscriptShareable(input.access.rows!.get(allowedIds[0])!)) {
            // Select visible committed rows before limiting. A published
            // snapshot may have private rows beyond its publication frontier.
            let cursor: { sessionId: string; turnId: string } | undefined;
            while (turns.length < input.recentCommittedTurns) {
                const page = await readTurns(input.recentCommittedTurns - turns.length, cursor);
                if (!page.length) break;
                turns.push(...page.filter(row => isExternalShareableSessionTurnVisible({ row, publication: input.access.rows!.get(row.sessionId)! })));
                cursor = { sessionId: page[page.length - 1].sessionId, turnId: page[page.length - 1].turnId };
            }
            turns.reverse();
        }
    }
    const bySession = new Map<string, typeof turns>();
    for (const turn of turns) {
        const rows = bySession.get(turn.sessionId) ?? [];
        rows.push(turn);
        bySession.set(turn.sessionId, rows);
    }
    return bySession;
}

function projectTurns(sessionIds: readonly string[], access: Readonly<{
    rows: ReadonlyMap<string, TranscriptRow>; decisions: ReadonlyMap<string, { status: string }>;
}>, bySession: Awaited<ReturnType<typeof readTurnRowsInTx>>, recentCommittedTurns?: number) {
    const results = new Map<string, PromiseSettledResult<TurnsResponse>>();
    for (const sessionId of sessionIds) {
        try {
            const session = access.rows.get(sessionId);
            if (!session || access.decisions.get(sessionId)?.status !== 'allowed') {
                results.set(sessionId, { status: 'fulfilled', value: { status: 404, body: { error: 'Session not found' } } });
                continue;
            }
            const rows = bySession.get(sessionId) ?? [];
            const turns = parseStoredSessionTurns(recentCommittedTurns === undefined
                ? rows.filter(row => isExternalShareableSessionTurnVisible({ row, publication: session })) : rows);
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

/** Scalar and batch reads share admission, publication and turn parsing. */
export async function readSessionTurnsBatch(input: TurnsInput & (
    Readonly<{ sessionIds: readonly string[]; recentCommittedTurns?: undefined }>
    | Readonly<{ sessionIds: readonly [string]; recentCommittedTurns: number }>
)): Promise<ReadonlyMap<string, PromiseSettledResult<TurnsResponse>>> {
    const ids = [...new Set(input.sessionIds)];
    const results = new Map<string, PromiseSettledResult<TurnsResponse>>();
    if (!ids.length)
        return results;
    for (let offset = 0; offset < ids.length; offset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
        const batch = ids.slice(offset, offset + SESSION_ACCESS_SESSION_BATCH_SIZE);
        try {
            const { access, bySession } = await inReadSnapshot(async (tx) => {
                const access = await readSessionTranscriptRowsInTx(tx, { accountId: input.userId, sessionIds: batch, authentication: input.authentication });
                return { access, bySession: await readTurnRowsInTx(tx, { access, sessionIds: batch, recentCommittedTurns: input.recentCommittedTurns }) };
            });
            for (const [id, result] of projectTurns(batch, access, bySession, input.recentCommittedTurns)) results.set(id, result);
        } catch (reason) {
            for (const sessionId of batch) results.set(sessionId, { status: 'rejected', reason });
        }
    }
    return results;
}
export async function readSessionTurns(input: TurnsInput & Readonly<{
    sessionId: string;
    recentCommittedTurns?: number;
}>): Promise<TurnsResponse> {
    const result = (await readSessionTurnsBatch({ userId: input.userId, authentication: input.authentication,
        ...(input.recentCommittedTurns === undefined ? { sessionIds: [input.sessionId] }
            : { sessionIds: [input.sessionId] as const, recentCommittedTurns: input.recentCommittedTurns }),
    })).get(input.sessionId)!;
    if (result.status === 'rejected')
        throw result.reason;
    return result.value;
}
