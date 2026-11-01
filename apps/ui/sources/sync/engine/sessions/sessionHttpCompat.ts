import {
    PendingActivationAuthorizationV1Schema,
    V2SessionListResponseSchema,
    V2SessionByIdNotFoundSchema,
    withConnectedServiceReaderSupport,
    type V2SessionListResponse,
    type V2SessionRecord,
} from '@happier-dev/protocol';

import { createNotAuthenticatedError } from '@/sync/runtime/connectivity/authErrors';
import {
    syncPerformanceTelemetry,
    type SyncPerformanceTelemetryFields,
} from '@/sync/runtime/syncPerformanceTelemetry';
import { HappyError } from '@/utils/errors/errors';
import { resolveSessionRuntimeActivityProjectionFields } from './sessionRuntimeActivityProjection';
import { normalizeSessionListHydrationSessionIds } from './sessionListHydrationPriority';

type SessionRequest = (path: string, init: RequestInit) => Promise<Response>;
type SessionListRequestHeadersOptions = Readonly<{
    includeSessionListTiming?: boolean;
}>;
type ReadJsonSafeOptions = Readonly<{
    telemetryNamePrefix?: string;
    fields?: SyncPerformanceTelemetryFields;
    onResponseChars?: (responseChars: number) => void;
}>;

const V2_SESSIONS_SERVER_TIMING_FIELD_BY_NAME: Readonly<Record<string, string>> = {
    happier_v2_sessions_cursor: 'serverTimingCursorMs',
    happier_v2_sessions_query: 'serverTimingQueryMs',
    happier_v2_sessions_page: 'serverTimingPageMs',
    happier_v2_sessions_total: 'serverTimingTotalMs',
};

function buildSessionRequestHeaders(token: string, options?: SessionListRequestHeadersOptions): HeadersInit {
    const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
    };
    if (options?.includeSessionListTiming === true && syncPerformanceTelemetry.isEnabled()) {
        headers['X-Happier-Session-List-Timing'] = '1';
    }
    return headers;
}

