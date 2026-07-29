import { createHash } from 'node:crypto';

import {
    PluginAgentExternalSessionLinkDataSchema,
    SessionMessageRoleSchema,
    type PluginAgentExternalSessionLinkData,
    type PluginAgentExternalSessionLinkDataValue,
    type SessionMessageRole,
} from '@happier-dev/protocol';
import type {
    AgentExternalSessionCandidate,
    AgentExternalSessionSource,
    AgentExternalSessionTranscriptItem,
    AgentExternalSessionsContribution,
    AgentExternalSessionsFailureCode,
    AgentExternalSessionsListCandidatesResult,
    AgentExternalSessionsReadAfterDiagnostic,
    AgentExternalSessionsReadAfterTranscriptResult,
    AgentExternalSessionsResolveSourceResult,
    AgentExternalSessionsResolvedIdentity,
    AgentExternalSessionsResult,
    AgentExternalSessionsTranscriptPage,
} from '@happier-dev/plugin-sdk/experimental/sessions';

const FAILURE_CODES = new Set<AgentExternalSessionsFailureCode>([
    'source_invalid',
    'source_unreachable',
    'candidate_not_found',
    'agent_unavailable',
    'unsupported',
    'unavailable',
    'not_authorized',
    'invalid_request',
    'cancelled',
    'agent_error',
    'timeout',
]);

const MAX_SOURCE_KIND_CODE_UNITS = 256;
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
const MAX_SOURCE_SERIALIZED_BYTES = 262_144;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_ENTRIES = 256;

export const EXTERNAL_SESSIONS_INVOCATION_POLICY = Object.freeze({
    deadlineMs: 15_000,
    resolveSource: Object.freeze({ maxSerializedBytes: 262_144 }),
    listCandidates: Object.freeze({ maxItems: 50, maxSerializedBytes: 1_048_576 }),
    resolveLinkIdentity: Object.freeze({ maxSerializedBytes: 262_144 }),
    resolveLinkedIdentity: Object.freeze({ maxSerializedBytes: 262_144 }),
    pageTranscript: Object.freeze({ maxItems: 200, maxSerializedBytes: 524_288 }),
    readAfterTranscript: Object.freeze({ maxItems: 200, maxSerializedBytes: 524_288 }),
    sourceKindMaxCodeUnits: MAX_SOURCE_KIND_CODE_UNITS,
    idMaxCodeUnits: MAX_ID_CODE_UNITS,
    titleMaxCodeUnits: MAX_TITLE_CODE_UNITS,
    searchMaxCodeUnits: MAX_SEARCH_CODE_UNITS,
    failureMessageMaxCodeUnits: MAX_FAILURE_MESSAGE_CODE_UNITS,
    nativeCursorMaxCodeUnits: MAX_NATIVE_CURSOR_CODE_UNITS,
    qualifiedCursorMaxCodeUnits: MAX_QUALIFIED_CURSOR_CODE_UNITS,
    sourceMaxSerializedBytes: MAX_SOURCE_SERIALIZED_BYTES,
});

type ContributionIdentity = Readonly<{
    pluginId: string;
    agentId: string;
    generation: string;
}>;

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
type JsonSnapshotState = { entries: number; ancestors: Set<object> };

const textEncoder = new TextEncoder();

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
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(value);
    if (
        keys.some((key) => typeof key !== 'string' || !allowed.has(key))
        || required.some((key) => !keys.includes(key))
    ) {
        return null;
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of keys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
        Object.defineProperty(snapshot, key, {
            configurable: false,
            enumerable: true,
            writable: false,
            value: descriptor.value,
        });
    }
    return Object.freeze(snapshot);
}

function snapshotJsonValue(
    value: unknown,
    depth: number,
    state: JsonSnapshotState,
): PluginAgentExternalSessionLinkDataValue | null | undefined {
    if (depth > MAX_JSON_DEPTH) return undefined;
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'object') return undefined;
    if (state.ancestors.has(value)) return undefined;
    state.ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            const expectedKeys = new Set<PropertyKey>([
                'length',
                ...Array.from({ length: value.length }, (_, index) => String(index)),
            ]);
            const keys = Reflect.ownKeys(value);
            if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) return undefined;
            state.entries += value.length;
            if (state.entries > MAX_JSON_ENTRIES) return undefined;
            const snapshot: PluginAgentExternalSessionLinkDataValue[] = [];
            for (let index = 0; index < value.length; index += 1) {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
                const item = snapshotJsonValue(descriptor.value, depth + 1, state);
                if (item === undefined) return undefined;
                snapshot.push(item);
            }
            return Object.freeze(snapshot);
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return undefined;
        const keys = Reflect.ownKeys(value);
        if (keys.some((key) => typeof key !== 'string')) return undefined;
        state.entries += keys.length;
        if (state.entries > MAX_JSON_ENTRIES) return undefined;
        const snapshot: Record<string, PluginAgentExternalSessionLinkDataValue> = {};
        for (const key of keys as string[]) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
            const item = snapshotJsonValue(descriptor.value, depth + 1, state);
            if (item === undefined) return undefined;
            Object.defineProperty(snapshot, key, {
                configurable: false,
                enumerable: true,
                writable: false,
                value: item,
            });
        }
        return Object.freeze(snapshot);
    } finally {
        state.ancestors.delete(value);
    }
}

