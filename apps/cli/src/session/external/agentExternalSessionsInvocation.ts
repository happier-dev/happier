import { createHash } from 'node:crypto';

import {
    AgentExternalSessionTranscriptRawRecordSchema,
    ExternalSessionTranscriptItemIdV1Schema,
    ExternalSessionTranscriptSourceTimestampV1Schema,
    ExternalSessionUserProjectionSchema,
    ExternalSessionsSourceSchema,
    MAX_EXTERNAL_SESSIONS_SOURCE_KIND_CODE_UNITS,
    MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES,
    PluginAgentExternalSessionLinkDataSchema,
    resolveTranscriptBodySemanticEvent,
    SessionMessageRoleSchema,
    SidechainIdSchema,
    type AgentExternalSessionTranscriptRawRecord,
    type PluginAgentExternalSessionLinkData,
    type SessionMessageRole,
} from '@happier-dev/protocol';
import type {
    AgentExternalSessionTranscriptItem,
    AgentExternalSessionsContribution,
    AgentExternalSessionsFailureCode,
    AgentExternalSessionsManagedEndpointRead,
    AgentExternalSessionsReadAfterDiagnostic,
    AgentExternalSessionsResult,
} from '@happier-dev/plugin-sdk/sessions/external';
import { isAgentExternalSessionsFailureCode } from '@happier-dev/plugin-sdk/sessions/external';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type {
    AgentExternalSessionCandidate,
    AgentExternalSessionSource,
    AgentExternalSessionsListCandidatesResult,
    AgentExternalSessionsReadAfterTranscriptResult,
    AgentExternalSessionsResolveSourceResult,
    AgentExternalSessionsResolvedIdentity,
    AgentExternalSessionsTranscriptPage,
} from '@happier-dev/plugin-sdk/sessions/external';

import { measureSerializedValidatedStrictPluginJsonUtf8Bytes } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';

import {
    serializeManagedServiceEndpointReadRequestHeaders,
} from '@/agent/runtime/session/process/managedServiceEndpointReadHeaders';
import {
    filesystemPathComparisonKey,
    isFilesystemPathAbsolute,
    normalizeFilesystemPathForPolicy,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';

const MAX_ID_CODE_UNITS = 2_000;
const MAX_TITLE_CODE_UNITS = 10_000;
const MAX_SEARCH_CODE_UNITS = 2_000;
const MAX_FAILURE_MESSAGE_CODE_UNITS = 2_000;
const MAX_READ_AFTER_BOUNDARY_CODE_UNITS = 2_000;
const MAX_READ_AFTER_DIAGNOSTIC_CODE_UNITS = 128;
const MAX_READ_AFTER_DIAGNOSTICS = 32;
const MAX_READ_AFTER_DIAGNOSTIC_POSITIONS = 200;
const MAX_NATIVE_CURSOR_CODE_UNITS = 2_000;
const MAX_QUALIFIED_CURSOR_CODE_UNITS = 4_096;
const MAX_TRANSCRIPT_MEDIA_READ_ROOTS = 16;
const MAX_TRANSCRIPT_MEDIA_READ_ROOT_CODE_UNITS = 4_096;
export const EXTERNAL_SESSIONS_INVOCATION_POLICY = Object.freeze({
    deadlineMs: 15_000,
    resolveSource: Object.freeze({ maxSerializedBytes: 262_144 }),
    listCandidates: Object.freeze({ maxItems: 50, maxSerializedBytes: 1_048_576 }),
    resolveLinkIdentity: Object.freeze({ maxSerializedBytes: 262_144 }),
    resolveLinkedIdentity: Object.freeze({ maxSerializedBytes: 262_144 }),
    pageTranscript: Object.freeze({ maxItems: 200, maxSerializedBytes: 524_288 }),
    readAfterTranscript: Object.freeze({ maxItems: 200, maxSerializedBytes: 524_288 }),
    sourceKindMaxCodeUnits: MAX_EXTERNAL_SESSIONS_SOURCE_KIND_CODE_UNITS,
    idMaxCodeUnits: MAX_ID_CODE_UNITS,
    titleMaxCodeUnits: MAX_TITLE_CODE_UNITS,
    searchMaxCodeUnits: MAX_SEARCH_CODE_UNITS,
    failureMessageMaxCodeUnits: MAX_FAILURE_MESSAGE_CODE_UNITS,
    nativeCursorMaxCodeUnits: MAX_NATIVE_CURSOR_CODE_UNITS,
    qualifiedCursorMaxCodeUnits: MAX_QUALIFIED_CURSOR_CODE_UNITS,
    sourceMaxSerializedBytes: MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES,
});

type ContributionIdentity = Readonly<{
    pluginId: string;
    agentId: string;
    generation: string;
    contributionQualifiedId: string;
    immutableGenerationId: string | null;
}>;

export type AgentExternalSessionsManagedEndpointReadHost = (
    input: Readonly<{
        identity: ContributionIdentity;
        source: AgentExternalSessionSource;
        signal: AbortSignal;
    }>,
) => Promise<AgentExternalSessionsManagedEndpointRead>;

export function createUnavailableAgentExternalSessionsManagedEndpointRead(): AgentExternalSessionsManagedEndpointRead {
    return Object.freeze(async () => {
        throw new Error('Agent External Sessions managed endpoint read is unavailable');
    });
}

function readManagedEndpointResponseByteBudget(
    value: number | undefined,
): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(
            'Agent External Sessions managed endpoint response byte budget must be a positive safe integer',
        );
    }
    return value;
}

function createManagedEndpointResponseByteBudgetError(maxResponseBytes: number): Error {
    return new Error(
        `Agent External Sessions managed endpoint response exceeds its ${maxResponseBytes}-byte operation budget`,
    );
}

