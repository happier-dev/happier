import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { SESSION_ACCESS_SESSION_BATCH_SIZE } from '@/app/session/access/sessionAccess';
import { readSessionTranscriptRowsInTx } from '@/app/session/access/readSessionTranscriptRows';
import { resolveSessionTranscriptPublicationCeiling } from '@/app/session/sessionTranscriptPublicationPolicy';
import { projectSessionMessageAccountActors } from '@/app/session/messages/projectSessionMessageAccountActors';
import { inReadSnapshot } from '@/storage/inTx';
import { getDbProviderFromEnv, prismaRuntime } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { readSessionMessagePage } from './readSessionMessagePage';
import { SESSION_BATCH_MESSAGE_ROLES, SESSION_MESSAGE_PAGE_DEFAULT_LIMIT, SESSION_MESSAGE_PAGE_ROW_SELECT, buildRequestedMessageRoleWhere, isAdmittedSessionListPreviewRequest, projectSessionMessagePage, type SessionMessagePageResponse, type SessionMessagePageRow, } from './sessionMessagePageProjection';
import { PRESENT_USER_REQUIRED_ERROR } from '@/app/api/utils/apiTokenRouteAdmission';
/** The read-batch contract is one first page of all transcript roles per admitted Session. */
export async function readSessionMessagePages(input: Readonly<{
    userId: string;
    sessionIds: readonly string[];
    authentication: SessionAccessAuthentication;
    /** Derived evidence consumers do not need transcript author presentation. */
    includeAccountActors?: boolean;
    previewRequest?: Parameters<typeof readSessionMessagePage>[0]['previewRequest'];
}>): Promise<ReadonlyMap<string, PromiseSettledResult<SessionMessagePageResponse>>> {
    const ids = [...new Set(input.sessionIds)];
    const results = new Map<string, PromiseSettledResult<SessionMessagePageResponse>>();
    const query = { scope: 'all', roles: SESSION_BATCH_MESSAGE_ROLES.join(',') };
    const admittedIds = ids.filter(sessionId => {
        if (!isAdmittedSessionListPreviewRequest({ sessionId, query, request: input.previewRequest ?? {} })) {
            results.set(sessionId, { status: 'fulfilled', value: { status: 403, body: { error: PRESENT_USER_REQUIRED_ERROR } } });
            return false;
        }
        return true;
    });
    if (!admittedIds.length)
        return results;
    const captured = await inReadSnapshot(async (tx) => {
        const pages = new Map<string, {
            rows: SessionMessagePageRow[];
            actors: Awaited<ReturnType<typeof projectSessionMessageAccountActors>> | undefined;
        }>();
        const denials = new Map<string, SessionMessagePageResponse>();
        // SQL identifiers are static here; only values enter the parameterized query.
        const mysql = getDbProviderFromEnv(process.env, 'postgres') === 'mysql';
        const column = (name: 'SessionMessage' | 'sessionId' | 'seq' | 'messageRole') => prismaRuntime.raw(mysql ? '`' + name + '`' : '"' + name + '"');
        const table = column('SessionMessage'), sid = column('sessionId'), seq = column('seq'), role = column('messageRole');
        const roleWhere = buildRequestedMessageRoleWhere(SESSION_BATCH_MESSAGE_ROLES);
        for (let offset = 0; offset < admittedIds.length; offset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
            const batch = admittedIds.slice(offset, offset + SESSION_ACCESS_SESSION_BATCH_SIZE);
            const access = await readSessionTranscriptRowsInTx(tx, { accountId: input.userId, sessionIds: batch, authentication: input.authentication });
            const allowed = batch.flatMap(sessionId => {
                const decision = access.decisions.get(sessionId);
                if (decision?.status === 'allowed')
                    return [access.rows.get(sessionId)!];
                denials.set(sessionId, decision?.status === 'authentication_required'
                    ? { status: 403, body: { error: 'team_authentication_required' } }
                    : decision?.status === 'authentication_unavailable'
                        ? { status: 503, body: { error: 'team_authentication_unavailable' } }
                        : { status: 404, body: { error: 'Session not found' } });
                return [];
            });
            // Each indexed subquery reads at most the existing page + lookahead.
            // Read only the per-page sequence ranges, then use the canonical
            // Prisma row decoder/select for their bounded content.
            // Ranges rely on writeSessionTranscriptMessageInTx allocating one
            // immutable sequence per inserted row; duplicate/reassigned seqs
            // would invalidate this existing transcript invariant.
            // id + roles + optional ceiling + lookahead are the concrete binds.
            for (const chunk of portableQueryChunks({ values: allowed, bindingsPerValue: SESSION_BATCH_MESSAGE_ROLES.length + 3 })) {
                const ranges = await tx.$queryRaw<Array<{
                    session_id: string;
                    min_seq: number | bigint;
                    max_seq: number | bigint;
                }>>(prismaRuntime.sql `
                    SELECT session_id, MIN(page_seq) AS min_seq, MAX(page_seq) AS max_seq FROM (
                        ${prismaRuntime.join(chunk.map(session => {
                    const ceiling = resolveSessionTranscriptPublicationCeiling(session);
                    return prismaRuntime.sql `SELECT * FROM (
                                SELECT ${sid} AS session_id, ${seq} AS page_seq FROM ${table}
                                WHERE ${sid} = ${session.id}
                                AND (${role} IN (${prismaRuntime.join([...SESSION_BATCH_MESSAGE_ROLES])}) OR ${role} IS NULL)
                                ${ceiling === null ? prismaRuntime.empty : prismaRuntime.sql `AND ${seq} <= ${ceiling}`}
                                ORDER BY ${seq} DESC LIMIT ${SESSION_MESSAGE_PAGE_DEFAULT_LIMIT + 1}
                            ) session_page`;
                }), ' UNION ALL ')}
                    ) session_pages GROUP BY session_id`);
                if (!ranges.length)
                    continue;
                const rows = await tx.sessionMessage.findMany({ where: {
                        sessionId: { in: chunk.map(session => session.id) },
                        AND: [roleWhere ?? {}, { OR: ranges.map(range => ({ sessionId: range.session_id,
                                    seq: { gte: Number(range.min_seq), lte: Number(range.max_seq) } })) }],
                    }, orderBy: { seq: 'desc' }, select: SESSION_MESSAGE_PAGE_ROW_SELECT });
                const visible = new Map<string, SessionMessagePageRow[]>();
                for (const row of rows) {
                    const sessionRows = visible.get(row.sessionId) ?? [];
                    sessionRows.push(row);
                    visible.set(row.sessionId, sessionRows);
                }
                const actors = input.includeAccountActors === false ? undefined
                    : await projectSessionMessageAccountActors(tx,
                        [...visible.values()].flatMap(rows => rows.slice(0, SESSION_MESSAGE_PAGE_DEFAULT_LIMIT)));
                let actorIndex = 0;
                for (const [sessionId, rows] of visible) {
                    const count = Math.min(rows.length, SESSION_MESSAGE_PAGE_DEFAULT_LIMIT);
                    pages.set(sessionId, { rows, actors: actors?.slice(actorIndex, actorIndex + count) });
                    actorIndex += count;
                }
            }
        }
        return { pages, denials };
    });
    for (const sessionId of admittedIds) {
        try {
            const denied = captured.denials.get(sessionId);
            const page = captured.pages.get(sessionId);
            results.set(sessionId, { status: 'fulfilled', value: denied ?? projectSessionMessagePage({
                    sessionId, resultMessages: page?.rows.slice(0, SESSION_MESSAGE_PAGE_DEFAULT_LIMIT) ?? [],
                    hasMore: (page?.rows.length ?? 0) > SESSION_MESSAGE_PAGE_DEFAULT_LIMIT,
                    turnProjectionNextBeforeSeq: null, pageAccountActors: input.includeAccountActors === false ? undefined : page?.actors ?? [],
                    sessionListPreviewProjection: false, externalShareableProjection: false, turnProjection: false,
                }) });
        }
        catch (reason) {
            results.set(sessionId, { status: 'rejected', reason });
        }
    }
    return results;
}