function parseSource(value: unknown): AgentExternalSessionSource | null {
    const snapshot = snapshotJsonValue(value, 0, { entries: 0, ancestors: new Set() });
    if (snapshot === undefined || snapshot === null || Array.isArray(snapshot) || typeof snapshot !== 'object') {
        return null;
    }
    const sourceRecord = snapshot as Readonly<Record<string, PluginAgentExternalSessionLinkDataValue>>;
    const kind = sourceRecord.kind;
    if (typeof kind !== 'string' || kind.length === 0 || kind.length > MAX_SOURCE_KIND_CODE_UNITS) return null;
    if (textEncoder.encode(JSON.stringify(sourceRecord)).byteLength > MAX_SOURCE_SERIALIZED_BYTES) return null;
    return sourceRecord as AgentExternalSessionSource;
}

function parseLinkData(value: unknown): PluginAgentExternalSessionLinkData | null {
    const parsed = PluginAgentExternalSessionLinkDataSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function parseBoundedString(value: unknown, maximum: number, allowEmpty = false): string | null {
    return typeof value === 'string'
        && (allowEmpty || value.length > 0)
        && value.length <= maximum
        ? value
        : null;
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
        : parseBoundedString(record.title, MAX_TITLE_CODE_UNITS, true);
    const createdAtMs = record.createdAtMs === undefined ? undefined : parseTimestamp(record.createdAtMs);
    const archived = parseOptionalBoolean(record.archived);
    const linkData = record.linkData === undefined ? undefined : parseLinkData(record.linkData);
    if (
        remoteSessionId === null
        || updatedAtMs === null
        || title === null
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

function parseTranscriptItem(value: unknown): AgentExternalSessionTranscriptItem | null {
    const record = readStrictRecord(value, ['id', 'createdAtMs', 'raw'], ['localId', 'messageRole']);
    if (!record) return null;
    const id = parseBoundedString(record.id, MAX_ID_CODE_UNITS);
    const createdAtMs = parseTimestamp(record.createdAtMs);
    const localId = record.localId === undefined || record.localId === null
        ? record.localId
        : parseBoundedString(record.localId, MAX_ID_CODE_UNITS);
    const role = record.messageRole === undefined || record.messageRole === null
        ? record.messageRole
        : SessionMessageRoleSchema.safeParse(record.messageRole).success
            ? record.messageRole as SessionMessageRole
            : false;
    const raw = parseLinkData(record.raw);
    if (id === null || createdAtMs === null || localId === null || role === false || raw === null) return null;
    return Object.freeze({
        id,
        createdAtMs,
        raw,
        ...(localId === undefined ? {} : { localId }),
        ...(role === undefined ? {} : { messageRole: role }),
    });
}

function canonicalJson(value: PluginAgentExternalSessionLinkDataValue): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const record = value as Readonly<Record<string, PluginAgentExternalSessionLinkDataValue>>;
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] ?? null)}`)
        .join(',')}}`;
}

function sourceDigest(source: AgentExternalSessionSource): string {
    return createHash('sha256').update(canonicalJson(source)).digest('base64url');
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
    if (!record || record.ok !== false || !FAILURE_CODES.has(record.code as AgentExternalSessionsFailureCode)) {
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
    const record = readStrictRecord(value, ['source']);
    const parsedSource = record ? parseSource(record.source) : null;
    return parsedSource ? Object.freeze({ source: parsedSource }) : null;
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
    const record = readStrictRecord(value, ['source', 'remoteSessionId', 'linkData']);
    if (!record) return null;
    const parsedSource = parseSource(record.source);
    const remoteSessionId = parseBoundedString(record.remoteSessionId, MAX_ID_CODE_UNITS);
    const linkData = parseLinkData(record.linkData);
    return parsedSource && remoteSessionId && linkData
        ? Object.freeze({ source: parsedSource, remoteSessionId, linkData })
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
    const record = readStrictRecord(value, ['code', 'count', 'positions']);
    if (
        !record
        || parseBoundedString(record.code, MAX_READ_AFTER_DIAGNOSTIC_CODE_UNITS) === null
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
    const discriminator = readStrictRecord(value, ['outcome'], ['items', 'nextCursor', 'boundary', 'diagnostics']);
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
            const record = readStrictRecord(value, ['outcome', 'items', 'nextCursor', 'boundary'], ['diagnostics']);
            if (
                !record
                || !Array.isArray(record.items)
                || record.items.length > maxItems
                || typeof record.nextCursor !== 'string'
                || record.nextCursor === inputCursor
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
                ...(diagnostics === undefined
                    ? {}
                    : { diagnostics: Object.freeze(diagnostics as AgentExternalSessionsReadAfterDiagnostic[]) }),
            });
        }
        default:
            return null;
    }
}

