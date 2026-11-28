import { z } from 'zod';
import { computeSessionLeavesAt, V2SessionRecordSchema } from '@happier-dev/protocol';

import { serverFetch } from '@/sync/http/client';

/**
 * `GET /v2/sessions/leaving` (plan 02 U3): the sessions that leave Happier Cloud inside the notice
 * window. 404 means the server has no notice on, which the client treats as "nothing to show".
 *
 * The session list consumes dates and IDs. An explicit Action invocation also reads titles from
 * the metadata carried by the same pages.
 */
const SessionLeavingRuleSchema = z.object({
    retentionDays: z.number().int(),
    noticeDays: z.number().int(),
    floorAt: z.number().int(),
});

const { id, metadata, metadataVersion, encryptionMode, dataEncryptionKey, updatedAt, activeAt } = V2SessionRecordSchema.shape;
const SessionLeavingMetadataSchema = z.object({ id, metadata, metadataVersion, encryptionMode, dataEncryptionKey });
const SessionLeavingRowSchema = SessionLeavingMetadataSchema.partial().extend({
    id, updatedAt, activeAt,
});

const SessionLeavingPageSchema = z.object({
    rule: SessionLeavingRuleSchema,
    count: z.number().int(),
    newestLeavesAt: z.number().int().nullable(),
    sessions: z.array(SessionLeavingRowSchema),
    nextCursor: z.string().nullable(),
});

export type SessionLeavingRule = z.infer<typeof SessionLeavingRuleSchema>;
export type SessionLeavingRow = z.infer<typeof SessionLeavingRowSchema>;
export type SessionLeavingPage = z.infer<typeof SessionLeavingPageSchema>;

export type SessionLeavingReadResult =
    | Readonly<{ kind: 'off' }>
    | Readonly<{ kind: 'page'; page: SessionLeavingPage }>;

/** The route's own page ceiling: one page holds every leaving session a person realistically has. */
export const SESSION_LEAVING_PAGE_LIMIT = 200;

export async function fetchSessionLeavingPage(signal?: AbortSignal, cursor?: string): Promise<SessionLeavingReadResult> {
    const query = new URLSearchParams({ limit: String(SESSION_LEAVING_PAGE_LIMIT) });
    if (cursor) query.set('cursor', cursor);
    const response = await serverFetch(
        `/v2/sessions/leaving?${query}`,
        { method: 'GET', signal, responseSizeBounded: true },
    );
    if (response.status === 404) return { kind: 'off' };
    if (!response.ok) throw new Error(`/v2/sessions/leaving answered ${response.status}`);
    return { kind: 'page', page: SessionLeavingPageSchema.parse(await response.json()) };
}

export function getLeavingSessionDate(row: SessionLeavingRow, rule: SessionLeavingRule): number {
    return computeSessionLeavesAt(Math.max(row.updatedAt, row.activeAt), rule);
}

export async function listLeavingSessions(params: Readonly<{
    signal?: AbortSignal;
    assertScope?: () => void;
    readTitle: (row: z.infer<typeof SessionLeavingMetadataSchema>) => Promise<string | null>;
}>) {
    const sessions = new Map<string, { id: string; leavesAt: number; title: string | null }>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let count = 0;
    do {
        params.assertScope?.();
        const result = await fetchSessionLeavingPage(params.signal, cursor);
        params.assertScope?.();
        if (result.kind === 'off') return { count: 0, sessions: [] };
        if (!cursor) count = result.page.count;
        for (const row of result.page.sessions) {
            if (sessions.has(row.id)) continue;
            const metadata = SessionLeavingMetadataSchema.safeParse(row);
            const title = metadata.success ? await params.readTitle(metadata.data) : null;
            params.assertScope?.();
            sessions.set(row.id, { id: row.id, leavesAt: getLeavingSessionDate(row, result.page.rule), title });
        }
        cursor = result.page.nextCursor ?? undefined;
        if (cursor) {
            if (seenCursors.has(cursor)) throw new Error('Leaving session paging did not advance');
            seenCursors.add(cursor);
        }
    } while (cursor);
    return {
        count,
        sessions: [...sessions.values()].sort((left, right) => left.leavesAt - right.leavesAt || left.id.localeCompare(right.id)),
    };
}
