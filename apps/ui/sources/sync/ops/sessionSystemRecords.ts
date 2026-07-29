import {
    SessionSystemRecordLookupResponseSchema,
    SessionSystemRecordPageResponseSchema,
    type SessionSystemRecord,
    type SessionSystemRecordKind,
    type SessionSystemRecordNamespace,
} from '@happier-dev/protocol';

import { apiSocket } from '@/sync/api/session/apiSocket';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { resolveServerScopedSessionContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';

/**
 * Generic, provider-agnostic UI transport for session system records (UIW1/W0).
 *
 * These helpers call the existing `/v2/sessions/:sessionId/system-records` route family through the
 * canonical authenticated request path used by every other sync op (`apiSocket.request` for the
 * active server, `runtimeFetchWithServerReachability` for a cross-server scope). They are namespace-
 * agnostic: workflow activity records (`activity/workflow_run.v1`) and memory records flow through
 * the same surface. The server stores `{ t:'plain' | 'encrypted' }` content envelopes and never
 * decrypts; opening/parsing of payloads happens in the calling domain helper.
 */

type RequestInitLike = Readonly<{
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}>;

async function requestSessionSystemRecordRoute(params: Readonly<{
    sessionId: string;
    path: string;
    init?: RequestInitLike;
    serverId?: string | null;
}>): Promise<Response> {
    const context = await resolveServerScopedSessionContext({
        serverId: params.serverId ?? resolvePreferredServerIdForSessionId(params.sessionId) ?? null,
    });
    const init = params.init ?? {};

    if (context.scope === 'active') {
        return await apiSocket.request(params.path, {
            method: init.method ?? 'GET',
            ...(init.headers ? { headers: init.headers } : {}),
            ...(init.body !== undefined ? { body: init.body } : {}),
        });
    }

    return await runtimeFetchWithServerReachability({
        serverUrl: context.targetServerUrl,
        token: context.token,
        url: `${context.targetServerUrl}${params.path}`,
        init: {
            method: init.method ?? 'GET',
            headers: {
                Authorization: `Bearer ${context.token}`,
                ...(init.headers ?? {}),
            },
            ...(init.body !== undefined ? { body: init.body } : {}),
        },
        timeoutMs: context.timeoutMs,
    });
}

function buildSystemRecordsBasePath(sessionId: string): string {
    return `/v2/sessions/${encodeURIComponent(sessionId)}/system-records`;
}

function appendQuery(path: string, params: Readonly<Record<string, string | number | undefined>>): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined) continue;
        query.set(key, String(value));
    }
    const serialized = query.toString();
    return serialized ? `${path}?${serialized}` : path;
}

export type ListSessionSystemRecordsResult = Readonly<{
    records: readonly SessionSystemRecord[];
    nextCursor: string | null;
    hasNext: boolean;
}>;

/**
 * List session system records for a `(namespace, kind)` pair (or `localId` lookup), through the
 * canonical authenticated request path. Returns an empty page on transport/parse failure so callers
 * fail soft and render a loading/minimal shell rather than throwing.
 */
export async function listSessionSystemRecords(params: Readonly<{
    sessionId: string;
    namespace?: SessionSystemRecordNamespace;
    kind?: SessionSystemRecordKind;
    localId?: string;
    limit?: number;
    cursor?: string | null;
    serverId?: string | null;
}>): Promise<ListSessionSystemRecordsResult> {
    const empty: ListSessionSystemRecordsResult = { records: [], nextCursor: null, hasNext: false };
    try {
        const path = appendQuery(buildSystemRecordsBasePath(params.sessionId), {
            namespace: params.namespace,
            kind: params.kind,
            localId: params.localId,
            limit: params.limit,
            cursor: params.cursor ?? undefined,
        });
        const response = await requestSessionSystemRecordRoute({
            sessionId: params.sessionId,
            path,
            serverId: params.serverId ?? null,
        });
        if (!response.ok) return empty;
        const json = await response.json().catch(() => null);
        const parsed = SessionSystemRecordPageResponseSchema.safeParse(json);
        if (!parsed.success) return empty;
        return {
            records: parsed.data.records,
            nextCursor: parsed.data.nextCursor,
            hasNext: parsed.data.hasNext,
        };
    } catch {
        return empty;
    }
}

/**
 * Fetch a single session system record by `(namespace, localId)`. Returns `null` when the record is
 * absent or the transport/parse fails, so a headline that points at a not-yet-written record renders
 * a loading/minimal shell instead of crashing.
 */
export async function fetchSessionSystemRecord(params: Readonly<{
    sessionId: string;
    namespace: SessionSystemRecordNamespace;
    localId: string;
    serverId?: string | null;
}>): Promise<SessionSystemRecord | null> {
    try {
        const path = appendQuery(`${buildSystemRecordsBasePath(params.sessionId)}/record`, {
            namespace: params.namespace,
            localId: params.localId,
        });
        const response = await requestSessionSystemRecordRoute({
            sessionId: params.sessionId,
            path,
            serverId: params.serverId ?? null,
        });
        if (!response.ok) return null;
        const json = await response.json().catch(() => null);
        const parsed = SessionSystemRecordLookupResponseSchema.safeParse(json);
        if (!parsed.success) return null;
        return parsed.data.record ?? null;
    } catch {
        return null;
    }
}