function boundManagedEndpointResponseBody(
    response: Awaited<ReturnType<AgentExternalSessionsManagedEndpointRead>>,
    maxResponseBytes: number | undefined,
): Awaited<ReturnType<AgentExternalSessionsManagedEndpointRead>> {
    if (maxResponseBytes === undefined || response.body === null) return response;

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = response.body.getReader();
    let settled = false;
    let readerReleased = false;
    let receivedBytes = 0;
    const releaseReader = (activeReader: ReadableStreamDefaultReader<Uint8Array>): void => {
        if (reader === activeReader) reader = null;
        if (readerReleased) return;
        readerReleased = true;
        activeReader.releaseLock();
    };
    const cancelReader = async (reason: unknown): Promise<void> => {
        if (settled) return;
        settled = true;
        const activeReader = reader;
        if (!activeReader) return;
        try {
            await activeReader.cancel(reason);
        } catch {
            // The operation budget remains authoritative even if the transport
            // cannot acknowledge cancellation.
        } finally {
            releaseReader(activeReader);
        }
    };
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            const activeReader = reader;
            if (!activeReader) {
                controller.close();
                return;
            }
            try {
                const result = await activeReader.read();
                if (result.done) {
                    settled = true;
                    releaseReader(activeReader);
                    controller.close();
                    return;
                }
                if (result.value.byteLength > maxResponseBytes - receivedBytes) {
                    const error = createManagedEndpointResponseByteBudgetError(
                        maxResponseBytes,
                    );
                    await cancelReader(error);
                    controller.error(error);
                    return;
                }
                receivedBytes += result.value.byteLength;
                controller.enqueue(result.value);
            } catch (error) {
                settled = true;
                releaseReader(activeReader);
                controller.error(error);
            }
        },
        async cancel(reason) {
            await cancelReader(reason);
        },
    });
    return Object.freeze({ ...response, body });
}

type WithoutHostStampedInvocationServices<T> = T extends unknown
    ? Omit<T, 'managedEndpointRead' | 'exec'>
    : never;

/**
 * Host-facing facade. The host supplies only the ordinary operation input; the
 * generation-bound owner stamps the capability into the plugin leaf request.
 */
export type BoundedAgentExternalSessionsContribution = Readonly<{
    [Method in keyof AgentExternalSessionsContribution]:
        AgentExternalSessionsContribution[Method] extends (
            request: infer Request,
        ) => infer Result
            ? (request: WithoutHostStampedInvocationServices<Request>) => Result
            : never;
}>;

export async function bindAgentExternalSessionsManagedEndpointRead(input: Readonly<{
    identity: ContributionIdentity;
    source: AgentExternalSessionSource;
    signal: AbortSignal;
    isCurrent(): boolean;
    retirementSignal: AbortSignal;
    host?: AgentExternalSessionsManagedEndpointReadHost;
    maxResponseBytes?: number;
}>): Promise<AgentExternalSessionsManagedEndpointRead> {
    const unavailable = createUnavailableAgentExternalSessionsManagedEndpointRead();
    const maxResponseBytes = readManagedEndpointResponseByteBudget(input.maxResponseBytes);
    if (!input.isCurrent() || input.retirementSignal.aborted) {
        return unavailable;
    }
    if (input.signal.aborted || !input.host) return unavailable;
    let exactRead: AgentExternalSessionsManagedEndpointRead;
    try {
        exactRead = await input.host({
            identity: input.identity,
            source: input.source,
            signal: input.signal,
        });
    } catch {
        return unavailable;
    }
    if (
        !input.isCurrent()
        || input.retirementSignal.aborted
        || input.signal.aborted
    ) return unavailable;
    return Object.freeze(async (request) => {
        if (!input.isCurrent() || input.retirementSignal.aborted) {
            throw new Error(
                'Agent External Sessions managed endpoint read belongs to a retired generation',
            );
        }
        if (input.signal.aborted) throw input.signal.reason;
        const requestHeaders = serializeManagedServiceEndpointReadRequestHeaders(
            request.headers,
        );
        const admittedRequest = request.headers === undefined
            ? request
            : Object.freeze({
                ...request,
                headers: requestHeaders,
            });
        if (!input.isCurrent() || input.retirementSignal.aborted) {
            throw new Error(
                'Agent External Sessions managed endpoint read belongs to a retired generation',
            );
        }
        if (input.signal.aborted) throw input.signal.reason;
        const response = await exactRead(admittedRequest);
        if (!input.isCurrent() || input.retirementSignal.aborted) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(
                'Agent External Sessions managed endpoint read belongs to a retired generation',
            );
        }
        if (input.signal.aborted) {
            await response.body?.cancel().catch(() => undefined);
            throw input.signal.reason;
        }
        return boundManagedEndpointResponseBody(response, maxResponseBytes);
    });
}

type CursorScope = Readonly<{
    method: 'listCandidates' | 'pageTranscript' | 'readAfterTranscript';
    source: AgentExternalSessionSource;
    remoteSessionId?: string;
}>;

type QualifiedCursorV1 = Readonly<{
    v: 1;
    p: string;
    a: string;
    g: string;
    s: string;
    m: CursorScope['method'];
    r: string | null;
    c: string;
}>;

type StrictRecord = Readonly<Record<string, unknown>>;

const invalidRequest = (): AgentExternalSessionsResult<never> => Object.freeze({
    ok: false,
    code: 'invalid_request',
    retryable: false,
});
const agentError = (): AgentExternalSessionsResult<never> => Object.freeze({
    ok: false,
    code: 'agent_error',
    retryable: false,
});
const cancelled = (): AgentExternalSessionsResult<never> => Object.freeze({
    ok: false,
    code: 'cancelled',
    retryable: false,
});
const unavailable = (): AgentExternalSessionsResult<never> => Object.freeze({
    ok: false,
    code: 'unavailable',
    retryable: true,
});
const timeout = (): AgentExternalSessionsResult<never> => Object.freeze({
    ok: false,
    code: 'timeout',
    retryable: true,
});

function readStrictRecord(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
): StrictRecord | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
        return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    try {
        for (const key of allowed) {
            Object.defineProperty(snapshot, key, {
                configurable: false,
                enumerable: true,
                writable: false,
                value: Reflect.get(value, key),
            });
        }
    } catch {
        return null;
    }
    return Object.freeze(snapshot);
}

