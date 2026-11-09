import { SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER, SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE, readSessionSystemRecordErrorCodeV1, SessionSystemRecordStoredPageResponseSchema, SessionSystemRecordStoredReadResponseSchema, type SessionSystemRecordListQuery, type SessionSystemRecordStored, type SessionSystemRecordStoredPageResponse } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import type { SessionSystemRecordAddress } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordAddress';
import { SessionSystemRecordCountResponseSchema, type SessionSystemRecordCountResponse } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { projectSessionBoardAdapterFailureV1, type SessionBoardSimpleFailureCodeV1 } from '@happier-dev/protocol/sessions/board/actions';
import { log } from '@/log';
import { isExplicitlyRetryableError, isTransientConnectivityError, RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { EnsureSessionVisibleForRouteResult } from '@/sync/domains/session/sessionRouteHydrationState';

export type SessionSystemRecordFetchResult<T> =
    | Readonly<{ status: 'ok'; value: T }>
    | Readonly<{ status: Exclude<SessionBoardSimpleFailureCodeV1, 'server_error'> | 'feature_disabled' }>
    | Readonly<{ status: 'server_error'; retryable: boolean }>;
export type SessionSystemRecordTransportOptions = Readonly<{
    scope: ServerAccountScope;
    /** Captured authenticated network boundary; the caller owns its request lease. */
    request: (path: string, init?: RequestInit, options?: Readonly<{ onIssued?: () => void }>) => Promise<Response>;
}>;
export type HostSessionSystemRecordAddress = Extract<SessionSystemRecordAddress, { owner: 'host' }>;
export type HostSessionSystemRecordListQuery = Omit<Extract<SessionSystemRecordListQuery, { owner: 'host' }>, 'owner' | 'limit'> & { limit?: number };

/** Pending/superseded Session material is not a malformed transport response. */
export function projectSessionSystemRecordHydrationFailure(
    result: Exclude<EnsureSessionVisibleForRouteResult, { kind: 'available' }>,
): Exclude<SessionSystemRecordFetchResult<never>, { status: 'ok' }> {
    if (result.kind === 'missing') return { status: result.cause === 'not_found' ? 'not_found' : 'forbidden' };
    const fallback = result.kind === 'awaiting_push' ? 'server_error'
        : result.cause === 'decrypting' ? 'encryption_material_unavailable'
            : result.cause === 'network' || result.cause === 'server_unavailable' ? 'offline' : 'server_error';
    const failure = projectSessionSystemRecordFetchFailure({ code: result.errorCode, retryable: true }, fallback);
    // Closed lifecycle facts only: this distinguishes cold hydration failures without logging content.
    log.log(`Session System Record hydration failed: kind=${result.kind} cause=${result.kind === 'retryable_failure' ? result.cause : 'superseded'} code=${failure.status}`);
    return failure;
}

/** Read exceptions carry the existing closed adapter code, never exception content. */
export function projectSessionSystemRecordFetchFailure(
    error: unknown,
    fallback: SessionBoardSimpleFailureCodeV1 = !(error instanceof RetryableServerResponseError) && isTransientConnectivityError(error) ? 'offline' : 'server_error',
): Exclude<SessionSystemRecordFetchResult<never>, { status: 'ok' }> {
    const failure = projectSessionBoardAdapterFailureV1(error, fallback, 'session.board.get');
    // The adapter projector emits only simple codes or this operation's feature refusal;
    // mutation recovery and update-required envelopes are never produced by exceptions.
    const status = failure.errorCode as SessionBoardSimpleFailureCodeV1 | 'feature_disabled';
    log.log(`Session System Record read failed: code=${status}`);
    return status === 'server_error' ? {
        status,
        retryable: isExplicitlyRetryableError(error)
            || (error !== null && typeof error === 'object' && 'retryable' in error && error.retryable === true),
    } : { status };
}

export async function readSessionSystemRecordResponse(response: Response): Promise<SessionSystemRecordFetchResult<unknown>> {
    let value: unknown;
    try { value = await response.json(); }
    catch (error) { return projectSessionSystemRecordFetchFailure(error, error instanceof SyntaxError ? 'invalid_response' : undefined); }
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
    async function request(session: SessionAddress, suffix: string, values: Readonly<Record<string, string | number | null | undefined>>, signal?: AbortSignal) {
        if (!areServerProfileIdentifiersEquivalent(session.serverId, options.scope.serverId)) return { status: 'forbidden' } as const;
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined) query.set(key, String(value));
        try {
            return await readSessionSystemRecordResponse(await options.request(
                `/v2/sessions/${encodeURIComponent(session.sessionId)}/system-records${suffix}?${query}`,
                { method: 'GET', signal, headers: { [SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER]: SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE } },
            ));
        } catch (error) { return projectSessionSystemRecordFetchFailure(error); }
    }
    return {
        async countBoardItems(session: SessionAddress, signal?: AbortSignal): Promise<SessionSystemRecordFetchResult<SessionSystemRecordCountResponse>> {
            const result = await request(session, '', { owner: 'host', namespace: 'surface', kind: 'item.v1', projection: 'count' }, signal);
            if (result.status !== 'ok') return result;
            const parsed = SessionSystemRecordCountResponseSchema.safeParse(result.value);
            return parsed.success ? { status: 'ok', value: parsed.data } : { status: 'invalid_response' };
        },
        async read(session: SessionAddress, address: HostSessionSystemRecordAddress, signal?: AbortSignal): Promise<SessionSystemRecordFetchResult<SessionSystemRecordStored>> {
            const result = await request(session, '/record', address, signal);
            if (result.status !== 'ok') return result;
            const parsed = SessionSystemRecordStoredReadResponseSchema.safeParse(result.value);
            if (!parsed.success) return { status: 'invalid_response' };
            const record = parsed.data.record;
            if (!record) return { status: 'not_found' };
            if (record.address.owner !== 'host' || record.address.namespace !== address.namespace || record.address.kind !== address.kind || record.address.localId !== address.localId) return { status: 'invalid_response' };
            return { status: 'ok', value: record };
        },
        async list(session: SessionAddress, query: HostSessionSystemRecordListQuery, signal?: AbortSignal): Promise<SessionSystemRecordFetchResult<SessionSystemRecordStoredPageResponse>> {
            const result = await request(session, '', { owner: 'host', namespace: query.namespace, kind: query.kind, localId: query.localId, limit: query.limit, cursor: query.cursor }, signal);
            if (result.status !== 'ok') return result;
            const parsed = SessionSystemRecordStoredPageResponseSchema.safeParse(result.value);
            if (!parsed.success) return { status: 'invalid_response' };
            if (parsed.data.records.some(({ address }) => address.owner !== 'host' || address.namespace !== query.namespace || (query.kind !== undefined && address.kind !== query.kind) || (query.localId !== undefined && address.localId !== query.localId))) return { status: 'invalid_response' };
            return { status: 'ok', value: parsed.data };
        },
    };
}
