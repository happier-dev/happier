import { PendingActivationAuthorizationV1Schema } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import { SessionAccessAccountSummaryV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessPrincipalV1';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { V2SessionListResponseSchema, V2SessionRecordSchema, V2SessionByIdNotFoundSchema, type V2SessionListResponse } from '@happier-dev/protocol/sessions/control/contract';
import { parseSessionRuntimeActivityProjectionFields } from '@happier-dev/protocol/sessions/runtime/activity/sessionRuntimeActivity';
import { buildSessionListServerQueryV1, type SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';

import { createNotAuthenticatedError } from '@/sync/runtime/connectivity/authErrors';
import {
    syncPerformanceTelemetry,
    type SyncPerformanceTelemetryFields,
} from '@/sync/runtime/syncPerformanceTelemetry';
import { HappyError } from '@/utils/errors/errors';

type SessionRequest = (path: string, init: RequestInit) => Promise<Response>;
export type SessionListPageSource =
    | Readonly<{ kind: 'ordinary'; path: string; allowV1Fallback: boolean }>
    | Readonly<{ kind: 'query'; body: SessionListQueryV1; allowV1Fallback: false }>;

export const DEFAULT_SESSION_LIST_PATH = '/v2/sessions';

/**
 * The one answer to "which ordinary list resource does this read address".
 * Ordinary and archived reads address different resources. Cancellation belongs
 * to each acquisition's caller and is independent of this route selection.
 */
export function resolveSessionListRequestPath(params: Readonly<{
    source?: SessionListPageSource;
    sessionListPath?: string;
}>): string {
    const source = params.source;
    if (source?.kind === 'ordinary') {
        return source.path.trim() || DEFAULT_SESSION_LIST_PATH;
    }
    return typeof params.sessionListPath === 'string' && params.sessionListPath.trim().length > 0
        ? params.sessionListPath.trim()
        : DEFAULT_SESSION_LIST_PATH;
}
type V2SessionRecord = V2SessionListResponse['sessions'][number];
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

/**
 * Current access is an explicit authority projection, even when its payload is malformed.
 * Consumers use this marker — through the exported
 * `hasExplicitCurrentOrResponsibilitySessionProjection` below — to fail closed instead of
 * retrying the same response through a released-shape fallback that has no way to preserve
 * or validate current access semantics.
 */
function hasCurrentSessionRecordMarker(value: unknown): boolean {
    return isRecord(value) && (
        Object.prototype.hasOwnProperty.call(value, 'effectiveAccess')
        || Object.prototype.hasOwnProperty.call(value, 'viewer')
        || value.metadataLayoutVersion === 1
        || Object.prototype.hasOwnProperty.call(value, 'ownerMetadata')
    );
}

function hasResponsibilityProjectionClaim(value: unknown): boolean {
    return isRecord(value) && (
        Object.prototype.hasOwnProperty.call(value, 'responsibleAccountId')
        || Object.prototype.hasOwnProperty.call(value, 'responsibleAccount')
    );
}

export function hasExplicitCurrentOrResponsibilitySessionProjection(value: unknown): boolean {
    if (!isRecord(value) || !isRecord(value.session)) return false;
    return hasCurrentSessionRecordMarker(value.session) || hasResponsibilityProjectionClaim(value.session);
}

function hasExplicitCurrentOrResponsibilitySessionListProjection(value: unknown): boolean {
    return isRecord(value) && Array.isArray(value.sessions)
        && value.sessions.some(entry => hasCurrentSessionRecordMarker(entry) || hasResponsibilityProjectionClaim(entry));
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNonNegativeInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : undefined;
}

function readNullableNumber(value: unknown): number | null | undefined {
    if (value == null) return null;
    return readNumber(value);
}

function readNonNegativeNumberArray(value: unknown): number[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const numbers: number[] = [];
    for (const entry of value) {
        const number = readNumber(entry);
        if (number == null || number < 0) continue;
        numbers.push(Math.trunc(number));
    }
    return numbers;
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

function readRuntimeActivityProjectionFields(
    value: unknown,
): Pick<
    V2SessionRecord,
    'runtimeActivityState'
    | 'runtimeActivityActiveCount'
    | 'runtimeActivityObservedAt'
    | 'runtimeActivityRevision'
> | null {
    const parsed = parseSessionRuntimeActivityProjectionFields(value);
    if (parsed.kind !== 'valid') return null;
    return {
        runtimeActivityState: parsed.projection.state,
        runtimeActivityActiveCount: parsed.projection.activeCount,
        runtimeActivityObservedAt: parsed.projection.observedAt,
        runtimeActivityRevision: parsed.projection.revision,
    };
}

const EXTERNAL_SESSION_STORAGE_STATES: ReadonlySet<string> = new Set([
    'machine_only',
    'server_partial',
    'snapshot_complete',
    'hosted',
    'legacy_external_unknown',
]);

/** The one reader of a wire storage state (HTTP records and the socket `new-session` body). */
export function readExternalSessionStorageState(value: unknown): V2SessionRecord['currentStorageState'] {
    return typeof value === 'string' && EXTERNAL_SESSION_STORAGE_STATES.has(value)
        ? value as V2SessionRecord['currentStorageState']
        : undefined;
}

function mergeCompatSessionAdditiveFields(session: V2SessionRecord, raw: unknown): V2SessionRecord {
    if (!isRecord(raw)) return session;
    const pendingBlockedCount = readNonNegativeInteger(raw.pendingBlockedCount);
    const runtimeActivity = readRuntimeActivityProjectionFields(raw);
    if (
        pendingBlockedCount === undefined
        && runtimeActivity === null
    ) {
        return session;
    }
    return {
        ...session,
        ...(pendingBlockedCount !== undefined ? { pendingBlockedCount } : {}),
        ...(runtimeActivity ?? {}),
    } as V2SessionRecord;
}

function mergeCompatSessionListAdditiveFields(
    response: V2SessionListResponse,
    raw: unknown,
): V2SessionListResponse {
    if (!isRecord(raw)) return response;
    const rawSessions = raw.sessions;
    if (!Array.isArray(rawSessions)) return response;
    let changed = false;
    const sessions = response.sessions.map((session, index) => {
        const merged = mergeCompatSessionAdditiveFields(session, rawSessions[index]);
        if (merged !== session) changed = true;
        return merged;
    });
    const attentionNextCursor = readNullableString(raw.attentionNextCursor);
    const attentionHasNext = readOptionalBoolean(raw.attentionHasNext);
    if (
        attentionNextCursor !== undefined
        && attentionNextCursor !== response.attentionNextCursor
    ) {
        changed = true;
    }
    if (
        attentionHasNext !== undefined
        && attentionHasNext !== response.attentionHasNext
    ) {
        changed = true;
    }
    return changed
        ? {
            ...response,
            sessions,
            ...(attentionNextCursor !== undefined ? { attentionNextCursor } : {}),
            ...(attentionHasNext !== undefined ? { attentionHasNext } : {}),
        }
        : response;
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
    if (
        (
            raw.metadataLayoutVersion !== undefined
            && raw.metadataLayoutVersion !== 0
        )
        || raw.ownerMetadata !== undefined
        // An explicit private projection is never a legacy row. In particular,
        // malformed Follow/read facts cannot fall through and revive shared reads.
        || raw.viewer !== undefined
        // Marked access is current authority, never a candidate for legacy coercion.
        || raw.effectiveAccess !== undefined
    ) {
        return null;
    }

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
    const pendingActivationAuthorization = PendingActivationAuthorizationV1Schema.safeParse(
        raw.pendingActivationAuthorization,
    );
    // Absence is the released pre-mode Session shape and remains a supported
    // E2EE compatibility input. An explicit unknown value is different: it is
    // a malformed current producer claim and must not be collapsed into that
    // legacy omission merely because a key-shaped field is also present.
    if (Object.prototype.hasOwnProperty.call(raw, 'encryptionMode')
        && raw.encryptionMode !== 'plain'
        && raw.encryptionMode !== 'e2ee') {
        return null;
    }

    const coerced: V2SessionRecord = {
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
        // The guard above already rejected anything other than absent/0, so a coerced
        // record is a layout-0 record by construction; state that rather than leaving it absent.
        metadataLayoutVersion: 0,
        agentState: coerceStringPayload(raw.agentState),
        agentStateVersion,
        lastViewedSessionSeq: readNullableNumber(raw.lastViewedSessionSeq),
        unreadSince: readNullableNumber(raw.unreadSince),
        pendingPermissionRequestCount: readNumber(raw.pendingPermissionRequestCount) ?? undefined,
        pendingUserActionRequestCount: readNumber(raw.pendingUserActionRequestCount) ?? undefined,
        // Attention EDGE facts. Dropping these does not fail loudly: the placement key
        // silently falls back to `updatedAt`, which moves on every message to an
        // already-promoted session. Carried through the file's existing nullable readers.
        pendingRequestObservedAt: readNullableNumber(raw.pendingRequestObservedAt),
        latestTurnId: readNullableString(raw.latestTurnId) ?? null,
        latestReadyEventSeq: readNullableNumber(raw.latestReadyEventSeq),
        latestReadyEventAt: readNullableNumber(raw.latestReadyEventAt),
        thinking: readOptionalBoolean(raw.thinking),
        thinkingAt: readNullableNumber(raw.thinkingAt),
        currentStorageState: readExternalSessionStorageState(raw.currentStorageState),
        acceptedThroughServerSeq: readNullableNumber(raw.acceptedThroughServerSeq),
        materializedThroughSourceAt: readNullableNumber(raw.materializedThroughSourceAt),
        publishedThroughServerSeq: readNullableNumber(raw.publishedThroughServerSeq),
        transcriptShareable: readOptionalBoolean(raw.transcriptShareable),
        ...(pendingActivationAuthorization.success
            ? { pendingActivationAuthorization: pendingActivationAuthorization.data }
            : {}),
        // Absent stays absent: a legacy record that never carried responsibility
        // must not be coerced into an authoritative "unassigned".
        ...(Object.prototype.hasOwnProperty.call(raw, 'responsibleAccountId')
            ? { responsibleAccountId: raw.responsibleAccountId as string | null }
            : {}),
        // The paired summary is projected at read time; it is omitted exactly
        // when the id is omitted and never persisted as a second source.
        ...(Object.prototype.hasOwnProperty.call(raw, 'responsibleAccount')
            ? {
                responsibleAccount: SessionAccessAccountSummaryV1Schema.nullable().parse(raw.responsibleAccount),
              }
            : {}),
        latestTurnStatus: raw.latestTurnStatus === 'in_progress'
            || raw.latestTurnStatus === 'completed'
            || raw.latestTurnStatus === 'cancelled'
            || raw.latestTurnStatus === 'failed'
                ? raw.latestTurnStatus
                : raw.latestTurnStatus === null
                    ? null
                    : undefined,
        latestTurnStatusObservedAt: readNullableNumber(raw.latestTurnStatusObservedAt),
        rollbackEligibleTurnStarts: readNonNegativeNumberArray(raw.rollbackEligibleTurnStarts),
        lastRuntimeIssue: raw.lastRuntimeIssue === null
            || (raw.lastRuntimeIssue && typeof raw.lastRuntimeIssue === 'object')
                ? raw.lastRuntimeIssue as V2SessionRecord['lastRuntimeIssue']
                : undefined,
        ...(readRuntimeActivityProjectionFields(raw) ?? {}),
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
    const merged = mergeCompatSessionAdditiveFields(coerced, raw);
    const parsed = V2SessionRecordSchema.safeParse(merged);
    return parsed.success ? parsed.data : null;
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
        return mergeCompatSessionListAdditiveFields(parsed.data, raw);
    }

    if (!isRecord(raw) || !Array.isArray(raw.sessions)) {
        return null;
    }

    const sessions = raw.sessions.map((row) => coerceLegacySessionRecord(row));
    if (sessions.some((row) => row === null)) {
        return null;
    }

    return mergeCompatSessionListAdditiveFields({
        sessions: sessions as V2SessionRecord[],
        nextCursor: typeof raw.nextCursor === 'string' ? raw.nextCursor : null,
        hasNext: raw.hasNext === true,
    }, raw);
}

function hasUnsupportedExplicitSessionMetadataLayout(raw: unknown): boolean {
    if (!isRecord(raw) || !Array.isArray(raw.sessions)) return false;
    return raw.sessions.some((entry) =>
        isRecord(entry)
        && typeof entry.metadataLayoutVersion === 'number'
        && entry.metadataLayoutVersion !== 0
        && entry.metadataLayoutVersion !== 1,
    );
}

function hasExplicitNonLegacySessionMetadataEnvelope(raw: unknown): boolean {
    if (!isRecord(raw) || !Array.isArray(raw.sessions)) return false;
    return raw.sessions.some((entry) =>
        isRecord(entry)
        && (
            entry.metadataLayoutVersion === 1
            || entry.ownerMetadata !== undefined
        ),
    );
}

export function parseCompatSessionByIdResponse(raw: unknown): { session: V2SessionRecord } | null {
    if (isRecord(raw) && isRecord(raw.session)) {
        const parsed = V2SessionListResponseSchema.safeParse({ sessions: [raw.session] });
        if (parsed.success && parsed.data.sessions[0]) {
            return { session: mergeCompatSessionAdditiveFields(parsed.data.sessions[0], raw.session) };
        }

        const coerced = coerceLegacySessionRecord(raw.session);
        if (coerced) {
            return { session: coerced };
        }
    }

    return null;
}

function readSessionListHttpErrorCode(body: unknown): string | undefined {
    if (!isRecord(body)) return undefined;
    const code = readOptionalString(body.errorCode) ?? readOptionalString(body.code);
    return code?.trim() || undefined;
}

function throwSessionListHttpError(status: number, routeLabel: string, body?: unknown): never {
    if (status === 401 || status === 403) {
        throw createNotAuthenticatedError(status);
    }
    const code = readSessionListHttpErrorCode(body);
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        throw new HappyError(`Failed to fetch sessions (${status})`, false, {
            status,
            kind: 'server',
            ...(code ? { code } : {}),
        });
    }
    throw new HappyError(`Failed to fetch ${routeLabel}: ${status}`, true, {
        status,
        kind: status >= 500 ? 'server' : 'network',
        ...(code ? { code } : {}),
    });
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

function readMetadataUpgradeRequiredCount(value: unknown): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

export async function fetchSessionListPageCompat(params: Readonly<{
    request: SessionRequest;
    token: string;
    source?: SessionListPageSource;
    sessionListPath?: string;
    cursor?: string | null;
    attentionCursor?: string | null;
    limit: number;
    allowLegacyV1Fallback?: boolean;
    telemetryFields?: SyncPerformanceTelemetryFields;
}>): Promise<{
    sessions: V2SessionListResponse['sessions'];
    nextCursor: string | null;
    hasNext: boolean;
    attentionNextCursor: string | null;
    attentionHasNext: boolean;
    /** Rows the Home selected but withheld pending their owner's metadata upgrade. */
    metadataUpgradeRequiredCount: number;
    source: 'v2' | 'v1';
}> {
    const source = params.source;
    const isQuery = source?.kind === 'query';
    const allowLegacyV1Fallback = isQuery
        ? false
        : source?.kind === 'ordinary'
            ? source.allowV1Fallback
            : params.allowLegacyV1Fallback !== false;
    const sessionListPath = resolveSessionListRequestPath(params);
    const requestPath = (() => {
        if (isQuery) return '/v2/sessions/query';
        const url = new URL(sessionListPath, 'http://placeholder.local');
        url.searchParams.set('limit', String(params.limit));
        if (params.cursor) {
            url.searchParams.set('cursor', params.cursor);
        }
        if (params.attentionCursor) {
            url.searchParams.set('attentionCursor', params.attentionCursor);
        }
        return url.pathname + url.search;
    })();
    const requestInit = (() => {
        if (!isQuery) {
            return {
                headers: buildSessionRequestHeaders(params.token, { includeSessionListTiming: true }),
            } satisfies RequestInit;
        }
        const { cursor: _sourceCursor, attentionCursor: _sourceAttentionCursor, limit: _sourceLimit, ...queryBase } = buildSessionListServerQueryV1(source.body);
        const cursor = params.cursor !== undefined ? params.cursor : _sourceCursor ?? null;
        const attentionCursor = params.attentionCursor !== undefined
            ? params.attentionCursor
            : _sourceAttentionCursor ?? null;
        if (cursor && attentionCursor) {
            throw new HappyError('Session query cannot carry both cursor families', false, {
                kind: 'config',
                code: 'invalid_query',
            });
        }
        const body: SessionListQueryV1 = {
            ...queryBase,
            ...(cursor ? { cursor } : {}),
            ...(attentionCursor ? { attentionCursor } : {}),
            limit: params.limit,
        };
        return {
            method: 'POST',
            headers: buildSessionRequestHeaders(params.token, { includeSessionListTiming: true }),
            body: JSON.stringify(body),
        } satisfies RequestInit;
    })();

    const v2Response = await syncPerformanceTelemetry.measureAsync(
        'sync.sessions.snapshot.fetchPage.request',
        params.telemetryFields,
        async () => params.request(requestPath, requestInit),
    );
    const v2TelemetryFields = {
        ...(params.telemetryFields ?? {}),
        ...readV2SessionsServerTimingFields(v2Response),
    };
    let v2ResponseChars: number | undefined;
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
        if (isQuery) {
            const parsedQuery = syncPerformanceTelemetry.measure(
                'sync.sessions.snapshot.fetchPage.responseSchema',
                v2ParseFields,
                () => SessionListQueryResponseV1Schema.safeParse(v2Body),
            );
            if (!parsedQuery.success) {
                throw new HappyError('Invalid /v2/sessions/query response', false, {
                    code: 'invalid_response',
                });
            }
            return {
                sessions: parsedQuery.data.sessions,
                nextCursor: parsedQuery.data.nextCursor,
                hasNext: parsedQuery.data.hasNext,
                attentionNextCursor: parsedQuery.data.attentionNextCursor,
                attentionHasNext: parsedQuery.data.attentionHasNext,
                metadataUpgradeRequiredCount: parsedQuery.data.metadataUpgradeRequiredCount ?? 0,
                source: 'v2',
            };
        }
        const parsed = parseCompatSessionListResponse(v2Body, v2ParseFields);
        if (parsed) {
            return {
                sessions: parsed.sessions,
                nextCursor: typeof parsed.nextCursor === 'string' ? parsed.nextCursor : null,
                hasNext: parsed.hasNext === true,
                attentionNextCursor: typeof parsed.attentionNextCursor === 'string'
                    ? parsed.attentionNextCursor
                    : null,
                attentionHasNext: parsed.attentionHasNext === true,
                metadataUpgradeRequiredCount: readMetadataUpgradeRequiredCount(
                    parsed.metadataUpgradeRequiredCount ?? (isRecord(v2Body) ? v2Body.metadataUpgradeRequiredCount : undefined),
                ),
                source: 'v2',
            };
        }
        if (hasUnsupportedExplicitSessionMetadataLayout(v2Body)) {
            throw new HappyError('Unsupported Session metadata layout', false, { code: 'invalid_response' });
        }
        if (hasExplicitNonLegacySessionMetadataEnvelope(v2Body)) {
            throw new HappyError('Invalid layout-1 Session metadata response', false, { code: 'invalid_response' });
        }
        if (hasExplicitCurrentOrResponsibilitySessionListProjection(v2Body)) {
            throw new HappyError('Invalid current Session projection', false, { code: 'invalid_response' });
        }
        if (!allowLegacyV1Fallback) {
            throw new HappyError('Invalid /v2/sessions response for session-by-id lookup', false, { code: 'invalid_response' });
        }
    } else if (isQuery || !looksLikeMissingV2SessionsListRoute(v2Response.status, v2Body)) {
        throwSessionListHttpError(v2Response.status, requestPath, v2Body);
    }

    if (!allowLegacyV1Fallback) {
        throw new Error('Legacy /v1/sessions fallback is not exhaustive enough for session-by-id lookup');
    }

    const legacyResponse = await params.request('/v1/sessions', {
        headers: buildSessionRequestHeaders(params.token),
    });
    let legacyResponseChars: number | undefined;
    const legacyBody = await readJsonSafe(legacyResponse, {
        telemetryNamePrefix: 'sync.sessions.snapshot.fetchPage',
        fields: params.telemetryFields,
        onResponseChars: (responseChars) => {
            legacyResponseChars = responseChars;
        },
    });
    if (!legacyResponse.ok) {
        throwSessionListHttpError(legacyResponse.status, '/v1/sessions', legacyBody);
    }
    const legacyParseFields = typeof legacyResponseChars === 'number'
        ? { ...(params.telemetryFields ?? {}), responseChars: legacyResponseChars }
        : params.telemetryFields;
    const parsedLegacy = parseCompatSessionListResponse(legacyBody, legacyParseFields);
    if (!parsedLegacy) {
        throw new HappyError('Invalid /v1/sessions response', false, { code: 'invalid_response' });
    }

    return {
        sessions: parsedLegacy.sessions,
        nextCursor: null,
        hasNext: false,
        attentionNextCursor: null,
        attentionHasNext: false,
        metadataUpgradeRequiredCount: 0,
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
            allowLegacyV1Fallback: true,
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