/**
 * Protocol owns the external-session source grammar: the strict-JSON copy, the
 * bounded depth/entry/byte budget and the trimmed `kind` rule all live in
 * `ExternalSessionsSourceSchema`. This wrapper admits host- and
 * contribution-supplied sources through that one parser so every reader in the
 * corridor measures the same source the same way.
 */
function parseSource(value: unknown): AgentExternalSessionSource | null {
    const parsed = ExternalSessionsSourceSchema.safeParse(value);
    return parsed.success ? parsed.data as AgentExternalSessionSource : null;
}

function parseLinkData(value: unknown): PluginAgentExternalSessionLinkData | null {
    const parsed = PluginAgentExternalSessionLinkDataSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/**
 * Single admission point for current Agent-contribution transcript output.
 * Persisted Session history keeps its separate provenance-pinned compatibility
 * reader; current producers must emit this exact envelope.
 */
function parseTranscriptRawRecord(value: unknown): AgentExternalSessionTranscriptRawRecord | null {
    try {
        const parsed = AgentExternalSessionTranscriptRawRecordSchema.safeParse(value);
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function parseBoundedString(value: unknown, maximum: number, allowEmpty = false): string | null {
    return typeof value === 'string'
        && (allowEmpty || value.length > 0)
        && value.length <= maximum
        ? value
        : null;
}

/**
 * Plugin leaves may declare source-owned directories, but only the host owns
 * the later real-path authorization of a concrete media file. Snapshot this
 * bounded, platform-normalized evidence here so it cannot become link data or
 * a per-page metadata channel.
 */
function parseTranscriptMediaReadRoots(value: unknown): readonly string[] | undefined | null {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > MAX_TRANSCRIPT_MEDIA_READ_ROOTS) return null;
    const roots: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        const root = parseBoundedString(entry, MAX_TRANSCRIPT_MEDIA_READ_ROOT_CODE_UNITS);
        if (
            root === null
            || root.trim() !== root
            || root.includes('\0')
            || !isFilesystemPathAbsolute(root)
        ) {
            return null;
        }
        const normalized = normalizeFilesystemPathForPolicy(root);
        const key = filesystemPathComparisonKey(normalized);
        if (seen.has(key)) continue;
        seen.add(key);
        roots.push(normalized);
    }
    return Object.freeze(roots);
}

function parseOptionalSidechainId(value: unknown): string | null | undefined | false {
    if (value === undefined || value === null) return value;
    const parsed = SidechainIdSchema.safeParse(value);
    return parsed.success && typeof parsed.data === 'string' ? parsed.data : false;
}

function parseTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseOptionalBoolean(value: unknown): boolean | undefined | null {
    return value === undefined || typeof value === 'boolean' ? value : null;
}

function parseCandidate(value: unknown): AgentExternalSessionCandidate | null {
    const record = readStrictRecord(
        value,
        ['remoteSessionId', 'updatedAtMs'],
        ['title', 'createdAtMs', 'archived', 'linkData'],
    );
    if (!record) return null;
    const remoteSessionId = parseBoundedString(record.remoteSessionId, MAX_ID_CODE_UNITS);
    const updatedAtMs = parseTimestamp(record.updatedAtMs);
    const title = record.title === undefined
        ? undefined
        : parseBoundedString(record.title, MAX_TITLE_CODE_UNITS);
    const createdAtMs = record.createdAtMs === undefined ? undefined : parseTimestamp(record.createdAtMs);
    const archived = parseOptionalBoolean(record.archived);
    const linkData = record.linkData === undefined ? undefined : parseLinkData(record.linkData);
    if (
        remoteSessionId === null
        || updatedAtMs === null
        || title === null
        || (title !== undefined && title.trim().length === 0)
        || createdAtMs === null
        || archived === null
        || linkData === null
    ) {
        return null;
    }
    return Object.freeze({
        remoteSessionId,
        updatedAtMs,
        ...(title === undefined ? {} : { title }),
        ...(createdAtMs === undefined ? {} : { createdAtMs }),
        ...(archived === undefined ? {} : { archived }),
        ...(linkData === undefined ? {} : { linkData }),
    });
}

/** Transcript item identity is owned by Protocol so it cannot differ by execution placement. */
function parseTranscriptItemId(value: unknown): string | null {
    const parsed = ExternalSessionTranscriptItemIdV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function parseTranscriptItem(value: unknown): AgentExternalSessionTranscriptItem | null {
    const record = readStrictRecord(
        value,
        ['id', 'createdAtMs', 'raw'],
        ['localId', 'sidechainId', 'messageRole', 'userProjection'],
    );
    if (!record) return null;
    const id = parseTranscriptItemId(record.id);
    const parsedCreatedAtMs = ExternalSessionTranscriptSourceTimestampV1Schema
        .safeParse(record.createdAtMs);
    const createdAtMs = parsedCreatedAtMs.success ? parsedCreatedAtMs.data : null;
    const localId = record.localId === undefined || record.localId === null
        ? record.localId
        : parseTranscriptItemId(record.localId);
    const sidechainId = parseOptionalSidechainId(record.sidechainId);
    const role = record.messageRole === undefined || record.messageRole === null
        ? record.messageRole
        : SessionMessageRoleSchema.safeParse(record.messageRole).success
            ? record.messageRole as SessionMessageRole
            : false;
    const raw = parseTranscriptRawRecord(record.raw);
    const parsedUserProjection = record.userProjection === undefined
        ? undefined
        : ExternalSessionUserProjectionSchema.safeParse(record.userProjection);
    const userProjection = parsedUserProjection === undefined
        ? undefined
        : parsedUserProjection.success
            ? parsedUserProjection.data
            : null;
    const derivedRole = raw?.role === 'user'
        ? 'user'
        : raw?.role === 'agent'
            ? resolveTranscriptBodySemanticEvent({
                protocol: 'acp',
                body: raw.content,
            })?.role ?? null
            : null;
    if (
        id === null
        || createdAtMs === null
        || localId === null
        || sidechainId === false
        || role === false
        || raw === null
        || derivedRole === null
        || (role !== undefined && role !== null && role !== derivedRole)
        || userProjection === null
        || (userProjection !== undefined && derivedRole !== 'user')
    ) return null;
    return Object.freeze({
        id,
        createdAtMs,
        raw,
        ...(localId === undefined ? {} : { localId }),
        ...(sidechainId === undefined ? {} : { sidechainId }),
        ...(role === undefined ? {} : { messageRole: role }),
        ...(userProjection === undefined ? {} : { userProjection }),
    });
}

function sourceDigest(source: AgentExternalSessionSource): string {
    return createHash('sha256').update(createCanonicalJsonSigningInput(source), 'utf8').digest('base64url');
}

function encodeQualifiedCursor(
    nativeCursor: string,
    identity: ContributionIdentity,
    scope: CursorScope,
): string | null {
    if (parseBoundedString(nativeCursor, MAX_NATIVE_CURSOR_CODE_UNITS) === null) return null;
    const envelope: QualifiedCursorV1 = Object.freeze({
        v: 1,
        p: identity.pluginId,
        a: identity.agentId,
        g: identity.generation,
        s: sourceDigest(scope.source),
        m: scope.method,
        r: scope.remoteSessionId ?? null,
        c: nativeCursor,
    });
    const encoded = `happier_external_cursor_v1:${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')}`;
    return encoded.length <= MAX_QUALIFIED_CURSOR_CODE_UNITS ? encoded : null;
}

function decodeInputCursor(
    value: unknown,
    identity: ContributionIdentity,
    scope: CursorScope,
): string | null {
    const cursor = parseBoundedString(value, MAX_QUALIFIED_CURSOR_CODE_UNITS);
    if (cursor === null) return null;
    const prefix = 'happier_external_cursor_v1:';
    if (!cursor.startsWith(prefix)) {
        return cursor.length <= MAX_NATIVE_CURSOR_CODE_UNITS ? cursor : null;
    }
    try {
        const decoded: unknown = JSON.parse(Buffer.from(cursor.slice(prefix.length), 'base64url').toString('utf8'));
        const record = readStrictRecord(decoded, ['v', 'p', 'a', 'g', 's', 'm', 'r', 'c']);
        if (
            !record
            || record.v !== 1
            || record.p !== identity.pluginId
            || record.a !== identity.agentId
            || record.g !== identity.generation
            || record.s !== sourceDigest(scope.source)
            || record.m !== scope.method
            || record.r !== (scope.remoteSessionId ?? null)
        ) {
            return null;
        }
        return parseBoundedString(record.c, MAX_NATIVE_CURSOR_CODE_UNITS);
    } catch {
        return null;
    }
}

function parseFailure(value: unknown): AgentExternalSessionsResult<never> | null {
    const record = readStrictRecord(value, ['ok', 'code'], ['message', 'retryable']);
    if (!record || record.ok !== false || !isAgentExternalSessionsFailureCode(record.code)) {
        return null;
    }
    const message = record.message === undefined
        ? undefined
        : parseBoundedString(record.message, MAX_FAILURE_MESSAGE_CODE_UNITS, true);
    const retryable = parseOptionalBoolean(record.retryable);
    if (message === null || retryable === null) return null;
    return Object.freeze({
        ok: false,
        code: record.code as AgentExternalSessionsFailureCode,
        ...(message === undefined ? {} : { message }),
        ...(retryable === undefined ? {} : { retryable }),
    });
}

function parseResolveSourceValue(value: unknown): AgentExternalSessionsResolveSourceResult | null {
    const record = readStrictRecord(value, ['source'], ['transcriptMediaReadRoots']);
    const parsedSource = record ? parseSource(record.source) : null;
    const transcriptMediaReadRoots = record
        ? parseTranscriptMediaReadRoots(record.transcriptMediaReadRoots)
        : null;
    return parsedSource && transcriptMediaReadRoots !== null
        ? Object.freeze({
            source: parsedSource,
            ...(transcriptMediaReadRoots === undefined ? {} : { transcriptMediaReadRoots }),
        })
        : null;
}

function parseCandidatePreparation(
    value: unknown,
): AgentExternalSessionsListCandidatesResult['preparation'] | null {
    if (value === undefined) return undefined;
    const record = readStrictRecord(value, ['kind', 'scanned'], ['total']);
    if (
        !record
        || record.kind !== 'building_candidate_index'
        || !Number.isSafeInteger(record.scanned)
        || (record.scanned as number) < 0
        || (
            record.total !== undefined
            && (
                !Number.isSafeInteger(record.total)
                || (record.total as number) < (record.scanned as number)
            )
        )
    ) {
        return null;
    }
    return Object.freeze({
        kind: 'building_candidate_index',
        scanned: record.scanned as number,
        ...(record.total === undefined ? {} : { total: record.total as number }),
    });
}

function parseListCandidatesValue(
    value: unknown,
    maxItems: number,
    identity: ContributionIdentity,
    scope: CursorScope,
): AgentExternalSessionsListCandidatesResult | null {
    const record = readStrictRecord(value, ['candidates', 'nextCursor'], ['searchIncomplete', 'preparation']);
    if (!record || !Array.isArray(record.candidates) || record.candidates.length > maxItems) return null;
    const candidates = record.candidates.map(parseCandidate);
    if (candidates.some((candidate) => candidate === null)) return null;
    const nextCursor = record.nextCursor === null
        ? null
        : typeof record.nextCursor === 'string'
            ? encodeQualifiedCursor(record.nextCursor, identity, scope)
            : null;
    const searchIncomplete = parseOptionalBoolean(record.searchIncomplete);
    const preparation = parseCandidatePreparation(record.preparation);
    if (
        (record.nextCursor !== null && nextCursor === null)
        || searchIncomplete === null
        || preparation === null
    ) return null;
    return Object.freeze({
        candidates: Object.freeze(candidates as AgentExternalSessionCandidate[]),
        nextCursor,
        ...(searchIncomplete === undefined ? {} : { searchIncomplete }),
        ...(preparation === undefined ? {} : { preparation }),
    });
}

function parseResolvedIdentityValue(value: unknown): AgentExternalSessionsResolvedIdentity | null {
    const record = readStrictRecord(
        value,
        ['source', 'remoteSessionId', 'linkData'],
        ['transcriptMediaReadRoots'],
    );
    if (!record) return null;
    const parsedSource = parseSource(record.source);
    const remoteSessionId = parseBoundedString(record.remoteSessionId, MAX_ID_CODE_UNITS);
    const linkData = parseLinkData(record.linkData);
    const transcriptMediaReadRoots = parseTranscriptMediaReadRoots(record.transcriptMediaReadRoots);
    return parsedSource && remoteSessionId && linkData && transcriptMediaReadRoots !== null
        ? Object.freeze({
            source: parsedSource,
            remoteSessionId,
            linkData,
            ...(transcriptMediaReadRoots === undefined ? {} : { transcriptMediaReadRoots }),
        })
        : null;
}

function parseTranscriptPageValue(
    value: unknown,
    maxItems: number,
    identity: ContributionIdentity,
    scope: CursorScope,
): AgentExternalSessionsTranscriptPage | null {
    const record = readStrictRecord(value, ['items', 'nextCursor'], ['tailCursor', 'hasMore', 'truncated']);
    if (!record || !Array.isArray(record.items) || record.items.length > maxItems) return null;
    const items = record.items.map(parseTranscriptItem);
    if (items.some((item) => item === null)) return null;
    const nextCursor = record.nextCursor === null
        ? null
        : typeof record.nextCursor === 'string'
            ? encodeQualifiedCursor(record.nextCursor, identity, scope)
            : null;
    const tailScope = scope.method === 'pageTranscript'
        ? Object.freeze({
            method: 'readAfterTranscript' as const,
            source: scope.source,
            ...(scope.remoteSessionId === undefined ? {} : { remoteSessionId: scope.remoteSessionId }),
        })
        : scope;
    const tailCursor = record.tailCursor === undefined || record.tailCursor === null
        ? record.tailCursor
        : typeof record.tailCursor === 'string'
            ? encodeQualifiedCursor(record.tailCursor, identity, tailScope)
            : null;
    const hasMore = parseOptionalBoolean(record.hasMore);
    const truncated = parseOptionalBoolean(record.truncated);
    if (
        (record.nextCursor !== null && nextCursor === null)
        || (record.tailCursor !== undefined && record.tailCursor !== null && tailCursor === null)
        || hasMore === null
        || truncated === null
        || (hasMore === true && nextCursor === null)
        || (hasMore === false && nextCursor !== null)
    ) {
        return null;
    }
    return Object.freeze({
        items: Object.freeze(items as AgentExternalSessionTranscriptItem[]),
        nextCursor,
        ...(tailCursor === undefined ? {} : { tailCursor }),
        ...(hasMore === undefined ? {} : { hasMore }),
        ...(truncated === undefined ? {} : { truncated }),
    });
}

function parseReadAfterDiagnostic(value: unknown): AgentExternalSessionsReadAfterDiagnostic | null {
    const record = readStrictRecord(value, ['code', 'severity', 'count', 'positions']);
    if (
        !record
        || parseBoundedString(record.code, MAX_READ_AFTER_DIAGNOSTIC_CODE_UNITS) === null
        || (record.severity !== 'benign' && record.severity !== 'required')
        || !Number.isSafeInteger(record.count)
        || (record.count as number) <= 0
        || !Array.isArray(record.positions)
        || record.positions.length > MAX_READ_AFTER_DIAGNOSTIC_POSITIONS
        || record.positions.some((position) => !Number.isSafeInteger(position) || (position as number) < 0)
        || (record.count as number) < record.positions.length
    ) {
        return null;
    }
    return Object.freeze({
        code: record.code as string,
        severity: record.severity,
        count: record.count as number,
        positions: Object.freeze([...(record.positions as number[])]),
    });
}

function parseReadAfterTranscriptValue(
    value: unknown,
    maxItems: number,
    inputCursor: string,
    identity: ContributionIdentity,
    scope: CursorScope,
): AgentExternalSessionsReadAfterTranscriptResult | null {
    const discriminator = readStrictRecord(value, ['outcome'], ['items', 'nextCursor', 'boundary', 'hasMore', 'diagnostics']);
    if (!discriminator || typeof discriminator.outcome !== 'string') return null;
    switch (discriminator.outcome) {
        case 'already_current':
        case 'gap_or_cursor_expired':
        case 'source_replaced':
        case 'source_unavailable':
        case 'read_failed': {
            const record = readStrictRecord(value, ['outcome']);
            return record ? Object.freeze({ outcome: discriminator.outcome }) : null;
        }
        case 'advanced': {
            const record = readStrictRecord(value, ['outcome', 'items', 'nextCursor', 'boundary', 'hasMore'], ['diagnostics']);
            if (
                !record
                || !Array.isArray(record.items)
                || record.items.length > maxItems
                || typeof record.nextCursor !== 'string'
                || record.nextCursor === inputCursor
                || typeof record.hasMore !== 'boolean'
            ) {
                return null;
            }
            const items = record.items.map(parseTranscriptItem);
            const nextCursor = encodeQualifiedCursor(record.nextCursor, identity, scope);
            const boundary = parseBoundedString(record.boundary, MAX_READ_AFTER_BOUNDARY_CODE_UNITS);
            const diagnostics = record.diagnostics === undefined
                ? undefined
                : Array.isArray(record.diagnostics) && record.diagnostics.length <= MAX_READ_AFTER_DIAGNOSTICS
                    ? record.diagnostics.map(parseReadAfterDiagnostic)
                    : null;
            if (
                items.some((item) => item === null)
                || nextCursor === null
                || boundary === null
                || diagnostics === null
                || diagnostics?.some((diagnostic) => diagnostic === null)
                || (items.length === 0 && (!diagnostics || diagnostics.length === 0))
            ) {
                return null;
            }
            return Object.freeze({
                outcome: 'advanced',
                items: Object.freeze(items as AgentExternalSessionTranscriptItem[]),
                nextCursor,
                boundary,
                hasMore: record.hasMore,
                ...(diagnostics === undefined
                    ? {}
                    : { diagnostics: Object.freeze(diagnostics as AgentExternalSessionsReadAfterDiagnostic[]) }),
            });
        }
        default:
            return null;
    }
}

/**
 * Sizes an already admitted result through the canonical iterative Protocol byte
 * owner. Recursive serialization would reject valid deep values the strict-JSON
 * contract deliberately admits, so the byte ceiling stays the only bound.
 */
function serializedResultBytes(value: unknown, maxSerializedBytes: number): number {
    return measureSerializedValidatedStrictPluginJsonUtf8Bytes(
        value,
        'Agent External Sessions result',
        maxSerializedBytes,
    );
}

function parseAndBoundResult<T>(
    value: unknown,
    parseValue: (candidate: unknown) => T | null,
    maxSerializedBytes: number,
): AgentExternalSessionsResult<T> {
    const failure = parseFailure(value);
    if (failure) {
        return serializedResultBytes(failure, maxSerializedBytes) <= maxSerializedBytes
            ? failure
            : agentError();
    }
    const record = readStrictRecord(value, ['ok', 'value']);
    if (!record || record.ok !== true) return agentError();
    const parsedValue = parseValue(record.value);
    if (parsedValue === null) return agentError();
    const result = Object.freeze({ ok: true as const, value: parsedValue });
    return serializedResultBytes(result, maxSerializedBytes) <= maxSerializedBytes ? result : agentError();
}

function readMaxSerializedBytes(value: unknown, ceiling: number): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? Math.min(value, ceiling)
        : null;
}

function readMaxItems(value: unknown, ceiling: number): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? Math.min(value, ceiling)
        : null;
}