async function readJsonSafe(response: Response, options?: ReadJsonSafeOptions): Promise<unknown> {
    try {
        if (!options?.telemetryNamePrefix) {
            return await response.json();
        }

        const bodyFields: Record<string, unknown> = { ...(options.fields ?? {}) };
        const text = await syncPerformanceTelemetry.measureAsync(
            `${options.telemetryNamePrefix}.responseBody`,
            bodyFields,
            async () => {
                const responseText = await response.text();
                const responseChars = responseText.length;
                bodyFields.responseChars = responseChars;
                options.onResponseChars?.(responseChars);
                return responseText;
            },
        );
        return syncPerformanceTelemetry.measure(
            `${options.telemetryNamePrefix}.responseJson`,
            bodyFields,
            () => JSON.parse(text),
        );
    } catch {
        return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNullableNumber(value: unknown): number | null | undefined {
    if (value == null) return null;
    return readNumber(value);
}

function readPositiveSafeInteger(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return undefined;
    return value;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function readOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
    if (value == null) return null;
    return typeof value === 'string' ? value : undefined;
}

function readRollbackEligibleTurnStarts(value: unknown): number[] | undefined {
    if (value === null) return undefined;
    if (!Array.isArray(value)) return undefined;

    const starts: number[] = [];
    for (const entry of value) {
        if (typeof entry !== 'number' || !Number.isFinite(entry)) continue;
        const seq = Math.trunc(entry);
        if (seq < 0 || starts.includes(seq)) continue;
        starts.push(seq);
    }
    return starts;
}

function parseServerTimingDurationMs(value: string): number | null {
    const match = /(?:^|;)\s*dur=([0-9]+(?:\.[0-9]+)?)/.exec(value);
    if (!match?.[1]) return null;
    const durationMs = Number(match[1]);
    return Number.isFinite(durationMs) ? durationMs : null;
}

function readV2SessionsServerTimingFields(response: Response): Record<string, number> {
    const header = response.headers.get('Server-Timing') ?? response.headers.get('server-timing') ?? '';
    if (!header) return {};

    const fields: Record<string, number> = {};
    for (const metric of header.split(',')) {
        const trimmedMetric = metric.trim();
        if (!trimmedMetric) continue;
        const metricName = trimmedMetric.split(';', 1)[0]?.trim() ?? '';
        const fieldName = V2_SESSIONS_SERVER_TIMING_FIELD_BY_NAME[metricName];
        if (!fieldName) continue;
        const durationMs = parseServerTimingDurationMs(trimmedMetric);
        if (durationMs == null) continue;
        fields[fieldName] = durationMs;
    }
    return fields;
}

function coerceStringPayload(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (value == null) return null;
    if (!isRecord(value) && !Array.isArray(value)) return null;
    try {
        return JSON.stringify(value);
    } catch {
        return null;
    }
}

function coerceLegacySessionRecord(raw: unknown): V2SessionRecord | null {
    if (!isRecord(raw)) return null;

    const id = readOptionalString(raw.id);
    const seq = readNumber(raw.seq);
    const createdAt = readNumber(raw.createdAt);
    const updatedAt = readNumber(raw.updatedAt);
    const active = raw.active;
    const activeAt = readNumber(raw.activeAt);
    const metadataVersion = readNumber(raw.metadataVersion);
    const metadata = coerceStringPayload(raw.metadata);
    const agentStateVersion = readNumber(raw.agentStateVersion);

    if (
        !id
        || seq == null
        || createdAt == null
        || updatedAt == null
        || typeof active !== 'boolean'
        || activeAt == null
        || metadataVersion == null
        || metadata == null
        || agentStateVersion == null
    ) {
        return null;
    }

    const topLevelAccessLevel = readOptionalString(raw.accessLevel);
    const topLevelCanApprovePermissions = readOptionalBoolean(raw.canApprovePermissions);
    const shareRecord = isRecord(raw.share) ? raw.share : null;
    const shareAccessLevel = readOptionalString(shareRecord?.accessLevel) ?? topLevelAccessLevel;
    const shareCanApprovePermissions = readOptionalBoolean(shareRecord?.canApprovePermissions) ?? topLevelCanApprovePermissions;
    const rollbackEligibleTurnStarts = readRollbackEligibleTurnStarts(raw.rollbackEligibleTurnStarts);
    const runtimeActivityProjection = resolveSessionRuntimeActivityProjectionFields({}, raw);

    return {
        id,
        seq,
        createdAt,
        updatedAt,
        meaningfulActivityAt: readNumber(raw.meaningfulActivityAt) ?? undefined,
        active,
        activeAt,
        archivedAt: readNullableNumber(raw.archivedAt),
        encryptionMode: raw.encryptionMode === 'plain' ? 'plain' : raw.encryptionMode === 'e2ee' ? 'e2ee' : undefined,
        metadata,
        metadataVersion,
        agentState: coerceStringPayload(raw.agentState),
        agentStateVersion,
        lastViewedSessionSeq: readNullableNumber(raw.lastViewedSessionSeq),
        // Server-materialized unread entry fact. It is the only value that is
        // identical on every device and across boots, so the transport must not
        // drop it: without it every client falls back to a local stamp and the
        // attention lane re-sorts per device.
        unreadSince: readNullableNumber(raw.unreadSince),
        pendingPermissionRequestCount: readNumber(raw.pendingPermissionRequestCount) ?? undefined,
        pendingUserActionRequestCount: readNumber(raw.pendingUserActionRequestCount) ?? undefined,
        pendingRequestObservedAt: readNullableNumber(raw.pendingRequestObservedAt),
        latestReadyEventSeq: readNullableNumber(raw.latestReadyEventSeq),
        latestReadyEventAt: readNullableNumber(raw.latestReadyEventAt),
        latestTurnId: readNullableString(raw.latestTurnId),
        latestTurnStatus: raw.latestTurnStatus === 'in_progress'
            || raw.latestTurnStatus === 'completed'
            || raw.latestTurnStatus === 'cancelled'
            || raw.latestTurnStatus === 'failed'
                ? raw.latestTurnStatus
                : raw.latestTurnStatus === null
                    ? null
                    : undefined,
        latestTurnStatusObservedAt: readNullableNumber(raw.latestTurnStatusObservedAt),
        runtimeActivityState: runtimeActivityProjection.runtimeActivityState,
        runtimeActivityRevision: runtimeActivityProjection.runtimeActivityRevision,
        runtimeActivityActiveCount: runtimeActivityProjection.runtimeActivityActiveCount,
        runtimeActivityObservedAt: runtimeActivityProjection.runtimeActivityObservedAt,
        lastRuntimeIssue: raw.lastRuntimeIssue === null
            || (raw.lastRuntimeIssue && typeof raw.lastRuntimeIssue === 'object')
                ? raw.lastRuntimeIssue as V2SessionRecord['lastRuntimeIssue']
                : undefined,
        rollbackEligibleTurnStarts,
        pendingCount: readNumber(raw.pendingCount) ?? undefined,
        pendingBlockedCount: readNumber(raw.pendingBlockedCount) ?? undefined,
        pendingVersion: readNumber(raw.pendingVersion) ?? undefined,
        pendingActivationAuthorization: PendingActivationAuthorizationV1Schema.safeParse(raw.pendingActivationAuthorization).data,
        thinking: readOptionalBoolean(raw.thinking),
        thinkingAt: readNumber(raw.thinkingAt) ?? undefined,
        dataEncryptionKey: readNullableString(raw.dataEncryptionKey) ?? null,
        share:
            shareAccessLevel && typeof shareCanApprovePermissions === 'boolean'
                ? {
                    accessLevel: shareAccessLevel === 'view' || shareAccessLevel === 'edit' || shareAccessLevel === 'admin'
                        ? shareAccessLevel
                        : 'view',
                    canApprovePermissions: shareCanApprovePermissions,
                }
                : null,
    };
}

function parseCompatSessionListResponse(raw: unknown, telemetryFields?: SyncPerformanceTelemetryFields): V2SessionListResponse | null {
    return syncPerformanceTelemetry.measure(
        'sync.sessions.snapshot.fetchPage.responseSchema',
        telemetryFields,
        () => parseCompatSessionListResponseValue(raw),
    );
}

function parseCompatSessionListResponseValue(raw: unknown): V2SessionListResponse | null {
    const parsed = V2SessionListResponseSchema.safeParse(raw);
    if (parsed.success) {
        const sessions = parsed.data.sessions.map((row) => coerceLegacySessionRecord(row));
        if (sessions.some((row) => row === null)) return null;
        return { ...parsed.data, sessions: sessions as V2SessionRecord[] };
    }

    if (!isRecord(raw) || !Array.isArray(raw.sessions)) {
        return null;
    }

    const sessions = raw.sessions.map((row) => coerceLegacySessionRecord(row));
    if (sessions.some((row) => row === null)) {
        return null;
    }

    return {
        sessions: sessions as V2SessionRecord[],
        nextCursor: typeof raw.nextCursor === 'string' ? raw.nextCursor : null,
        hasNext: typeof raw.hasNext === 'boolean' ? raw.hasNext : undefined,
    };
}

export function parseCompatSessionByIdResponse(raw: unknown): { session: V2SessionRecord } | null {
    if (isRecord(raw) && isRecord(raw.session)) {
        const parsed = V2SessionListResponseSchema.safeParse({ sessions: [raw.session] });
        if (parsed.success && parsed.data.sessions[0]) {
            const coerced = coerceLegacySessionRecord(parsed.data.sessions[0]);
            return coerced ? { session: coerced } : null;
        }

        const coerced = coerceLegacySessionRecord(raw.session);
        if (coerced) {
            return { session: coerced };
        }
    }

    return null;
}

function throwSessionListHttpError(status: number, routeLabel: string): never {
    if (status === 401 || status === 403) {
        throw createNotAuthenticatedError();
    }
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        throw new HappyError(`Failed to fetch sessions (${status})`, false);
    }
    throw new Error(`Failed to fetch ${routeLabel}: ${status}`);
}

/**
 * Whether a requested list path IS the `/v2/sessions` route rather than a sibling under it.
 *
 * Route identity is the path; the query string only selects which row families the route merges.
 * Comparing the whole string silently disabled the `/v1/sessions` fallback for every initial page
 * that carries a flag, while a sibling route such as `/v2/sessions/active` must never be diverted
 * to the legacy list.
 */
function isV2SessionsListRoute(sessionListPath: string): boolean {
    return sessionListPath === '/v2/sessions' || sessionListPath.startsWith('/v2/sessions?');
}

function looksLikeMissingV2SessionsListRoute(status: number, body: unknown): boolean {
    if (status === 404 || status === 405 || status === 501) {
        return true;
    }
    if (!body || typeof body !== 'object') {
        return false;
    }

    const record = body as Record<string, unknown>;
    const error = typeof record.error === 'string' ? record.error : '';
    const path = typeof record.path === 'string' ? record.path : '';
    const message = typeof record.message === 'string' ? record.message : '';
    if (error !== 'Not found') {
        return false;
    }
    return path.includes('/v2/sessions') || message.includes('/v2/sessions');
}

export function looksLikeMissingV2SessionRoute404(body: unknown, sessionId: string): boolean {
    if (!body || typeof body !== 'object') return false;
    const record = body as Record<string, unknown>;
    const error = typeof record.error === 'string' ? record.error : '';
    const path = typeof record.path === 'string' ? record.path : '';
    const message = typeof record.message === 'string' ? record.message : '';
    if (error !== 'Not found') return false;
    const encodedSessionId = encodeURIComponent(sessionId);
    return path.includes(`/v2/sessions/${sessionId}`)
        || path.includes(`/v2/sessions/${encodedSessionId}`)
        || message.includes(`/v2/sessions/${sessionId}`)
        || message.includes(`/v2/sessions/${encodedSessionId}`);
}

export function looksLikeCurrentV2SessionNotFound404(body: unknown): boolean {
    return V2SessionByIdNotFoundSchema.safeParse(body).success;
}

/**
 * `includedActiveRows` reports whether the server merged the active-session row family into this
 * response, which it advertises with a top-level `includedActive: true` on the initial page.
 *
 * The advertisement is what makes `includeActive=true` negotiable at all: an older server drops an
 * unknown query parameter in its zod querystring schema and answers with a perfectly valid page that
 * is simply missing those rows, so absence of the rows proves nothing (an account can legitimately
 * have none). `V2SessionListResponseSchema` is `.passthrough()`, so the marker rides the existing
 * response without a format change and older clients never see it.
 */
type SessionListPageRequest = Readonly<{
    request: SessionRequest;
    token: string;
    sessionListPath?: string;
    serverUrl?: string;
    cursor?: string | null;
    limit: number;
    telemetryFields?: SyncPerformanceTelemetryFields;
}>;
type SessionListPage = {
    sessions: V2SessionListResponse['sessions'];
    nextCursor: string | null;
    hasNext: boolean | undefined;
    source: 'v2' | 'v1';
    includedActiveRows: boolean;
};

/**
 * nginx's default large_client_header_buffers permits an 8 KiB request line, smaller than Node's
 * 16 KiB header budget. Count the encoded target, reader-support query added by the HTTP adapter,
 * and HTTP/1.1 framing; an ID count cannot express that boundary.
 * https://nginx.org/en/docs/http/ngx_http_core_module.html#large_client_header_buffers
 */
const SESSION_LIST_REQUEST_LINE_BYTES = 8 * 1024;

export async function fetchSessionListPageCompat(params: SessionListPageRequest & Readonly<{
    requiredSessionIds?: readonly string[];
    requiredOnly?: boolean;
}>): Promise<SessionListPage> {
    const requiredSessionIds = normalizeSessionListHydrationSessionIds(params.requiredSessionIds);
    if (requiredSessionIds.length === 0) {
        if (params.requiredOnly) {
            return { sessions: [], nextCursor: null, hasNext: false, source: 'v2', includedActiveRows: false };
        }
        return fetchSessionListPageRequest(params);
    }

    const buildPath = (ids: readonly string[], requiredOnly: boolean): string => {
        const url = new URL(params.sessionListPath || '/v2/sessions', 'http://placeholder.local');
        url.searchParams.set('limit', String(params.limit));
        url.searchParams.set('requiredSessionIds', JSON.stringify(ids));
        if (requiredOnly) {
            url.searchParams.set('requiredOnly', 'true');
            url.searchParams.delete('includeActive');
            url.searchParams.delete('includeAttention');
            url.searchParams.delete('cursor');
        } else if (params.cursor) {
            url.searchParams.set('cursor', params.cursor);
        }
        return url.pathname + url.search;
    };
    const fitsRequestLine = (ids: readonly string[], requiredOnly: boolean): boolean => {
        const requestUrl = new URL(withConnectedServiceReaderSupport(
            `${params.serverUrl ?? 'http://placeholder.local'}${buildPath(ids, requiredOnly)}`,
        ));
        // URL serialisation percent-encodes non-ASCII input, so every character here is one byte.
        return `GET ${requestUrl.pathname}${requestUrl.search} HTTP/1.1\r\n`.length
            <= SESSION_LIST_REQUEST_LINE_BYTES;
    };
    const chunks: string[][] = [];
    let chunk: string[] = [];
    for (const sessionId of requiredSessionIds) {
        const requiredOnly = params.requiredOnly === true || chunks.length > 0;
        if (!fitsRequestLine([...chunk, sessionId], requiredOnly)) {
            // A long identifier may fit a required-only request but not the larger account query.
            // Keep the account page as the first request, then carry that ID in the overflow family.
            if (chunk.length > 0 || !requiredOnly) chunks.push(chunk);
            chunk = [];
            if (!fitsRequestLine([sessionId], params.requiredOnly === true || chunks.length > 0)) {
                throw new HappyError('A required session identifier exceeds the HTTP request-line limit', false);
            }
        }
        chunk.push(sessionId);
    }
    if (chunk.length > 0) chunks.push(chunk);

    let firstPage: SessionListPage | undefined;
    const sessions: V2SessionListResponse['sessions'] = [];
    const seen = new Set<string>();
    const requestedIds = new Set(requiredSessionIds);
    for (const [index, chunkIds] of chunks.entries()) {
        const ids = chunkIds.filter((id) => !seen.has(id));
        // The ordinary families may already cover later chunks. Keep the first account read even
        // when its required family is empty, but never re-download rows supplied by that read.
        if (index > 0 && ids.length === 0) continue;
        const requiredOnly = params.requiredOnly === true || index > 0;
        const page = await fetchSessionListPageRequest({
            ...params,
            sessionListPath: buildPath(ids, requiredOnly),
            cursor: requiredOnly ? null : params.cursor,
        });
        firstPage ??= page;
        for (const row of page.sessions) {
            // Old relays ignore both new query keys. Their ordinary rows never become authority for
            // a targeted read; omitted IDs still take the caller's exact, outcome-aware fallback.
            if ((requiredOnly && !requestedIds.has(row.id)) || seen.has(row.id)) continue;
            seen.add(row.id);
            sessions.push(row);
        }
    }
    return {
        sessions,
        nextCursor: params.requiredOnly ? null : firstPage!.nextCursor,
        hasNext: params.requiredOnly ? false : firstPage!.hasNext,
        source: firstPage!.source,
        includedActiveRows: params.requiredOnly ? false : firstPage!.includedActiveRows,
    };
}

async function fetchSessionListPageRequest(params: SessionListPageRequest): Promise<SessionListPage> {
    const sessionListPath = params.sessionListPath || '/v2/sessions';
    const url = new URL(sessionListPath, 'http://placeholder.local');
    url.searchParams.set('limit', String(params.limit));
    if (params.cursor) {
        url.searchParams.set('cursor', params.cursor);
    }

    let v2ResponseChars: number | undefined;
    const v2Response = await syncPerformanceTelemetry.measureAsync(
        'sync.sessions.snapshot.fetchPage.request',
        params.telemetryFields,
        async () => params.request(url.pathname + url.search, {
            headers: buildSessionRequestHeaders(params.token, { includeSessionListTiming: true }),
        }),
    );
    const v2TelemetryFields = {
        ...(params.telemetryFields ?? {}),
        ...readV2SessionsServerTimingFields(v2Response),
    };
    const v2Body = await readJsonSafe(v2Response, {
        telemetryNamePrefix: 'sync.sessions.snapshot.fetchPage',
        fields: v2TelemetryFields,
        onResponseChars: (responseChars) => {
            v2ResponseChars = responseChars;
        },
    });
    const v2ParseFields = typeof v2ResponseChars === 'number'
        ? { ...v2TelemetryFields, responseChars: v2ResponseChars }
        : v2TelemetryFields;

    if (v2Response.ok) {
        const parsed = parseCompatSessionListResponse(v2Body, v2ParseFields);
        if (parsed) {
            return {
                sessions: parsed.sessions,
                nextCursor: typeof parsed.nextCursor === 'string' ? parsed.nextCursor : null,
                hasNext: parsed.hasNext,
                source: 'v2',
                includedActiveRows: parsed.includedActive === true,
            };
        }
    } else if (!isV2SessionsListRoute(sessionListPath) || !looksLikeMissingV2SessionsListRoute(v2Response.status, v2Body)) {
        throwSessionListHttpError(v2Response.status, sessionListPath);
    }

    const legacyResponse = await params.request('/v1/sessions', {
        headers: buildSessionRequestHeaders(params.token),
    });
    if (!legacyResponse.ok) {
        throwSessionListHttpError(legacyResponse.status, '/v1/sessions');
    }

    let legacyResponseChars: number | undefined;
    const legacyBody = await readJsonSafe(legacyResponse, {
        telemetryNamePrefix: 'sync.sessions.snapshot.fetchPage',
        fields: params.telemetryFields,
        onResponseChars: (responseChars) => {
            legacyResponseChars = responseChars;
        },
    });
    const legacyParseFields = typeof legacyResponseChars === 'number'
        ? { ...(params.telemetryFields ?? {}), responseChars: legacyResponseChars }
        : params.telemetryFields;
    const parsedLegacy = parseCompatSessionListResponse(legacyBody, legacyParseFields);
    if (!parsedLegacy) {
        throw new Error('Invalid /v1/sessions response');
    }

    return {
        sessions: parsedLegacy.sessions,
        nextCursor: null,
        hasNext: false,
        source: 'v1',
        includedActiveRows: false,
    };
}

export async function scanSessionByIdFromCompatList(params: Readonly<{
    request: SessionRequest;
    token: string;
    sessionId: string;
    limit?: number;
}>): Promise<V2SessionRecord | null> {
    const limit = typeof params.limit === 'number' && params.limit > 0 ? Math.trunc(params.limit) : 200;
    let cursor: string | null = null;
    const seenCursors = new Set<string>();

    while (true) {
        const page = await fetchSessionListPageCompat({
            request: params.request,
            token: params.token,
            cursor,
            limit,
        });
        const match = page.sessions.find((row) => String(row.id ?? '').trim() === params.sessionId);
        if (match) {
            return match;
        }
        if (!page.hasNext || !page.nextCursor) {
            return null;
        }
        if (seenCursors.has(page.nextCursor)) {
            return null;
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
    }
}