function parseAndBoundResult<T>(
    value: unknown,
    parseValue: (candidate: unknown) => T | null,
    maxSerializedBytes: number,
): AgentExternalSessionsResult<T> {
    const failure = parseFailure(value);
    if (failure) {
        return textEncoder.encode(JSON.stringify(failure)).byteLength <= maxSerializedBytes
            ? failure
            : agentError();
    }
    const record = readStrictRecord(value, ['ok', 'value']);
    if (!record || record.ok !== true) return agentError();
    const parsedValue = parseValue(record.value);
    if (parsedValue === null) return agentError();
    const result = Object.freeze({ ok: true as const, value: parsedValue });
    return textEncoder.encode(JSON.stringify(result)).byteLength <= maxSerializedBytes ? result : agentError();
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

async function invokeBounded<T>(params: Readonly<{
    signal: AbortSignal;
    retirementSignal: AbortSignal;
    isCurrent(): boolean;
    operation(signal: AbortSignal, deadlineAtMs: number): Promise<unknown> | unknown;
    parse(value: unknown): AgentExternalSessionsResult<T>;
}>): Promise<AgentExternalSessionsResult<T>> {
    if (!params.isCurrent() || params.retirementSignal.aborted) return unavailable();
    if (params.signal.aborted) return cancelled();

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
    const deadlineAtMs = Date.now() + EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs;
    const timer = setTimeout(() => finish('timeout'), EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs);
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
        if (!params.isCurrent() || params.retirementSignal.aborted || terminal === 'retired') return unavailable();
        if (params.signal.aborted || terminal === 'cancelled') return cancelled();
        if (terminal === 'timeout' || outcome.status === 'terminal') return timeout();
        if (outcome.status === 'rejected') return agentError();
        return params.parse(outcome.value);
    } finally {
        clearTimeout(timer);
        params.retirementSignal.removeEventListener('abort', retire);
        params.signal.removeEventListener('abort', cancel);
    }
}

export function createBoundedAgentExternalSessionsContribution(params: Readonly<{
    contribution: AgentExternalSessionsContribution;
    identity: ContributionIdentity;
    isCurrent(): boolean;
    retirementSignal: AbortSignal;
}>): AgentExternalSessionsContribution {
    const terminalBeforeAdmission = (signal: AbortSignal): AgentExternalSessionsResult<never> | null => {
        if (!params.isCurrent() || params.retirementSignal.aborted) return unavailable();
        if (signal.aborted) return cancelled();
        return null;
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
                operation: (signal, deadlineAtMs) => params.contribution.resolveSource({
                    source: parsedSource,
                    signal,
                    deadlineAtMs,
                    maxSerializedBytes,
                }),
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
                operation: (signal, deadlineAtMs) => params.contribution.listCandidates({
                    source: parsedSource,
                    signal,
                    deadlineAtMs,
                    maxSerializedBytes,
                    maxItems,
                    ...(typeof cursor === 'string' ? { cursor } : {}),
                    ...(searchTerm === undefined ? {} : { searchTerm }),
                    ...(request.searchMode === undefined ? {} : { searchMode: request.searchMode }),
                }),
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
                operation: (signal, deadlineAtMs) => params.contribution.resolveLinkIdentity({
                    source: parsedSource,
                    remoteSessionId,
                    ...(linkData === undefined ? {} : { linkData }),
                    signal,
                    deadlineAtMs,
                    maxSerializedBytes,
                }),
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
                operation: (signal, deadlineAtMs) => params.contribution.resolveLinkedIdentity({
                    source: parsedSource,
                    remoteSessionId,
                    linkData,
                    signal,
                    deadlineAtMs,
                    maxSerializedBytes,
                }),
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
                operation: (signal, deadlineAtMs) => params.contribution.pageTranscript({
                    source: parsedSource,
                    remoteSessionId,
                    direction: request.direction,
                    signal,
                    deadlineAtMs,
                    maxSerializedBytes,
                    maxItems,
                    ...(typeof cursor === 'string' ? { cursor } : {}),
                }),
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
                operation: (signal, deadlineAtMs) => params.contribution.readAfterTranscript({
                    source: parsedSource,
                    remoteSessionId,
                    cursor,
                    signal,
                    deadlineAtMs,
                    maxSerializedBytes,
                    maxItems,
                }),
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
    } satisfies AgentExternalSessionsContribution);
    return wrap;
}