export type BoundedExternalSessionsOperationResult<T> =
    | Readonly<{ status: 'fulfilled'; value: T }>
    | Readonly<{ status: 'rejected' }>
    | Readonly<{ status: 'retired' }>
    | Readonly<{ status: 'cancelled' }>
    | Readonly<{ status: 'timeout' }>;

/**
 * Runs one leaf operation inside the canonical External Sessions admission
 * boundary. Callers provide an absolute ceiling; this owner applies the
 * ordinary per-call ceiling, cancellation, retirement, and timer cleanup.
 */
export async function invokeBoundedExternalSessionsOperation<T>(params: Readonly<{
    signal: AbortSignal;
    retirementSignal: AbortSignal;
    isCurrent(): boolean;
    deadlineAtMs?: number;
    operation(signal: AbortSignal, deadlineAtMs: number): Promise<T> | T;
}>): Promise<BoundedExternalSessionsOperationResult<T>> {
    if (!params.isCurrent() || params.retirementSignal.aborted) {
        return Object.freeze({ status: 'retired' });
    }
    if (params.signal.aborted) return Object.freeze({ status: 'cancelled' });

    const nowMs = Date.now();
    const deadlineAtMs = Math.min(
        nowMs + EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs,
        params.deadlineAtMs ?? Number.POSITIVE_INFINITY,
    );
    if (deadlineAtMs <= nowMs) return Object.freeze({ status: 'timeout' });

    const operationController = new AbortController();
    let terminal: 'retired' | 'cancelled' | 'timeout' | null = null;
    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
    });
    const finish = (reason: 'retired' | 'cancelled' | 'timeout'): void => {
        if (terminal !== null) return;
        terminal = reason;
        operationController.abort(reason);
        resolveTerminal();
    };
    const retire = () => finish('retired');
    const cancel = () => finish('cancelled');
    params.retirementSignal.addEventListener('abort', retire, { once: true });
    params.signal.addEventListener('abort', cancel, { once: true });
    if (!params.isCurrent() || params.retirementSignal.aborted) {
        finish('retired');
    } else if (params.signal.aborted) {
        finish('cancelled');
    }
    const timer = setTimeout(() => finish('timeout'), Math.max(0, deadlineAtMs - nowMs));
    const settled = Promise.resolve()
        .then(() => terminal === null
            ? params.operation(operationController.signal, deadlineAtMs)
            : Promise.reject(new Error('External Sessions invocation cancelled before leaf admission')))
        .then(
            (value) => ({ status: 'fulfilled' as const, value }),
            () => ({ status: 'rejected' as const }),
        );
    try {
        const outcome = await Promise.race([
            settled,
            terminalPromise.then(() => ({ status: 'terminal' as const })),
        ]);
        if (!params.isCurrent() || params.retirementSignal.aborted || terminal === 'retired') {
            return Object.freeze({ status: 'retired' });
        }
        if (params.signal.aborted || terminal === 'cancelled') {
            return Object.freeze({ status: 'cancelled' });
        }
        if (terminal === 'timeout' || outcome.status === 'terminal') {
            return Object.freeze({ status: 'timeout' });
        }
        if (outcome.status === 'rejected') {
            return Object.freeze({ status: 'rejected' });
        }
        return Object.freeze({ status: 'fulfilled', value: outcome.value });
    } finally {
        if (!operationController.signal.aborted) {
            operationController.abort(new Error('Agent External Sessions invocation settled'));
        }
        clearTimeout(timer);
        params.retirementSignal.removeEventListener('abort', retire);
        params.signal.removeEventListener('abort', cancel);
    }
}

