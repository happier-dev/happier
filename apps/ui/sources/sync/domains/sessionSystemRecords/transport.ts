import { SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER, SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE, readSessionSystemRecordErrorCodeV1, SessionSystemRecordStoredPageResponseSchema, SessionSystemRecordStoredReadResponseSchema, type SessionSystemRecordListQuery, type SessionSystemRecordStored, type SessionSystemRecordStoredPageResponse } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import type { SessionSystemRecordAddress } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordAddress';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type SessionSystemRecordFetchResult<T> =
    | Readonly<{ status: 'ok'; value: T }>
    | Readonly<{ status: 'not_found' | 'forbidden' | 'feature_disabled' | 'protocol_unavailable' | 'offline' | 'invalid_response' }>
    | Readonly<{ status: 'server_error'; retryable: boolean }>;
export type SessionSystemRecordTransportOptions = Readonly<{
    scope: ServerAccountScope;
    /** Captured authenticated network boundary; the caller owns its request lease. */
    request: (path: string, init?: RequestInit, options?: Readonly<{ onIssued?: () => void }>) => Promise<Response>;
}>;
export type HostSessionSystemRecordAddress = Extract<SessionSystemRecordAddress, { owner: 'host' }>;
export type HostSessionSystemRecordListQuery = Omit<Extract<SessionSystemRecordListQuery, { owner: 'host' }>, 'owner' | 'limit'> & { limit?: number };

export async function readSessionSystemRecordResponse(response: Response): Promise<SessionSystemRecordFetchResult<unknown>> {
    let value: unknown;
    try { value = await response.json(); } catch { return { status: 'invalid_response' }; }
    if (response.ok) return { status: 'ok', value };
    const code = readSessionSystemRecordErrorCodeV1(value);
    if (code === null) return { status: 'invalid_response' };
    switch (code) {
        case 'plugin_session_records_unavailable': return { status: 'protocol_unavailable' };
        case 'plugin_session_record_feature_disabled': return { status: 'feature_disabled' };
        case 'plugin_session_record_forbidden': return { status: 'forbidden' };
        case 'plugin_session_not_found': return { status: 'not_found' };
        default: return { status: 'server_error', retryable: response.status >= 500 || response.status === 429 };
    }
}

export function createSessionSystemRecordTransport(options: SessionSystemRecordTransportOptions) {
    async function request(session: SessionAddress, suffix: string, values: Readonly<Record<string, string | number | null | undefined>>) {
        if (!areServerProfileIdentifiersEquivalent(session.serverId, options.scope.serverId)) return { status: 'forbidden' } as const;
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined) query.set(key, String(value));
        try {
            return await readSessionSystemRecordResponse(await options.request(
                `/v2/sessions/${encodeURIComponent(session.sessionId)}/system-records${suffix}?${query}`,
                { method: 'GET', headers: { [SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER]: SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE } },
            ));
        } catch { return { status: 'offline' } as const; }
    }
    return {
        async read(session: SessionAddress, address: HostSessionSystemRecordAddress): Promise<SessionSystemRecordFetchResult<SessionSystemRecordStored>> {
            const result = await request(session, '/record', address);
            if (result.status !== 'ok') return result;
            const parsed = SessionSystemRecordStoredReadResponseSchema.safeParse(result.value);
            if (!parsed.success) return { status: 'invalid_response' };
            const record = parsed.data.record;
            if (!record) return { status: 'not_found' };
            if (record.address.owner !== 'host' || record.address.namespace !== address.namespace || record.address.kind !== address.kind || record.address.localId !== address.localId) return { status: 'invalid_response' };
            return { status: 'ok', value: record };
        },
        async list(session: SessionAddress, query: HostSessionSystemRecordListQuery): Promise<SessionSystemRecordFetchResult<SessionSystemRecordStoredPageResponse>> {
            const result = await request(session, '', { owner: 'host', namespace: query.namespace, kind: query.kind, localId: query.localId, limit: query.limit, cursor: query.cursor });
            if (result.status !== 'ok') return result;
            const parsed = SessionSystemRecordStoredPageResponseSchema.safeParse(result.value);
            if (!parsed.success) return { status: 'invalid_response' };
            if (parsed.data.records.some(({ address }) => address.owner !== 'host' || address.namespace !== query.namespace || (query.kind !== undefined && address.kind !== query.kind) || (query.localId !== undefined && address.localId !== query.localId))) return { status: 'invalid_response' };
            return { status: 'ok', value: parsed.data };
        },
    };
}
