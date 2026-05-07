import {
    V2SessionListResponseSchema,
    V2SessionByIdNotFoundSchema,
    type V2SessionListResponse,
    type V2SessionRecord,
} from '@happier-dev/protocol';

import { createNotAuthenticatedError } from '@/sync/runtime/connectivity/authErrors';
import {
    syncPerformanceTelemetry,
    type SyncPerformanceTelemetryFields,
} from '@/sync/runtime/syncPerformanceTelemetry';
import { HappyError } from '@/utils/errors/errors';

type SessionRequest = (path: string, init: RequestInit) => Promise<Response>;
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

function buildSessionRequestHeaders(token: string): HeadersInit {
    return {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
    };
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

    return {
        id,
        seq,
        createdAt,
        updatedAt,
        active,
        activeAt,
        archivedAt: readNullableNumber(raw.archivedAt),
        encryptionMode: raw.encryptionMode === 'plain' ? 'plain' : raw.encryptionMode === 'e2ee' ? 'e2ee' : undefined,
        metadata,
        metadataVersion,
        agentState: coerceStringPayload(raw.agentState),
        agentStateVersion,
        lastViewedSessionSeq: readNullableNumber(raw.lastViewedSessionSeq),
        pendingPermissionRequestCount: readNumber(raw.pendingPermissionRequestCount) ?? undefined,
        pendingUserActionRequestCount: readNumber(raw.pendingUserActionRequestCount) ?? undefined,
        pendingCount: readNumber(raw.pendingCount) ?? undefined,
        pendingVersion: readNumber(raw.pendingVersion) ?? undefined,
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
        return parsed.data;
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
        hasNext: raw.hasNext === true,
    };
}

export function parseCompatSessionByIdResponse(raw: unknown): { session: V2SessionRecord } | null {
    if (isRecord(raw) && isRecord(raw.session)) {
        const parsed = V2SessionListResponseSchema.safeParse({ sessions: [raw.session] });
        if (parsed.success && parsed.data.sessions[0]) {
            return { session: parsed.data.sessions[0] };
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

export async function fetchSessionListPageCompat(params: Readonly<{
    request: SessionRequest;
    token: string;
    sessionListPath?: string;
    cursor?: string | null;
    limit: number;
    telemetryFields?: SyncPerformanceTelemetryFields;
}>): Promise<{
    sessions: V2SessionListResponse['sessions'];
    nextCursor: string | null;
    hasNext: boolean;
    source: 'v2' | 'v1';
}> {
    const sessionListPath = params.sessionListPath || '/v2/sessions';
    const url = new URL(sessionListPath, 'http://placeholder.local');
    url.searchParams.set('limit', String(params.limit));
    if (params.cursor) {
        url.searchParams.set('cursor', params.cursor);
    }

    let v2ResponseChars: number | undefined;
    const v2Response = await params.request(url.pathname + url.search, {
        headers: buildSessionRequestHeaders(params.token),
    });
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
                hasNext: parsed.hasNext === true,
                source: 'v2',
            };
        }
    } else if (sessionListPath !== '/v2/sessions' || !looksLikeMissingV2SessionsListRoute(v2Response.status, v2Body)) {
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
