import { SessionListQueryResponseV1Schema, type SessionListQueryResponseV1 } from '@happier-dev/protocol/sessions/listing/response';
import { V2SessionListResponseSchema, V2SessionRecordSchema, V2SessionByIdNotFoundSchema, type V2SessionListResponse, type V2SessionRecord } from '@happier-dev/protocol/sessions/control/contract';
import { parseSessionRuntimeActivityProjectionFields } from '@happier-dev/protocol/sessions/runtime/activity/sessionRuntimeActivity';
import { buildSessionListServerQueryV1, type SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import { withSessionOwnerMetadataCiphertextValidationReuseV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

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
 * List readers use this marker to fail closed instead of
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

function hasExplicitCurrentOrResponsibilitySessionListProjection(value: unknown): boolean {
    return isRecord(value) && Array.isArray(value.sessions)
        && value.sessions.some(entry => hasCurrentSessionRecordMarker(entry) || hasResponsibilityProjectionClaim(entry));
}

function readNonNegativeInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : undefined;
}

function readOptionalString(value: unknown): string | undefined {
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

function parseCompatSessionListResponse(raw: unknown, telemetryFields?: SyncPerformanceTelemetryFields): V2SessionListResponse | null {
    return syncPerformanceTelemetry.measure(
        'sync.sessions.snapshot.fetchPage.responseSchema',
        telemetryFields,
        () => parseCompatSessionListResponseValue(raw),
    );
}

function parseCompatSessionListResponseValue(raw: unknown): V2SessionListResponse | null {
    const parsed = V2SessionListResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
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
        const parsed = V2SessionRecordSchema.safeParse(raw.session);
        if (parsed.success) {
            return { session: mergeCompatSessionAdditiveFields(parsed.data, raw.session) };
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
    getPreviousOwnerMetadataEnvelope?: (sessionId: string) => unknown;
}>): Promise<{
    sessions: V2SessionListResponse['sessions'];
    nextCursor: string | null;
    hasNext: boolean;
    attentionNextCursor: string | null;
    attentionHasNext: boolean;
    /** Rows the Home selected but withheld pending their owner's metadata upgrade. */
    metadataUpgradeRequiredCount: number;
    membershipUnavailableReason?: SessionListQueryResponseV1['membershipUnavailableReason'];
    source: 'v2' | 'v1';
}> {
    const source = params.source;
    const isQuery = source?.kind === 'query';
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
                // Each logical list acquisition owns its freshness/retirement fence.
                // Do not inherit an older in-flight response after that read is invalidated.
                // Equivalent Sync snapshots still share through their owning acquisition.
                cache: 'no-store',
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
    const previousOwnerEnvelopes = isRecord(v2Body) && Array.isArray(v2Body.sessions)
        ? v2Body.sessions.flatMap(row => isRecord(row) && typeof row.id === 'string'
            ? [params.getPreviousOwnerMetadataEnvelope?.(row.id)] : [])
        : [];

    if (v2Response.ok) {
        if (isQuery) {
            const parsedQuery = syncPerformanceTelemetry.measure(
                'sync.sessions.snapshot.fetchPage.responseSchema',
                v2ParseFields,
                () => withSessionOwnerMetadataCiphertextValidationReuseV1(previousOwnerEnvelopes,
                    () => SessionListQueryResponseV1Schema.safeParse(v2Body)),
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
                membershipUnavailableReason: parsedQuery.data.membershipUnavailableReason,
                source: 'v2',
            };
        }
        const parsed = withSessionOwnerMetadataCiphertextValidationReuseV1(previousOwnerEnvelopes,
            () => parseCompatSessionListResponse(v2Body, v2ParseFields));
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
        throw new HappyError('Invalid /v2/sessions response', false, { code: 'invalid_response' });
    }
    throwSessionListHttpError(v2Response.status, requestPath, v2Body);
}