async function invokeBounded<T>(params: Readonly<{
    signal: AbortSignal;
    retirementSignal: AbortSignal;
    isCurrent(): boolean;
    deadlineAtMs?: number;
    operation(signal: AbortSignal, deadlineAtMs: number): Promise<unknown> | unknown;
    parse(value: unknown): AgentExternalSessionsResult<T>;
}>): Promise<AgentExternalSessionsResult<T>> {
    const outcome = await invokeBoundedExternalSessionsOperation({
        signal: params.signal,
        retirementSignal: params.retirementSignal,
        isCurrent: params.isCurrent,
        ...(params.deadlineAtMs === undefined
            ? {}
            : { deadlineAtMs: params.deadlineAtMs }),
        operation: params.operation,
    });
    switch (outcome.status) {
        case 'fulfilled':
            return params.parse(outcome.value);
        case 'rejected':
            return agentError();
        case 'retired':
            return unavailable();
        case 'cancelled':
            return cancelled();
        case 'timeout':
            return timeout();
    }
}

export function createBoundedAgentExternalSessionsContribution(params: Readonly<{
    contribution: AgentExternalSessionsContribution;
    identity: ContributionIdentity;
    isCurrent(): boolean;
    retirementSignal: AbortSignal;
    managedEndpointRead?: AgentExternalSessionsManagedEndpointReadHost;
    /**
     * The caller owns construction of the generic Agent invocation service.
     * This wrapper owns only its admission, currentness, cancellation, and
     * result bounds before passing that service to a contribution callback.
     */
    createInvocationExec(signal: AbortSignal): Promise<ExecService>;
}>): BoundedAgentExternalSessionsContribution {
    const terminalBeforeAdmission = (signal: AbortSignal): AgentExternalSessionsResult<never> | null => {
        if (!params.isCurrent() || params.retirementSignal.aborted) return unavailable();
        if (signal.aborted) return cancelled();
        return null;
    };
    const bindManagedEndpointRead = async (
        source: AgentExternalSessionSource,
        signal: AbortSignal,
    ): Promise<AgentExternalSessionsManagedEndpointRead> =>
        await bindAgentExternalSessionsManagedEndpointRead({
            identity: params.identity,
            source,
            signal,
            isCurrent: params.isCurrent,
            retirementSignal: params.retirementSignal,
            host: params.managedEndpointRead,
        });
    const assertOperationAdmissible = (signal: AbortSignal): void => {
        if (!params.isCurrent() || params.retirementSignal.aborted) {
            throw new Error('Agent External Sessions invocation belongs to a retired generation');
        }
        if (signal.aborted) throw signal.reason;
    };
    const bindInvocationContext = async (
        source: AgentExternalSessionSource,
        signal: AbortSignal,
    ) => {
        const managedEndpointRead = await bindManagedEndpointRead(source, signal);
        assertOperationAdmissible(signal);
        const exec = await params.createInvocationExec(signal);
        assertOperationAdmissible(signal);
        return Object.freeze({ managedEndpointRead, exec });
    };
    const wrap = Object.freeze({
        async resolveSource(request) {
            const terminal = terminalBeforeAdmission(request.signal);
            if (terminal) return terminal;
            const parsedSource = parseSource(request.source);
            const maxSerializedBytes = readMaxSerializedBytes(
                request.maxSerializedBytes,
                EXTERNAL_SESSIONS_INVOCATION_POLICY.resolveSource.maxSerializedBytes,
            );
            if (!parsedSource || maxSerializedBytes === null) return invalidRequest();
            return await invokeBounded({
                signal: request.signal,
                retirementSignal: params.retirementSignal,
                isCurrent: params.isCurrent,
                deadlineAtMs: request.deadlineAtMs,
                operation: async (signal, deadlineAtMs) => {
                    const invocation = await bindInvocationContext(
                        parsedSource,
                        signal,
                    );
                    return await params.contribution.resolveSource({
                        source: parsedSource,
                        signal,
                        deadlineAtMs,
                        maxSerializedBytes,
                        ...invocation,
                    });
                },
                parse: (value) => parseAndBoundResult(value, parseResolveSourceValue, maxSerializedBytes),
            });
        },
        async listCandidates(request) {
            const terminal = terminalBeforeAdmission(request.signal);
            if (terminal) return terminal;
            const parsedSource = parseSource(request.source);
            const maxItems = readMaxItems(request.maxItems, EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxItems);
            const maxSerializedBytes = readMaxSerializedBytes(
                request.maxSerializedBytes,
                EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxSerializedBytes,
            );
            const searchTerm = request.searchTerm === undefined
                ? undefined
                : parseBoundedString(request.searchTerm, MAX_SEARCH_CODE_UNITS, true);
            const scope = parsedSource
                ? Object.freeze({ method: 'listCandidates' as const, source: parsedSource })
                : null;
            const cursor = request.cursor === undefined || !scope
                ? request.cursor
                : decodeInputCursor(request.cursor, params.identity, scope);
            if (
                !parsedSource
                || maxItems === null
                || maxSerializedBytes === null
                || searchTerm === null
                || (request.searchMode !== undefined && request.searchMode !== 'fast' && request.searchMode !== 'full')
                || (request.cursor !== undefined && cursor === null)
                || !scope
            ) {
                return invalidRequest();
            }
            return await invokeBounded({
                signal: request.signal,
                retirementSignal: params.retirementSignal,
                isCurrent: params.isCurrent,
                deadlineAtMs: request.deadlineAtMs,
                operation: async (signal, deadlineAtMs) => {
                    const invocation = await bindInvocationContext(
                        parsedSource,
                        signal,
                    );
                    return await params.contribution.listCandidates({
                        source: parsedSource,
                        signal,
                        deadlineAtMs,
                        maxSerializedBytes,
                        ...invocation,
                        maxItems,
                        ...(typeof cursor === 'string' ? { cursor } : {}),
                        ...(searchTerm === undefined ? {} : { searchTerm }),
                        ...(request.searchMode === undefined ? {} : { searchMode: request.searchMode }),
                    });
                },
                parse: (value) => parseAndBoundResult(
                    value,
                    (candidate) => parseListCandidatesValue(candidate, maxItems, params.identity, scope),
                    maxSerializedBytes,
                ),
            });
        },
        async resolveLinkIdentity(request) {
            const terminal = terminalBeforeAdmission(request.signal);
            if (terminal) return terminal;
            const parsedSource = parseSource(request.source);
            const remoteSessionId = parseBoundedString(request.remoteSessionId, MAX_ID_CODE_UNITS);
            const linkData = request.linkData === undefined ? undefined : parseLinkData(request.linkData);
            const maxSerializedBytes = readMaxSerializedBytes(
                request.maxSerializedBytes,
                EXTERNAL_SESSIONS_INVOCATION_POLICY.resolveLinkIdentity.maxSerializedBytes,
            );
            if (!parsedSource || !remoteSessionId || linkData === null || maxSerializedBytes === null) return invalidRequest();
            return await invokeBounded({
                signal: request.signal,
                retirementSignal: params.retirementSignal,
                isCurrent: params.isCurrent,
                deadlineAtMs: request.deadlineAtMs,
                operation: async (signal, deadlineAtMs) => {
                    const invocation = await bindInvocationContext(
                        parsedSource,
                        signal,
                    );
                    return await params.contribution.resolveLinkIdentity({
                        source: parsedSource,
                        remoteSessionId,
                        ...(linkData === undefined ? {} : { linkData }),
                        signal,
                        deadlineAtMs,
                        maxSerializedBytes,
                        ...invocation,
                    });
                },
                parse: (value) => parseAndBoundResult(value, parseResolvedIdentityValue, maxSerializedBytes),
            });
        },
        async resolveLinkedIdentity(request) {
            const terminal = terminalBeforeAdmission(request.signal);
            if (terminal) return terminal;
            const parsedSource = parseSource(request.source);
            const remoteSessionId = parseBoundedString(request.remoteSessionId, MAX_ID_CODE_UNITS);
            const linkData = parseLinkData(request.linkData);
            const maxSerializedBytes = readMaxSerializedBytes(
                request.maxSerializedBytes,
                EXTERNAL_SESSIONS_INVOCATION_POLICY.resolveLinkedIdentity.maxSerializedBytes,
            );
            if (!parsedSource || !remoteSessionId || !linkData || maxSerializedBytes === null) return invalidRequest();
            return await invokeBounded({
                signal: request.signal,
                retirementSignal: params.retirementSignal,
                isCurrent: params.isCurrent,
                deadlineAtMs: request.deadlineAtMs,
                operation: async (signal, deadlineAtMs) => {
                    const invocation = await bindInvocationContext(
                        parsedSource,
                        signal,
                    );
                    return await params.contribution.resolveLinkedIdentity({
                        source: parsedSource,
                        remoteSessionId,
                        linkData,
                        signal,
                        deadlineAtMs,
                        maxSerializedBytes,
                        ...invocation,
                    });
                },
                parse: (value) => parseAndBoundResult(value, parseResolvedIdentityValue, maxSerializedBytes),
            });
        },
        async pageTranscript(request) {
            const terminal = terminalBeforeAdmission(request.signal);
            if (terminal) return terminal;
            const parsedSource = parseSource(request.source);
            const remoteSessionId = parseBoundedString(request.remoteSessionId, MAX_ID_CODE_UNITS);
            const maxItems = readMaxItems(request.maxItems, EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxItems);
            const maxSerializedBytes = readMaxSerializedBytes(
                request.maxSerializedBytes,
                EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxSerializedBytes,
            );
            const scope = parsedSource && remoteSessionId
                ? Object.freeze({ method: 'pageTranscript' as const, source: parsedSource, remoteSessionId })
                : null;
            const cursor = request.cursor === undefined || !scope
                ? request.cursor
                : decodeInputCursor(request.cursor, params.identity, scope);
            if (
                !parsedSource
                || !remoteSessionId
                || maxItems === null
                || maxSerializedBytes === null
                || (request.direction !== 'older' && request.direction !== 'newer')
                || (request.cursor !== undefined && cursor === null)
                || !scope
            ) {
                return invalidRequest();
            }
            return await invokeBounded({
                signal: request.signal,
                retirementSignal: params.retirementSignal,
                isCurrent: params.isCurrent,
                deadlineAtMs: request.deadlineAtMs,
                operation: async (signal, deadlineAtMs) => {
                    const invocation = await bindInvocationContext(
                        parsedSource,
                        signal,
                    );
                    return await params.contribution.pageTranscript({
                        source: parsedSource,
                        remoteSessionId,
                        direction: request.direction,
                        signal,
                        deadlineAtMs,
                        maxSerializedBytes,
                        ...invocation,
                        maxItems,
                        ...(typeof cursor === 'string' ? { cursor } : {}),
                    });
                },
                parse: (value) => parseAndBoundResult(
                    value,
                    (candidate) => parseTranscriptPageValue(candidate, maxItems, params.identity, scope),
                    maxSerializedBytes,
                ),
            });
        },
        async readAfterTranscript(request) {
            const terminal = terminalBeforeAdmission(request.signal);
            if (terminal) return terminal;
            const parsedSource = parseSource(request.source);
            const remoteSessionId = parseBoundedString(request.remoteSessionId, MAX_ID_CODE_UNITS);
            const maxItems = readMaxItems(request.maxItems, EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxItems);
            const maxSerializedBytes = readMaxSerializedBytes(
                request.maxSerializedBytes,
                EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxSerializedBytes,
            );
            const scope = parsedSource && remoteSessionId
                ? Object.freeze({ method: 'readAfterTranscript' as const, source: parsedSource, remoteSessionId })
                : null;
            const cursor = scope ? decodeInputCursor(request.cursor, params.identity, scope) : null;
            if (!parsedSource || !remoteSessionId || maxItems === null || maxSerializedBytes === null || cursor === null || !scope) {
                return invalidRequest();
            }
            return await invokeBounded({
                signal: request.signal,
                retirementSignal: params.retirementSignal,
                isCurrent: params.isCurrent,
                deadlineAtMs: request.deadlineAtMs,
                operation: async (signal, deadlineAtMs) => {
                    const invocation = await bindInvocationContext(
                        parsedSource,
                        signal,
                    );
                    return await params.contribution.readAfterTranscript({
                        source: parsedSource,
                        remoteSessionId,
                        cursor,
                        signal,
                        deadlineAtMs,
                        maxSerializedBytes,
                        ...invocation,
                        maxItems,
                    });
                },
                parse: (value) => parseAndBoundResult(
                    value,
                    (candidate) => parseReadAfterTranscriptValue(
                        candidate,
                        maxItems,
                        cursor,
                        params.identity,
                        scope,
                    ),
                    maxSerializedBytes,
                ),
            });
        },
    } satisfies BoundedAgentExternalSessionsContribution);
    return wrap;
}
