import { createHash } from 'node:crypto';
import { armDeadlineTimer } from '@happier-dev/protocol/common/deadlineTimer';

import { AgentExternalSessionTranscriptRawRecordSchema, ExternalSessionUserProjectionSchema } from '@happier-dev/protocol/sessions/messages/agentExternalSessionTranscriptRawRecord';
import { ExternalSessionCandidateThreadV1Schema, ExternalSessionCandidateMatchV1Schema, ExternalSessionsContentCoverageSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { ExternalSessionTranscriptItemIdV1Schema, ExternalSessionTerminalSourceObservationV1Schema, ExternalSessionTranscriptSourceTimestampV1Schema } from '@happier-dev/protocol/sessions/external/sourceTranscriptItemV1';
import { SidechainIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import { ExternalSessionsSourceSchema } from '@happier-dev/protocol/sessions/external/sourceCatalog';
import { AgentExternalSessionAccountingSourceSchema, AgentExternalSessionAccountingChangedNativeSessionIdsSchema, AgentExternalSessionsReadAccountingResultSchema } from '@happier-dev/protocol/sessions/external/accounting';
import { MAX_EXTERNAL_SESSIONS_SOURCE_KIND_CODE_UNITS } from '@happier-dev/protocol/sessions/external/sourceCatalog';
import { MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES, PluginAgentExternalSessionLinkDataSchema } from '@happier-dev/protocol/plugins/contributions/agentExternalSessions';
import { resolveTranscriptBodySemanticEvent, SessionMessageRoleSchema } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import type { AgentExternalSessionTranscriptRawRecord, PluginAgentExternalSessionLinkData, PluginSourceCustodyV1, SessionMessageRole } from '@happier-dev/protocol';
import type {
    AgentExternalSessionTranscriptItem,
    AgentExternalSessionTerminalObservation,
    AgentExternalSessionsContribution,
    AgentExternalSessionsInvocation,
    AgentExternalSessionsFailureCode,
    AgentExternalSessionsManagedEndpointRead,
    AgentExternalSessionsReadAfterDiagnostic,
    AgentExternalSessionsResult,
    AgentExternalSessionsRipgrep,
} from '@happier-dev/plugin-sdk/sessions/external';
import { getAgentExternalSessionsInvocationFailure, isAgentExternalSessionsFailureCode, runWithSessionInputPromptUserTextReader } from '@happier-dev/plugin-sdk/sessions/external';
import { createCodingSessionInputPromptUserTextReader } from '@/agent/prompting/coding/providerPromptBehaviorRegistry';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type {
    AgentExternalSessionCandidate,
    AgentExternalSessionSource,
    AgentExternalSessionsListCandidatesResult,
    AgentExternalSessionsHydrateCandidatesRequest,
    AgentExternalSessionsHydrateCandidatesResult,
    AgentExternalSessionsReadAfterTranscriptResult,
    AgentExternalSessionsReadAccountingRequest,
    AgentExternalSessionsReadAccountingResult,
    AgentExternalSessionsResolveSourceResult,
    AgentExternalSessionsResolvedIdentity,
    AgentExternalSessionsTranscriptPage,
} from '@happier-dev/plugin-sdk/sessions/external';

import { measureSerializedValidatedStrictPluginJsonUtf8Bytes } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { run as runPackagedRipgrep } from '@/integrations/ripgrep';
import { logger } from '@/ui/logger';

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
const MAX_TRANSCRIPT_MEDIA_READ_ROOTS = 16;
const MAX_TRANSCRIPT_MEDIA_READ_ROOT_CODE_UNITS = 4_096;
export const EXTERNAL_SESSIONS_INVOCATION_POLICY = Object.freeze({
    listCandidates: Object.freeze({ maxItems: 50, maxSerializedBytes: 1_048_576 }),
    pageTranscript: Object.freeze({ maxItems: 200, maxSerializedBytes: 524_288 }),
    readAfterTranscript: Object.freeze({ maxItems: 200, maxSerializedBytes: 524_288 }),
    sourceKindMaxCodeUnits: MAX_EXTERNAL_SESSIONS_SOURCE_KIND_CODE_UNITS,
    idMaxCodeUnits: MAX_ID_CODE_UNITS,
    titleMaxCodeUnits: MAX_TITLE_CODE_UNITS,
    searchMaxCodeUnits: MAX_SEARCH_CODE_UNITS,
    failureMessageMaxCodeUnits: MAX_FAILURE_MESSAGE_CODE_UNITS,
    sourceMaxSerializedBytes: MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES,
});

type ContributionIdentity = Readonly<{
    pluginId: string;
    agentId: string;
    occurrenceId: string;
    contributionQualifiedId: string;
    sourceCustody: PluginSourceCustodyV1;
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
    ? Omit<T, 'managedEndpointRead' | 'exec' | 'ripgrep'>
    : never;

/**
 * Host-facing facade. The host supplies only the ordinary operation input; the
 * generation-bound owner stamps the capability into the plugin leaf request.
 */
export type BoundedAgentExternalSessionsContribution = Readonly<{
    [Method in keyof AgentExternalSessionsContribution]:
        NonNullable<AgentExternalSessionsContribution[Method]> extends (
            request: infer Request,
        ) => infer Result
            ? (request: WithoutHostStampedInvocationServices<Request>) => Result
            : never;
}> & Readonly<{
    supportsCandidateHydration: boolean;
    hydrateCandidates(request: WithoutHostStampedInvocationServices<AgentExternalSessionsHydrateCandidatesRequest>): Promise<AgentExternalSessionsResult<AgentExternalSessionsHydrateCandidatesResult>>;
    supportsAccounting: boolean;
    readAccounting(request: WithoutHostStampedInvocationServices<AgentExternalSessionsReadAccountingRequest>): Promise<AgentExternalSessionsResult<AgentExternalSessionsReadAccountingResult>>;
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
    maxSerializedBytes: number;
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
const agentError = (reason?: string): AgentExternalSessionsResult<never> => Object.freeze({
    ok: false,
    code: 'agent_error',
    retryable: false,
    ...(reason ? { message: `external_sessions_${reason}` } : {}),
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
        ['title', 'cwd', 'messageCount', 'createdAtMs', 'archived', 'thread', 'linkData', 'candidateIndexState', 'match'],
    );
    if (!record) return null;
    const remoteSessionId = parseBoundedString(record.remoteSessionId, MAX_ID_CODE_UNITS);
    const updatedAtMs = parseTimestamp(record.updatedAtMs);
    const title = record.title === undefined
        ? undefined
        : parseBoundedString(record.title, MAX_TITLE_CODE_UNITS);
    const createdAtMs = record.createdAtMs === undefined ? undefined : parseTimestamp(record.createdAtMs);
    const cwd = record.cwd === undefined ? undefined
        : typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd : null;
    const messageCount = record.messageCount === undefined ? undefined : parseTimestamp(record.messageCount);
    const archived = parseOptionalBoolean(record.archived);
    const parsedThread = record.thread === undefined
        ? undefined
        : ExternalSessionCandidateThreadV1Schema.safeParse(record.thread);
    const thread = parsedThread === undefined ? undefined : parsedThread.success ? parsedThread.data : null;
    const linkData = record.linkData === undefined ? undefined : parseLinkData(record.linkData);
    const candidateIndexState = record.candidateIndexState === undefined
        ? undefined
        : parseLinkData(record.candidateIndexState);
    const parsedMatch = record.match === undefined ? undefined : ExternalSessionCandidateMatchV1Schema.safeParse(record.match);
    const match = parsedMatch === undefined ? undefined : parsedMatch.success ? parsedMatch.data : null;
    if (
        remoteSessionId === null
        || updatedAtMs === null
        || title === null
        || (title !== undefined && title.trim().length === 0)
        || createdAtMs === null
        || cwd === null
        || messageCount === null
        || archived === null
        || thread === null
        || linkData === null
        || candidateIndexState === null
        || match === null
    ) {
        return null;
    }
    return Object.freeze({
        remoteSessionId,
        updatedAtMs,
        ...(title === undefined ? {} : { title }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(messageCount === undefined ? {} : { messageCount }),
        ...(createdAtMs === undefined ? {} : { createdAtMs }),
        ...(archived === undefined ? {} : { archived }),
        ...(thread === undefined ? {} : { thread }),
        ...(linkData === undefined ? {} : { linkData }),
        ...(candidateIndexState === undefined ? {} : { candidateIndexState }),
        ...(match === undefined ? {} : { match }),
    });
}

/** Transcript item identity is owned by Protocol so it cannot differ by execution placement. */
function parseTranscriptItemId(value: unknown): string | null {
    const parsed = ExternalSessionTranscriptItemIdV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function parseTranscriptItem(value: unknown, readUserText?: (text: string) => string): AgentExternalSessionTranscriptItem | null {
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
        || (localId === null && record.localId !== null)
        || sidechainId === false
        || role === false
        || raw === null
        || derivedRole === null
        || (role !== undefined && role !== null && role !== derivedRole)
        || userProjection === null
        || (userProjection !== undefined && derivedRole !== 'user')
    ) return null;
    const displayUserText = raw.role === 'user' && readUserText ? readUserText(raw.content.text) : undefined;
    return Object.freeze({
        id,
        createdAtMs,
        raw,
        ...(raw.role !== 'user' || displayUserText === undefined || displayUserText === raw.content.text ? {} : { displayUserText }),
        ...(localId === undefined ? {} : { localId }),
        ...(sidechainId === undefined ? {} : { sidechainId }),
        ...(role === undefined ? {} : { messageRole: role }),
        ...(userProjection === undefined ? {} : { userProjection }),
    });
}

function sourceDigest(source: AgentExternalSessionSource): string {
    return createHash('sha256').update(createCanonicalJsonSigningInput(source), 'utf8').digest('base64url');
}

function cursorCodeUnitBounds(scope: CursorScope): Readonly<{ native: number; qualified: number }> {
    // Discovery and transcript cursors carry codec progress. Their whole
    // qualified reply already has a UTF-8 byte budget; a second short-cursor
    // limit must not reject valid progress before that owner measures it.
    // Code units cannot exceed UTF-8 bytes, so this is only an early coarse
    // check. parseAndBoundResult enforces the actual whole-envelope budget.
    const bytes = scope.maxSerializedBytes;
    return { native: bytes, qualified: bytes };
}

function encodeQualifiedCursor(
    nativeCursor: string,
    identity: ContributionIdentity,
    scope: CursorScope,
): string | null {
    const bounds = cursorCodeUnitBounds(scope);
    if (parseBoundedString(nativeCursor, bounds.native) === null) {
        if (nativeCursor.length > bounds.native) {
            throw new ExternalSessionsResultAdmissionError('native_cursor_too_large');
        }
        return null;
    }
    const envelope: QualifiedCursorV1 = Object.freeze({
        v: 1,
        p: identity.pluginId,
        a: identity.agentId,
        g: identity.occurrenceId,
        s: sourceDigest(scope.source),
        m: scope.method,
        r: scope.remoteSessionId ?? null,
        c: nativeCursor,
    });
    const encoded = `happier_external_cursor_v1:${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')}`;
    if (encoded.length > bounds.qualified) throw new ExternalSessionsResultAdmissionError('result_byte_budget');
    return encoded;
}

function decodeInputCursor(
    value: unknown,
    identity: ContributionIdentity,
    scope: CursorScope,
): string | null {
    const bounds = cursorCodeUnitBounds(scope);
    const cursor = parseBoundedString(value, bounds.qualified);
    if (cursor === null) return null;
    const prefix = 'happier_external_cursor_v1:';
    if (!cursor.startsWith(prefix)) {
        return cursor.length <= bounds.native ? cursor : null;
    }
    try {
        const decoded: unknown = JSON.parse(Buffer.from(cursor.slice(prefix.length), 'base64url').toString('utf8'));
        const record = readStrictRecord(decoded, ['v', 'p', 'a', 'g', 's', 'm', 'r', 'c']);
        if (
            !record
            || record.v !== 1
            || record.p !== identity.pluginId
            || record.a !== identity.agentId
            || record.g !== identity.occurrenceId
            || record.s !== sourceDigest(scope.source)
            || record.m !== scope.method
            || record.r !== (scope.remoteSessionId ?? null)
        ) {
            return null;
        }
        return parseBoundedString(record.c, bounds.native);
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

/** Strict shared reader for a source-resolution value from an Agent leaf. */
export function parseAgentExternalSessionsResolveSourceResult(value: unknown): AgentExternalSessionsResolveSourceResult | null {
    const record = readStrictRecord(value, ['source'], ['transcriptMediaReadRoots', 'accountingSource']);
    const parsedSource = record ? parseSource(record.source) : null;
    const transcriptMediaReadRoots = record
        ? parseTranscriptMediaReadRoots(record.transcriptMediaReadRoots)
        : null;
    const accountingSource = record?.accountingSource === undefined
        ? undefined
        : AgentExternalSessionAccountingSourceSchema.safeParse(record.accountingSource);
    return parsedSource && transcriptMediaReadRoots !== null && (accountingSource === undefined || accountingSource.success)
        ? Object.freeze({
            source: parsedSource,
            ...(accountingSource?.success ? { accountingSource: accountingSource.data } : {}),
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
    const record = readStrictRecord(value, ['candidates', 'nextCursor'], ['searchIncomplete', 'preparation', 'contentCoverage']);
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
    const parsedCoverage = record.contentCoverage === undefined ? undefined : ExternalSessionsContentCoverageSchema.safeParse(record.contentCoverage);
    const contentCoverage = parsedCoverage === undefined ? undefined : parsedCoverage.success ? parsedCoverage.data : null;
    if (
        (record.nextCursor !== null && nextCursor === null)
        || searchIncomplete === null
        || preparation === null
        || contentCoverage === null
    ) return null;
    return Object.freeze({
        candidates: Object.freeze(candidates as AgentExternalSessionCandidate[]),
        nextCursor,
        ...(searchIncomplete === undefined ? {} : { searchIncomplete }),
        ...(preparation === undefined ? {} : { preparation }),
        ...(contentCoverage === undefined ? {} : { contentCoverage }),
    });
}

/** Snapshot before invoking the producer so mutation of a nested bag cannot
 * rewrite the original identity, checkpoint or search evidence under validation.
 */
function candidateImmutableFacts(candidate: AgentExternalSessionCandidate): string {
    const { title: _title, cwd: _cwd, messageCount: _messageCount, ...facts } = candidate;
    return createCanonicalJsonSigningInput(facts);
}

function parseHydratedCandidatesValue(
    value: unknown,
    originalFacts: readonly string[],
): AgentExternalSessionsHydrateCandidatesResult | null {
    const record = readStrictRecord(value, ['candidates']);
    if (!record || !Array.isArray(record.candidates) || record.candidates.length !== originalFacts.length) return null;
    const candidates: AgentExternalSessionCandidate[] = [];
    for (let index = 0; index < record.candidates.length; index += 1) {
        const candidate = parseCandidate(record.candidates[index]);
        if (!candidate || candidateImmutableFacts(candidate) !== originalFacts[index]) return null;
        candidates.push(candidate);
    }
    return Object.freeze({ candidates: Object.freeze(candidates) });
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
    projection?: 'terminal',
): AgentExternalSessionsTranscriptPage | null {
    const record = readStrictRecord(value, ['items', 'nextCursor'], ['tailCursor', 'hasMore', 'truncated', 'diagnostics']);
    if (!record || !Array.isArray(record.items) || record.items.length > maxItems) {
        throw new ExternalSessionsResultAdmissionError('transcript_page_envelope');
    }
    const readUserText = projection === 'terminal' ? undefined : createCodingSessionInputPromptUserTextReader(identity.agentId);
    const items = record.items.map((item) => {
        if (projection === 'terminal') {
            const observation = ExternalSessionTerminalSourceObservationV1Schema.safeParse(item);
            if (observation.success) return observation.data;
        }
        return parseTranscriptItem(item, readUserText);
    });
    if (items.some((item) => item === null)) throw new ExternalSessionsResultAdmissionError('transcript_page_item');
    const nextCursor = record.nextCursor === null
        ? null
        : typeof record.nextCursor === 'string'
            ? encodeQualifiedCursor(record.nextCursor, identity, scope)
            : null;
    const tailScope = scope.method === 'pageTranscript'
        ? Object.freeze({
            method: 'readAfterTranscript' as const,
            source: scope.source,
            maxSerializedBytes: scope.maxSerializedBytes,
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
    const diagnostics = record.diagnostics === undefined ? undefined
        : Array.isArray(record.diagnostics) && record.diagnostics.length <= MAX_READ_AFTER_DIAGNOSTICS
            ? record.diagnostics.map(parseReadAfterDiagnostic) : null;
    if (diagnostics === null || diagnostics?.some(diagnostic => diagnostic === null)) {
        throw new ExternalSessionsResultAdmissionError('transcript_page_diagnostics');
    }
    if (
        (record.nextCursor !== null && nextCursor === null)
        || (record.tailCursor !== undefined && record.tailCursor !== null && tailCursor === null)
        || hasMore === null
        || truncated === null
        || (hasMore === true && nextCursor === null)
        || (hasMore === false && nextCursor !== null)
    ) {
        throw new ExternalSessionsResultAdmissionError('transcript_page_continuation');
    }
    return Object.freeze({
        items: Object.freeze(items as (AgentExternalSessionTranscriptItem | AgentExternalSessionTerminalObservation)[]),
        nextCursor,
        ...(tailCursor === undefined ? {} : { tailCursor }),
        ...(hasMore === undefined ? {} : { hasMore }),
        ...(truncated === undefined ? {} : { truncated }),
        ...(diagnostics === undefined ? {} : { diagnostics: Object.freeze(diagnostics as AgentExternalSessionsReadAfterDiagnostic[]) }),
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
    projection?: 'terminal',
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
            const readUserText = projection === 'terminal' ? undefined : createCodingSessionInputPromptUserTextReader(identity.agentId);
            const items = record.items.map((item) => {
                if (projection === 'terminal') {
                    const observation = ExternalSessionTerminalSourceObservationV1Schema.safeParse(item);
                    if (observation.success) return observation.data;
                }
                return parseTranscriptItem(item, readUserText);
            });
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
                items: Object.freeze(items as (AgentExternalSessionTranscriptItem | AgentExternalSessionTerminalObservation)[]),
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
function serializedResultBytes(value: unknown, maxSerializedBytes?: number): number {
    return measureSerializedValidatedStrictPluginJsonUtf8Bytes(
        value,
        'Agent External Sessions result',
        maxSerializedBytes,
    );
}

class ExternalSessionsResultAdmissionError extends Error {}

function parseAndBoundResult<T>(
    value: unknown,
    parseValue: (candidate: unknown) => T | null,
    maxSerializedBytes: number | undefined,
): AgentExternalSessionsResult<T> {
    const failure = parseFailure(value);
    if (failure) {
        return maxSerializedBytes === undefined || serializedResultBytes(failure, maxSerializedBytes) <= maxSerializedBytes
            ? failure
            : agentError('failure_byte_budget');
    }
    const record = readStrictRecord(value, ['ok', 'value']);
    if (!record || record.ok !== true) return agentError('result_envelope');
    let parsedValue: T | null;
    try {
        parsedValue = parseValue(record.value);
    } catch (error) {
        if (error instanceof ExternalSessionsResultAdmissionError) return agentError(error.message);
        throw error;
    }
    if (parsedValue === null) return agentError('result_value');
    const result = Object.freeze({ ok: true as const, value: parsedValue });
    return maxSerializedBytes === undefined || serializedResultBytes(result, maxSerializedBytes) <= maxSerializedBytes ? result : agentError('result_byte_budget');
}

function readMaxSerializedBytes(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? value
        : null;
}

function readMaxItems(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? value
        : null;
}

export type BoundedExternalSessionsOperationResult<T> =
    | Readonly<{ status: 'fulfilled'; value: T }>
    | Readonly<{ status: 'rejected'; reason: string }>
    | Readonly<{ status: 'retired' }>
    | Readonly<{ status: 'cancelled' }>
    | Readonly<{ status: 'timeout' }>;

/** Node timers represent at most signed-32 milliseconds, not the caller's lifetime. */
export function armExternalSessionsDeadline(
    deadlineAtMs: number,
    onDeadline: () => void,
    options: Readonly<{ unref?: true }> = {},
): () => void {
    return armDeadlineTimer(deadlineAtMs, onDeadline, options);
}

/**
 * Runs one leaf operation inside the canonical External Sessions admission
 * boundary. The caller owns any deadline; this owner composes cancellation,
 * retirement, and timer cleanup without adding a subordinate cutoff.
 */
export async function invokeBoundedExternalSessionsOperation<T>(params: Readonly<{
    signal: AbortSignal;
    retirementSignal: AbortSignal;
    isCurrent(): boolean;
    deadlineAtMs?: number;
    operation(signal: AbortSignal, deadlineAtMs: number | undefined): Promise<T> | T;
}>): Promise<BoundedExternalSessionsOperationResult<T>> {
    if (!params.isCurrent() || params.retirementSignal.aborted) {
        return Object.freeze({ status: 'retired' });
    }
    const callerCancellation = () => getAgentExternalSessionsInvocationFailure({ signal: params.signal })?.code === 'timeout'
        ? 'timeout' as const : 'cancelled' as const;
    if (params.signal.aborted) return Object.freeze({ status: callerCancellation() });

    const nowMs = Date.now();
    const deadlineAtMs = params.deadlineAtMs;
    if (deadlineAtMs !== undefined && deadlineAtMs <= nowMs) return Object.freeze({ status: 'timeout' });

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
    const cancel = () => finish(callerCancellation());
    params.retirementSignal.addEventListener('abort', retire, { once: true });
    params.signal.addEventListener('abort', cancel, { once: true });
    if (!params.isCurrent() || params.retirementSignal.aborted) {
        finish('retired');
    } else if (params.signal.aborted) {
        finish(callerCancellation());
    }
    const cancelDeadline = deadlineAtMs === undefined ? undefined : armExternalSessionsDeadline(deadlineAtMs, () => finish('timeout'));
    const settled = Promise.resolve()
        .then(() => terminal === null
            ? params.operation(operationController.signal, deadlineAtMs)
            : Promise.reject(new Error('External Sessions invocation cancelled before leaf admission')))
        .then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (error: unknown) => ({ status: 'rejected' as const,
                reason: error instanceof TypeError ? 'operation_type_error'
                    : error instanceof RangeError ? 'operation_range_error'
                        : error instanceof SyntaxError ? 'operation_syntax_error' : 'operation_rejected' }),
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
            return Object.freeze({ status: callerCancellation() });
        }
        if (terminal === 'timeout' || outcome.status === 'terminal') {
            return Object.freeze({ status: 'timeout' });
        }
        if (outcome.status === 'rejected') {
            return Object.freeze({ status: 'rejected', reason: outcome.reason });
        }
        return Object.freeze({ status: 'fulfilled', value: outcome.value });
    } finally {
        if (!operationController.signal.aborted) {
            operationController.abort(new Error('Agent External Sessions invocation settled'));
        }
        cancelDeadline?.();
        params.retirementSignal.removeEventListener('abort', retire);
        params.signal.removeEventListener('abort', cancel);
    }
}

async function invokeBounded<T>(params: Readonly<{
    signal: AbortSignal;
    retirementSignal: AbortSignal;
    isCurrent(): boolean;
    deadlineAtMs?: number;
    operation(signal: AbortSignal, deadlineAtMs: number | undefined): Promise<unknown> | unknown;
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
            return agentError(outcome.reason);
        case 'retired':
            return unavailable();
        case 'cancelled':
            return cancelled();
        case 'timeout':
            return timeout();
    }
}

/** Cursor qualification consumes the caller's reply budget, not the leaf's data. */
async function invokeBoundedQualifiedTranscriptPage<T>(params: Readonly<{
    signal: AbortSignal;
    retirementSignal: AbortSignal;
    isCurrent(): boolean;
    deadlineAtMs?: number;
    maxSerializedBytes: number;
    operation(signal: AbortSignal, deadlineAtMs: number | undefined, producerBytes: number): Promise<unknown>;
    parseValue(value: unknown): T | null;
}>): Promise<AgentExternalSessionsResult<T>> {
    return await invokeBounded({
        ...params,
        async operation(signal, deadlineAtMs) {
            let producerBytes = params.maxSerializedBytes;
            while (producerBytes > 0) {
                if (signal.aborted) throw signal.reason;
                const value = await params.operation(signal, deadlineAtMs, producerBytes);
                const parsed = parseAndBoundResult(value, params.parseValue, undefined);
                // A producer exceeding its admitted budget is invalid. Only
                // host-added qualification bytes may cause a smaller page read.
                const nativeBytes = serializedResultBytes(value, producerBytes);
                if (nativeBytes > producerBytes) return agentError('transcript_page_byte_budget');
                if (!parsed.ok) return parsed;
                const qualifiedBytes = serializedResultBytes(parsed);
                if (qualifiedBytes <= params.maxSerializedBytes) return value;
                // Re-read the same cursor under the same operation lifetime.
                // This strictly decreases the budget by measured overhead and
                // lets the producer retain every omitted row in its cursor.
                producerBytes = params.maxSerializedBytes - (qualifiedBytes - nativeBytes);
            }
            return agentError('transcript_page_byte_budget');
        },
        parse: (value) => parseAndBoundResult(value, params.parseValue, params.maxSerializedBytes),
    });
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
    const invocationLogger: NonNullable<AgentExternalSessionsInvocation['logger']> = Object.freeze({
        debug: (message, fields) => logger.debug(message, fields),
    });
    const terminalBeforeAdmission = (signal: AbortSignal): AgentExternalSessionsResult<never> | null => {
        if (!params.isCurrent() || params.retirementSignal.aborted) return unavailable();
        if (signal.aborted) return getAgentExternalSessionsInvocationFailure({ signal })?.code === 'timeout' ? timeout() : cancelled();
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
        maxSerializedBytes: number | undefined,
    ) => {
        const managedEndpointRead = await bindManagedEndpointRead(source, signal);
        assertOperationAdmissible(signal);
        const exec = await params.createInvocationExec(signal);
        assertOperationAdmissible(signal);
        const ripgrep: AgentExternalSessionsRipgrep = Object.freeze({
            async run(request) {
                const operationSignal = request.signal
                    ? AbortSignal.any([signal, request.signal])
                    : signal;
                assertOperationAdmissible(operationSignal);
                // An empty source file set must not turn into a cwd-wide scan.
                if (request.paths.length === 0) return { exitCode: 1, stdout: '', stderr: '' };
                const result = await runPackagedRipgrep([...request.args], {
                    paths: request.paths,
                    signal: operationSignal,
                    maxStdoutBytes: maxSerializedBytes,
                    maxStderrBytes: maxSerializedBytes,
                    terminateOnStdoutLimit: true,
                });
                assertOperationAdmissible(operationSignal);
                return Object.freeze(result);
            },
        });
        return Object.freeze({ managedEndpointRead, exec, ripgrep, logger: invocationLogger });
    };
    const hydrateCandidates = params.contribution.hydrateCandidates;
    const supportsCandidateHydration = typeof hydrateCandidates === 'function';
    const wrap = Object.freeze({
        supportsAccounting: typeof params.contribution.readAccounting === 'function',
        async readAccounting(request) {
            const terminal = terminalBeforeAdmission(request.signal);
            if (terminal) return terminal;
            const operation = params.contribution.readAccounting;
            if (!operation) return Object.freeze({ ok: false as const, code: 'unsupported' as const });
            const parsedSource = parseSource(request.source);
            const maxSerializedBytes = request.maxSerializedBytes === undefined ? undefined : readMaxSerializedBytes(request.maxSerializedBytes);
            // Accounting cursors are durable source frontiers, rather than the
            // generation-qualified transcript pagination cursors. Retirement
            // fences the call; restarting the daemon preserves this frontier.
            if (!parsedSource || maxSerializedBytes === null || (request.cursor !== undefined && (typeof request.cursor !== 'string' || request.cursor.length === 0))) return invalidRequest();
            const changes = request.changedNativeSessionIds === undefined ? undefined
                : AgentExternalSessionAccountingChangedNativeSessionIdsSchema.safeParse(request.changedNativeSessionIds);
            if (changes && !changes.success) return invalidRequest();
            return await invokeBounded({
                signal: request.signal,
                retirementSignal: params.retirementSignal,
                isCurrent: params.isCurrent,
                deadlineAtMs: request.deadlineAtMs,
                operation: async (signal, deadlineAtMs) => {
                    const invocation = await bindInvocationContext(parsedSource, signal, maxSerializedBytes);
                    return await operation.call(params.contribution, {
                        source: parsedSource,
                        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
                        ...(changes?.success ? { changedNativeSessionIds: changes.data } : {}),
                        signal, deadlineAtMs, maxSerializedBytes, ...invocation,
                    });
                },
                parse: (value) => parseAndBoundResult(value, (candidate) => {
                    const result = AgentExternalSessionsReadAccountingResultSchema.safeParse(candidate);
                    return result.success ? result.data : null;
                }, maxSerializedBytes),
            });
        },
        async resolveSource(request) {
            const terminal = terminalBeforeAdmission(request.signal);
            if (terminal) return terminal;
            const parsedSource = parseSource(request.source);
            const maxSerializedBytes = request.maxSerializedBytes === undefined ? undefined : readMaxSerializedBytes(request.maxSerializedBytes);
            if (!parsedSource || maxSerializedBytes === null
                || (request.includeAccountingSource !== undefined && typeof request.includeAccountingSource !== 'boolean')) return invalidRequest();
            return await invokeBounded({
                signal: request.signal,
                retirementSignal: params.retirementSignal,
                isCurrent: params.isCurrent,
                deadlineAtMs: request.deadlineAtMs,
                operation: async (signal, deadlineAtMs) => {
                    const invocation = await bindInvocationContext(
                        parsedSource,
                        signal,
                        maxSerializedBytes,
                    );
                    return await params.contribution.resolveSource({
                        source: parsedSource,
                        ...(request.includeAccountingSource === undefined ? {} : { includeAccountingSource: request.includeAccountingSource }),
                        signal,
                        deadlineAtMs,
                        maxSerializedBytes,
                        ...invocation,
                    });
                },
                parse: (value) => parseAndBoundResult(value, parseAgentExternalSessionsResolveSourceResult, maxSerializedBytes),
            });
        },
        async listCandidates(request) {
            const terminal = terminalBeforeAdmission(request.signal);
            if (terminal) return terminal;
            const parsedSource = parseSource(request.source);
            const maxItems = readMaxItems(request.maxItems);
            const maxSerializedBytes = readMaxSerializedBytes(request.maxSerializedBytes);
            const searchTerm = request.searchTerm === undefined
                ? undefined
                : parseBoundedString(request.searchTerm, MAX_SEARCH_CODE_UNITS, true);
            const scope = parsedSource && maxSerializedBytes !== null
                ? Object.freeze({ method: 'listCandidates' as const, source: parsedSource, maxSerializedBytes })
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
                || (request.searchTarget !== undefined && request.searchTarget !== 'metadata' && request.searchTarget !== 'content')
                || (request.updatedAfterMs !== undefined && (!Number.isSafeInteger(request.updatedAfterMs) || request.updatedAfterMs < 0))
                || (request.includeTitles !== undefined && typeof request.includeTitles !== 'boolean')
                || (request.includeThreads !== undefined && typeof request.includeThreads !== 'boolean')
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
                        maxSerializedBytes,
                    );
                    return await runWithSessionInputPromptUserTextReader(
                        createCodingSessionInputPromptUserTextReader(params.identity.agentId),
                        () => params.contribution.listCandidates({
                        source: parsedSource,
                        signal,
                        deadlineAtMs,
                        maxSerializedBytes,
                        ...invocation,
                        maxItems,
                        ...(request.scanDeadlineAtMs === undefined ? {} : { scanDeadlineAtMs: request.scanDeadlineAtMs }),
                        ...(typeof cursor === 'string' ? { cursor } : {}),
                        ...(searchTerm === undefined ? {} : { searchTerm }),
                        ...(request.searchMode === undefined ? {} : { searchMode: request.searchMode }),
                        ...(request.searchTarget === undefined ? {} : { searchTarget: request.searchTarget }),
                        ...(request.updatedAfterMs === undefined ? {} : { updatedAfterMs: request.updatedAfterMs }),
                        ...(request.includeTitles === undefined ? {} : { includeTitles: request.includeTitles }),
                        ...(request.includeThreads === undefined ? {} : { includeThreads: request.includeThreads }),
                        ...(request.readCandidateIndexState === undefined
                            ? {}
                            : {
                                readCandidateIndexState: (candidate) => {
                                    if (
                                        signal.aborted
                                        || params.retirementSignal.aborted
                                        || !params.isCurrent()
                                    ) return undefined;
                                    return request.readCandidateIndexState?.(candidate);
                                },
                            }),
                    }));
                },
                parse: (value) => parseAndBoundResult(
                    value,
                    (candidate) => parseListCandidatesValue(candidate, maxItems, params.identity, scope),
                    maxSerializedBytes,
                ),
            });
        },
        supportsCandidateHydration,
        async hydrateCandidates(request) {
            const terminal = terminalBeforeAdmission(request.signal);
            if (terminal) return terminal;
            if (!supportsCandidateHydration || !hydrateCandidates) {
                return Object.freeze({ ok: false as const, code: 'unsupported' as const });
            }
            const source = parseSource(request.source);
            const requestedBytes = readMaxSerializedBytes(request.maxSerializedBytes);
            const policy = EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates;
            if (!source || requestedBytes === null || !Array.isArray(request.candidates)
                || request.candidates.length > policy.maxItems) return invalidRequest();
            const candidates: AgentExternalSessionCandidate[] = [];
            for (const value of request.candidates) {
                const candidate = parseCandidate(value);
                if (!candidate) return invalidRequest();
                candidates.push(candidate);
            }
            if (serializedResultBytes({ candidates }, policy.maxSerializedBytes) > policy.maxSerializedBytes) return invalidRequest();
            const originalFacts = candidates.map(candidateImmutableFacts);
            const maxSerializedBytes = Math.min(requestedBytes, policy.maxSerializedBytes);
            return await invokeBounded({
                signal: request.signal,
                retirementSignal: params.retirementSignal,
                isCurrent: params.isCurrent,
                deadlineAtMs: request.deadlineAtMs,
                operation: async (signal, deadlineAtMs) => {
                    const invocation = await bindInvocationContext(source, signal, maxSerializedBytes);
                    return await hydrateCandidates.call(params.contribution, {
                        source, candidates: Object.freeze(candidates), signal, deadlineAtMs,
                        maxSerializedBytes, ...invocation,
                    });
                },
                parse: value => parseAndBoundResult(value,
                    candidate => parseHydratedCandidatesValue(candidate, originalFacts), maxSerializedBytes),
            });
        },
        async resolveLinkIdentity(request) {
            const terminal = terminalBeforeAdmission(request.signal);
            if (terminal) return terminal;
            const parsedSource = parseSource(request.source);
            const remoteSessionId = parseBoundedString(request.remoteSessionId, MAX_ID_CODE_UNITS);
            const linkData = request.linkData === undefined ? undefined : parseLinkData(request.linkData);
            const maxSerializedBytes = request.maxSerializedBytes === undefined ? undefined : readMaxSerializedBytes(request.maxSerializedBytes);
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
                        maxSerializedBytes,
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
            const maxSerializedBytes = request.maxSerializedBytes === undefined ? undefined : readMaxSerializedBytes(request.maxSerializedBytes);
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
                        maxSerializedBytes,
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
            if (request.projection !== undefined && request.projection !== 'terminal') return invalidRequest();
            const parsedSource = parseSource(request.source);
            const remoteSessionId = parseBoundedString(request.remoteSessionId, MAX_ID_CODE_UNITS);
            const maxItems = readMaxItems(request.maxItems);
            const maxSerializedBytes = readMaxSerializedBytes(request.maxSerializedBytes);
            const scope = parsedSource && remoteSessionId && maxSerializedBytes !== null
                ? Object.freeze({ method: 'pageTranscript' as const, source: parsedSource, remoteSessionId, maxSerializedBytes })
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
            return await invokeBoundedQualifiedTranscriptPage({
                signal: request.signal,
                retirementSignal: params.retirementSignal,
                isCurrent: params.isCurrent,
                deadlineAtMs: request.deadlineAtMs,
                maxSerializedBytes,
                operation: async (signal, deadlineAtMs, producerBytes) => {
                    const invocation = await bindInvocationContext(
                        parsedSource,
                        signal,
                        maxSerializedBytes,
                    );
                    return await params.contribution.pageTranscript({
                        ...(request.projection ? { projection: request.projection } : {}),
                        ...(request.observation ? { observation: request.observation } : {}),
                        source: parsedSource,
                        remoteSessionId,
                        direction: request.direction,
                        signal,
                        deadlineAtMs,
                        maxSerializedBytes: producerBytes,
                        ...invocation,
                        maxItems,
                        ...(typeof cursor === 'string' ? { cursor } : {}),
                    });
                },
                parseValue: (candidate) => parseTranscriptPageValue(candidate, maxItems, params.identity, scope, request.projection),
            });
        },
        async readAfterTranscript(request) {
            const terminal = terminalBeforeAdmission(request.signal);
            if (terminal) return terminal;
            if (request.projection !== undefined && request.projection !== 'terminal') return invalidRequest();
            const parsedSource = parseSource(request.source);
            const remoteSessionId = parseBoundedString(request.remoteSessionId, MAX_ID_CODE_UNITS);
            const maxItems = readMaxItems(request.maxItems);
            const maxSerializedBytes = readMaxSerializedBytes(request.maxSerializedBytes);
            const scope = parsedSource && remoteSessionId && maxSerializedBytes !== null
                ? Object.freeze({ method: 'readAfterTranscript' as const, source: parsedSource, remoteSessionId, maxSerializedBytes })
                : null;
            const cursor = scope ? decodeInputCursor(request.cursor, params.identity, scope) : null;
            if (!parsedSource || !remoteSessionId || maxItems === null || maxSerializedBytes === null || cursor === null || !scope) {
                return invalidRequest();
            }
            return await invokeBoundedQualifiedTranscriptPage({
                signal: request.signal,
                retirementSignal: params.retirementSignal,
                isCurrent: params.isCurrent,
                deadlineAtMs: request.deadlineAtMs,
                maxSerializedBytes,
                operation: async (signal, deadlineAtMs, producerBytes) => {
                    const invocation = await bindInvocationContext(
                        parsedSource,
                        signal,
                        maxSerializedBytes,
                    );
                    return await params.contribution.readAfterTranscript({
                        ...(request.projection ? { projection: request.projection } : {}),
                        ...(request.observation ? { observation: request.observation } : {}),
                        source: parsedSource,
                        remoteSessionId,
                        cursor,
                        signal,
                        deadlineAtMs,
                        maxSerializedBytes: producerBytes,
                        ...invocation,
                        maxItems,
                    });
                },
                parseValue: (candidate) => parseReadAfterTranscriptValue(
                    candidate,
                    maxItems,
                    cursor,
                    params.identity,
                    scope,
                    request.projection,
                ),
            });
        },
    } satisfies BoundedAgentExternalSessionsContribution);
    return wrap;
}
