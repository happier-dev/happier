import { createHash } from 'node:crypto';
import {
    chmod,
    mkdir,
    open,
    stat,
    unlink,
    type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type {
    ExternalSessionsSource,
    PluginContributionIdentityV1,
} from '@happier-dev/protocol';
import {
    compareExternalSessionCandidatePrecedence,
    resolveExternalSessionCandidateIdentityKey,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
    ExternalSessionProviderFailureError,
    type ExternalSessionCandidatesPage,
    type ExternalSessionExecutionSurface,
} from '@/session/external/providerOps';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from '@/session/external/agentExternalSessionsInvocation';
import { preservesExternalSessionSourceIdentity } from '@/session/external/sourceIdentity';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeBytesAtomic, writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

type StrictJson =
    | null
    | boolean
    | number
    | string
    | readonly StrictJson[]
    | Readonly<{ [key: string]: StrictJson }>;

type StrictJsonObject = Readonly<{ [key: string]: StrictJson }>;

/**
 * `title` is the one content-derived field the index persists, by approved
 * amendment (2026-08-07): a session's FIRST user message is immutable, so it is
 * not volatile state, and a partial page is served without hydration — without
 * it, every row of every in-progress build is a bare identifier, which on a
 * large corpus is the permanent state. It is stored only when the source chunk
 * supplies it; the host never derives, hydrates or invents one here.
 */
type StoredCandidate = Readonly<{
    remoteSessionId: string;
    updatedAtMs: number;
    createdAtMs?: number;
    archived?: boolean;
    title?: string;
    linkData?: StrictJsonObject;
}>;

type PersistedCompleteCandidate = StoredCandidate & Readonly<{
    indexOrdinal: number;
    contentAddressDigest: string;
}>;

type CandidateCorpusDigest = Readonly<{
    v: 1;
    digest: string;
    count: number;
}>;

type CandidateIndexValidation = Readonly<{
    scanCursor: string;
    scanned: number;
    total?: number;
    corpus: CandidateCorpusDigest;
    continuationHistory: readonly string[];
}>;

type CandidateIndexRecord = Readonly<{
    v: 2;
    state: 'building' | 'complete';
    agentKey: string;
    sourceKey: string;
    /**
     * Digest of {@link head}: the published identity of the first chunk this
     * generation is anchored to. A completed generation keeps only this, because
     * a completed index has nothing left to absorb — any first-chunk difference
     * is a new generation.
     */
    startToken: string;
    /**
     * The anchor rows themselves, kept only while the crawl is still in progress
     * so an arrival ahead of the anchor can be told apart from a change inside
     * the region already crawled. Bounded by {@link INDEX_SCAN_CHUNK_LIMIT}
     * entries of a fixed width, so it stays inside the record envelope the file
     * ceiling already reserves outside the candidate byte budget.
     */
    head?: readonly string[];
    scanCursor: string | null;
    scanned: number;
    total?: number;
    corpus: CandidateCorpusDigest;
    validation?: CandidateIndexValidation;
    continuationHistory?: readonly string[];
    indexGeneration?: string;
    /**
     * The Agent runtime generation that produced these rows, or `null` when the
     * caller resolved no generation. `agentKey` names the Agent contribution, not
     * the code behind it: a reload or upgrade keeps the same key while replacing
     * the leaf that decides what a candidate is, what its `linkData` means, and
     * which sessions the corpus contains. Without this, a successor would serve
     * its predecessor's persisted rows and replay their `linkData` into its own
     * link path. A record from another generation is not parsed at all, so the
     * root request rebuilds and a continuation minted against it resets.
     */
    runtimeGeneration: string | null;
    candidates: readonly StoredCandidate[];
}>;

type CandidateIndexCursor = Readonly<{
    v: 2;
    kind: 'external_session_candidate_index';
    agentKey: string;
    sourceKey: string;
    runtimeGeneration: string | null;
    indexGeneration: string;
    offset: number;
    byteOffset: number;
    pageLength: number;
    pageDigest: string;
}>;

type CandidateIndexFileIdentity = Readonly<{
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
}>;

const INDEX_CURSOR_PREFIX = 'happier_external_candidate_index_v1:';
const MAX_INDEX_CANDIDATES = 250_000;
const MAX_INDEX_SERIALIZED_BYTES = 64 * 1024 * 1024;
const MAX_INDEX_FILE_BYTES = MAX_INDEX_SERIALIZED_BYTES + (16 * 1024);
const INDEX_SCAN_CHUNK_LIMIT = 50;
// A fast 10k crawl fits one slice; slower leaves checkpoint often enough to keep Browse progress responsive.
const INDEX_CONTINUATION_CALL_LIMIT = 250;
const INDEX_CONTINUATION_WORK_BUDGET_MS = 250;
const MAX_INDEX_CONTINUATION_STEPS = MAX_INDEX_CANDIDATES;
const MAX_INDEX_CONTINUATION_HISTORY_SERIALIZED_BYTES = 1 + (67 * MAX_INDEX_CONTINUATION_STEPS);
const CORPUS_DIGEST_VERSION = 1;
const EMPTY_CORPUS_DIGEST = digest('happier-external-session-candidate-corpus-v1');
const COMPLETE_INDEX_HEADER_READ_BYTES = 16 * 1024;
const INDEX_PAGE_READ_CHUNK_BYTES = 64 * 1024;
const CORRUPT_CANDIDATE_INDEX_BODY = Symbol('corrupt_candidate_index_body');

function snapshotCandidateIndexFileIdentity(
    stats: Readonly<{
        dev: bigint;
        ino: bigint;
        size: bigint;
        mtimeNs: bigint;
        ctimeNs: bigint;
    }>,
): CandidateIndexFileIdentity {
    return Object.freeze({
        dev: stats.dev,
        ino: stats.ino,
        size: stats.size,
        mtimeNs: stats.mtimeNs,
        ctimeNs: stats.ctimeNs,
    });
}

async function readCandidateIndexHandleIdentity(
    handle: FileHandle,
): Promise<CandidateIndexFileIdentity | null> {
    const stats = await handle.stat({ bigint: true }).catch(() => null);
    return stats ? snapshotCandidateIndexFileIdentity(stats) : null;
}

async function readCandidateIndexPathIdentity(
    path: string,
): Promise<CandidateIndexFileIdentity | null> {
    const stats = await stat(path, { bigint: true }).catch(() => null);
    return stats ? snapshotCandidateIndexFileIdentity(stats) : null;
}

function candidateIndexFileIdentitiesEqual(
    left: CandidateIndexFileIdentity | null,
    right: CandidateIndexFileIdentity | null,
): boolean {
    return left !== null
        && right !== null
        && left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}

export function isExternalSessionCandidateIndexStateWithinByteCapacity(
    candidatesSerializedBytes: number,
    continuationStateSerializedBytes: number,
): boolean {
    return Number.isSafeInteger(candidatesSerializedBytes)
        && candidatesSerializedBytes >= 0
        && candidatesSerializedBytes <= MAX_INDEX_SERIALIZED_BYTES
        && Number.isSafeInteger(continuationStateSerializedBytes)
        && continuationStateSerializedBytes >= 0
        && continuationStateSerializedBytes
            <= MAX_INDEX_SERIALIZED_BYTES - candidatesSerializedBytes;
}

export function isExternalSessionCandidateIndexContinuationStepCountWithinCapacity(
    continuationSteps: number,
): boolean {
    return Number.isSafeInteger(continuationSteps)
        && continuationSteps >= 0
        && continuationSteps <= MAX_INDEX_CONTINUATION_STEPS;
}

export function isExternalSessionCandidateIndexSourceWorkWithinCapacity(
    scanned: unknown,
    total?: unknown,
): boolean {
    return typeof scanned === 'number'
        && Number.isSafeInteger(scanned)
        && scanned >= 0
        && scanned <= MAX_INDEX_CANDIDATES
        && (
            total === undefined
            || (
                typeof total === 'number'
                &&
                Number.isSafeInteger(total)
                && total >= scanned
                && total <= MAX_INDEX_CANDIDATES
            )
        );
}

function assertCandidateIndexStateWithinByteCapacity(
    candidatesSerializedBytes: number,
    continuationStateSerializedBytes: number,
): void {
    if (isExternalSessionCandidateIndexStateWithinByteCapacity(
        candidatesSerializedBytes,
        continuationStateSerializedBytes,
    )) return;
    throw new ExternalSessionProviderFailureError({
        code: 'invalid_request',
        operation: 'listCandidates',
        message: 'External-session candidate index byte capacity exceeded',
        retryable: false,
    });
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('Candidate-index identity contains a non-finite number');
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (!value || typeof value !== 'object') {
        throw new Error('Candidate-index identity is not strict JSON');
    }
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(',')}}`;
}

function digest(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

type CandidateIndexKeys = Readonly<{
    agentKey: string;
    sourceKey: string;
    runtimeGeneration: string | null;
}>;

function resolveKeys(
    agentIdentity: PluginContributionIdentityV1,
    source: unknown,
    runtimeGeneration: string | null,
): CandidateIndexKeys {
    const agentKey = digest(`${agentIdentity.pluginId}\u0000${agentIdentity.localId}`);
    const sourceKey = digest(canonicalJson(source));
    return Object.freeze({
        agentKey,
        sourceKey,
        runtimeGeneration,
    });
}

function resolvePaths(
    activeServerDir: string,
    keys: CandidateIndexKeys,
): Readonly<{ directory: string; indexPath: string; lockPath: string }> {
    const directory = join(
        activeServerDir,
        'external-sessions',
        'candidate-indexes',
        'v1',
        keys.agentKey,
        keys.sourceKey,
    );
    return Object.freeze({
        directory,
        indexPath: join(directory, 'index.json'),
        lockPath: join(directory, 'index.lock'),
    });
}

async function ensurePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(path, 0o700);
}

/**
 * Queueing for the candidate-index lock is unbounded work done on the caller's
 * behalf — up to the 15s admission budget before a single byte of the build
 * runs. A browse that was superseded or closed must stop queueing rather than
 * acquire the lock and start crawling for nobody, so the caller's own signal is
 * the admission fence. It never interrupts an effect that already holds the
 * lock: a half-applied index write is worse than a redundant one.
 */
async function withCandidateIndexLock<TResult>(
    lockPath: string,
    signal: AbortSignal | undefined,
    effect: () => Promise<TResult>,
): Promise<TResult> {
    return await withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 15_000,
        staleAfterMs: 30_000,
        errorCode: 'external_session_candidate_index_lock_timeout',
        pollIntervalMs: 10,
        ...(signal === undefined ? {} : { signal }),
    }, effect);
}

function readStrictJson(value: unknown): StrictJson | null {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) {
        const items = value.map(readStrictJson);
        return items.some((item, index) => item === null && value[index] !== null)
            ? null
            : Object.freeze(items as StrictJson[]);
    }
    if (!value || typeof value !== 'object') return null;
    const record = value as Readonly<Record<string, unknown>>;
    const parsed: Record<string, StrictJson> = {};
    for (const [key, item] of Object.entries(record)) {
        const next = readStrictJson(item);
        if (next === null && item !== null) return null;
        parsed[key] = next;
    }
    return Object.freeze(parsed);
}

function sanitizeCandidate(value: ExternalSessionCandidatesPage['candidates'][number]): StoredCandidate | null {
    if (
        typeof value.remoteSessionId !== 'string'
        || value.remoteSessionId.length === 0
        || !Number.isSafeInteger(value.updatedAtMs)
        || (value.createdAtMs !== undefined && !Number.isSafeInteger(value.createdAtMs))
        || (value.archived !== undefined && typeof value.archived !== 'boolean')
        || (
            value.title !== undefined
            && (typeof value.title !== 'string' || value.title.length === 0)
        )
    ) return null;
    const rawLinkData = Reflect.get(value as object, 'linkData');
    const parsedLinkData = rawLinkData === undefined ? undefined : readStrictJson(rawLinkData);
    if (
        rawLinkData !== undefined
        && (
            !parsedLinkData
            || typeof parsedLinkData !== 'object'
            || Array.isArray(parsedLinkData)
        )
    ) return null;
    const linkData = parsedLinkData as StrictJsonObject | undefined;
    return Object.freeze({
        remoteSessionId: value.remoteSessionId,
        updatedAtMs: value.updatedAtMs,
        ...(value.createdAtMs === undefined ? {} : { createdAtMs: value.createdAtMs }),
        ...(value.archived === undefined ? {} : { archived: value.archived }),
        ...(value.title === undefined ? {} : { title: value.title }),
        ...(linkData === undefined ? {} : { linkData }),
    });
}

export { resolveExternalSessionCandidateIdentityKey };

function candidateIdentity(candidate: StoredCandidate): string {
    return resolveExternalSessionCandidateIdentityKey(candidate);
}

export async function hydrateExternalSessionCandidateThroughAgentSource(params: Readonly<{
    source: ExternalSessionsSource;
    candidate: Readonly<{
        remoteSessionId: string;
        updatedAtMs: number;
        createdAtMs?: number;
        archived?: boolean;
        linkData?: StrictJsonObject;
    }>;
    providerOps: Pick<ExternalSessionExecutionSurface, 'listCandidates' | 'resolveLinkIdentity'>;
    maxBytes?: number;
    signal?: AbortSignal;
}>): Promise<ExternalSessionCandidatesPage['candidates'][number]> {
    if (!params.providerOps.resolveLinkIdentity || !params.providerOps.listCandidates) {
        throw new ExternalSessionProviderFailureError({
            code: 'agent_unavailable',
            operation: 'listCandidates',
            message: 'External-session candidate hydration is unavailable',
            retryable: true,
        });
    }
    const resolved = await params.providerOps.resolveLinkIdentity({
        source: params.source,
        remoteSessionId: params.candidate.remoteSessionId,
        metadata: params.candidate.linkData === undefined
            ? {}
            : { linkData: params.candidate.linkData },
        ...(params.signal === undefined ? {} : { signal: params.signal }),
    });
    if (
        resolved.remoteSessionId !== params.candidate.remoteSessionId
        || !preservesExternalSessionSourceIdentity(params.source, resolved.source)
    ) {
        throw new ExternalSessionProviderFailureError({
            code: 'source_invalid',
            operation: 'resolveLinkIdentity',
            message: 'External-session candidate identity rewrote admitted source identity',
        });
    }
    const expectedIdentity = candidateIdentity(params.candidate);
    let page = await params.providerOps.listCandidates({
        source: resolved.source,
        limit: 1,
        searchTerm: params.candidate.remoteSessionId,
        searchMode: 'fast',
        ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }),
        ...(params.signal === undefined ? {} : { signal: params.signal }),
    });
    let continuationCalls = 0;
    const continuationCursors = new Set<string>();
    while (true) {
        const hydrated = page.candidates.find(
            (candidate) => resolveExternalSessionCandidateIdentityKey(candidate) === expectedIdentity,
        );
        if (hydrated) return hydrated;
        if (
            page.nextCursor === null
            || continuationCalls >= INDEX_CONTINUATION_CALL_LIMIT
        ) break;
        const cursor = page.nextCursor;
        if (continuationCursors.has(cursor)) break;
        continuationCursors.add(cursor);
        continuationCalls += 1;
        page = await params.providerOps.listCandidates({
            source: resolved.source,
            cursor,
            limit: 1,
            searchTerm: params.candidate.remoteSessionId,
            searchMode: 'fast',
            ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }),
            ...(params.signal === undefined ? {} : { signal: params.signal }),
        });
    }
    throw new ExternalSessionProviderFailureError({
        code: 'candidate_not_found',
        operation: 'listCandidates',
        message: 'External-session candidate disappeared while hydrating an indexed page',
        retryable: true,
    });
}

function emptyCorpusDigest(): CandidateCorpusDigest {
    return Object.freeze({
        v: CORPUS_DIGEST_VERSION,
        digest: EMPTY_CORPUS_DIGEST,
        count: 0,
    });
}

function extendCorpusDigest(
    current: CandidateCorpusDigest,
    candidates: readonly StoredCandidate[],
): CandidateCorpusDigest {
    let nextDigest = current.digest;
    let nextCount = current.count;
    for (const candidate of candidates) {
        nextDigest = digest(canonicalJson({
            v: CORPUS_DIGEST_VERSION,
            previous: nextDigest,
            candidate,
        }));
        nextCount += 1;
    }
    return Object.freeze({
        v: CORPUS_DIGEST_VERSION,
        digest: nextDigest,
        count: nextCount,
    });
}

function corpusDigestsEqual(
    left: CandidateCorpusDigest,
    right: CandidateCorpusDigest,
): boolean {
    return left.v === right.v
        && left.digest === right.digest
        && left.count === right.count;
}

function compareCandidates(left: StoredCandidate, right: StoredCandidate): number {
    return compareExternalSessionCandidatePrecedence(left, right);
}

function sortCandidates(candidates: readonly StoredCandidate[]): readonly StoredCandidate[] {
    return Object.freeze([...candidates].sort(compareCandidates));
}

function computeIndexGeneration(
    corpus: CandidateCorpusDigest,
    sortedCandidates: readonly StoredCandidate[],
): string {
    return digest(canonicalJson({
        v: CORPUS_DIGEST_VERSION,
        corpus,
        candidates: sortedCandidates,
    }));
}

function computePersistedCandidateDigest(
    indexGeneration: string,
    candidateCount: number,
    indexOrdinal: number,
    candidate: StoredCandidate,
): string {
    return digest(canonicalJson({
        v: 1,
        indexGeneration,
        candidateCount,
        indexOrdinal,
        candidate,
    }));
}

function createCandidateAccumulator(current: readonly StoredCandidate[]): Readonly<{
    candidates: Map<string, StoredCandidate>;
    serializedEntryBytes: Map<string, number>;
    serializedBytes: { value: number };
}> {
    const candidates = new Map<string, StoredCandidate>();
    const serializedEntryBytes = new Map<string, number>();
    let serializedBytes = 2;
    for (const candidate of current) {
        const identity = candidateIdentity(candidate);
        const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
        if (!candidates.has(identity)) serializedBytes += candidates.size === 0 ? candidateBytes : candidateBytes + 1;
        else serializedBytes += candidateBytes - (serializedEntryBytes.get(identity) ?? 0);
        candidates.set(identity, candidate);
        serializedEntryBytes.set(identity, candidateBytes);
    }
    return {
        candidates,
        serializedEntryBytes,
        serializedBytes: { value: serializedBytes },
    };
}

function appendCandidateChunk(
    accumulator: ReturnType<typeof createCandidateAccumulator>,
    next: readonly StoredCandidate[],
): void {
    for (const candidate of next) {
        const identity = candidateIdentity(candidate);
        const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
        const previousBytes = accumulator.serializedEntryBytes.get(identity);
        accumulator.serializedBytes.value += previousBytes === undefined
            ? (accumulator.candidates.size === 0 ? candidateBytes : candidateBytes + 1)
            : candidateBytes - previousBytes;
        accumulator.candidates.set(identity, candidate);
        accumulator.serializedEntryBytes.set(identity, candidateBytes);
    }
    if (accumulator.candidates.size > MAX_INDEX_CANDIDATES) {
        throw new ExternalSessionProviderFailureError({
            code: 'invalid_request',
            operation: 'listCandidates',
            message: 'External-session candidate index capacity exceeded',
            retryable: false,
        });
    }
    assertCandidateIndexStateWithinByteCapacity(accumulator.serializedBytes.value, 0);
}

function isExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(record).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]);
}

function parseStoredCandidate(value: unknown): StoredCandidate | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const optionalKeys = ['createdAtMs', 'archived', 'title', 'linkData'].filter((key) => record[key] !== undefined);
    if (!isExactKeys(record, ['remoteSessionId', 'updatedAtMs', ...optionalKeys])) return null;
    return sanitizeCandidate(record as ExternalSessionCandidatesPage['candidates'][number]);
}

function parsePersistedCompleteCandidate(
    value: unknown,
    indexGeneration: string,
    candidateCount: number,
    expectedOrdinal: number,
): StoredCandidate | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const optionalKeys = ['createdAtMs', 'archived', 'title', 'linkData'].filter((key) => record[key] !== undefined);
    if (!isExactKeys(record, [
        'remoteSessionId',
        'updatedAtMs',
        'indexOrdinal',
        'contentAddressDigest',
        ...optionalKeys,
    ])) return null;
    if (
        record.indexOrdinal !== expectedOrdinal
        || typeof record.contentAddressDigest !== 'string'
        || !/^[a-f0-9]{64}$/.test(record.contentAddressDigest)
    ) return null;
    const candidate = sanitizeCandidate(record as ExternalSessionCandidatesPage['candidates'][number]);
    if (
        !candidate
        || record.contentAddressDigest !== computePersistedCandidateDigest(
            indexGeneration,
            candidateCount,
            expectedOrdinal,
            candidate,
        )
    ) return null;
    return candidate;
}

function parseHeadAnchor(value: unknown): readonly string[] | null {
    if (
        !Array.isArray(value)
        || value.length > INDEX_SCAN_CHUNK_LIMIT
        || value.some((entry) => typeof entry !== 'string' || !HEAD_ANCHOR_ENTRY_PATTERN.test(entry))
    ) return null;
    return Object.freeze([...value] as string[]);
}

function parseCorpusDigest(value: unknown): CandidateCorpusDigest | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
        !isExactKeys(record, ['v', 'digest', 'count'])
        || record.v !== CORPUS_DIGEST_VERSION
        || typeof record.digest !== 'string'
        || !/^[a-f0-9]{64}$/.test(record.digest)
        || !Number.isSafeInteger(record.count)
        || (record.count as number) < 0
    ) return null;
    return Object.freeze({
        v: CORPUS_DIGEST_VERSION,
        digest: record.digest,
        count: record.count as number,
    });
}

function continuationCursorIdentity(cursor: string): string {
    return digest(cursor);
}

type ContinuationHistoryAccumulator = {
    identities: string[];
    identitySet: Set<string>;
    serializedBytes: number;
};

function createContinuationHistoryAccumulator(
    history: readonly string[],
): ContinuationHistoryAccumulator {
    return {
        identities: [...history],
        identitySet: new Set(history),
        serializedBytes: Buffer.byteLength(JSON.stringify(history), 'utf8'),
    };
}

function snapshotContinuationHistory(
    accumulator: ContinuationHistoryAccumulator,
): readonly string[] {
    return Object.freeze([...accumulator.identities]);
}

function parseContinuationHistory(value: unknown): readonly string[] | null {
    if (
        !Array.isArray(value)
        || !isExternalSessionCandidateIndexContinuationStepCountWithinCapacity(value.length)
        || Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_INDEX_CONTINUATION_HISTORY_SERIALIZED_BYTES
        || value.some((entry) => typeof entry !== 'string' || !/^[a-f0-9]{64}$/.test(entry))
        || new Set(value).size !== value.length
    ) return null;
    return Object.freeze([...value] as string[]);
}

function parseValidation(value: unknown): CandidateIndexValidation | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const optionalKeys = ['total'].filter((key) => record[key] !== undefined);
    if (
        !isExactKeys(record, ['scanCursor', 'scanned', 'corpus', 'continuationHistory', ...optionalKeys])
        || typeof record.scanCursor !== 'string'
        || record.scanCursor.length === 0
        || !isExternalSessionCandidateIndexSourceWorkWithinCapacity(
            record.scanned,
            record.total,
        )
    ) return null;
    const corpus = parseCorpusDigest(record.corpus);
    const continuationHistory = parseContinuationHistory(record.continuationHistory);
    if (
        !corpus
        || !continuationHistory
        || continuationHistory.at(-1) !== continuationCursorIdentity(record.scanCursor)
    ) return null;
    return Object.freeze({
        scanCursor: record.scanCursor,
        scanned: record.scanned as number,
        ...(record.total === undefined ? {} : { total: record.total as number }),
        corpus,
        continuationHistory,
    });
}

function parseIndexRecord(
    raw: string,
    expected: CandidateIndexKeys,
): CandidateIndexRecord | null {
    try {
        const value = JSON.parse(raw) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const record = value as Record<string, unknown>;
        const optionalKeys = [
            'total',
            'head',
            'validation',
            'continuationHistory',
            'indexGeneration',
            'candidateCount',
        ].filter(
            (key) => record[key] !== undefined,
        );
        if (!isExactKeys(record, [
            'v',
            'state',
            'agentKey',
            'sourceKey',
            'runtimeGeneration',
            'startToken',
            'scanCursor',
            'scanned',
            'corpus',
            'candidates',
            ...optionalKeys,
        ])) return null;
        if (
            record.v !== 2
            || (record.state !== 'building' && record.state !== 'complete')
            || record.agentKey !== expected.agentKey
            || record.sourceKey !== expected.sourceKey
            || (record.runtimeGeneration !== null && typeof record.runtimeGeneration !== 'string')
            || record.runtimeGeneration !== expected.runtimeGeneration
            || typeof record.startToken !== 'string'
            || record.startToken.length === 0
            || (record.scanCursor !== null && typeof record.scanCursor !== 'string')
            || !isExternalSessionCandidateIndexSourceWorkWithinCapacity(
                record.scanned,
                record.total,
            )
            || !Array.isArray(record.candidates)
            || (record.state === 'building' && record.head === undefined)
            || (record.state === 'complete' && record.head !== undefined)
            || (record.state === 'building' && record.indexGeneration !== undefined)
            || (record.state === 'building' && record.candidateCount !== undefined)
            || (record.state === 'building' && record.continuationHistory === undefined)
            || (record.state === 'complete' && record.continuationHistory !== undefined)
            || (
                record.state === 'complete'
                && (
                    typeof record.indexGeneration !== 'string'
                    || !/^[a-f0-9]{64}$/.test(record.indexGeneration)
                    || !Number.isSafeInteger(record.candidateCount)
                    || (record.candidateCount as number) < 0
                    || record.candidateCount !== record.candidates.length
                )
            )
            || (record.state === 'complete' && record.scanCursor !== null)
        ) return null;
        const head = record.head === undefined ? undefined : parseHeadAnchor(record.head);
        if (
            head === null
            || (head !== undefined && record.startToken !== candidateHeadAnchorToken(head))
        ) return null;
        const candidates = record.state === 'complete'
            ? record.candidates.map((candidate, index) => parsePersistedCompleteCandidate(
                candidate,
                record.indexGeneration as string,
                record.candidateCount as number,
                index,
            ))
            : record.candidates.map(parseStoredCandidate);
        if (candidates.some((candidate) => candidate === null)) return null;
        const corpus = parseCorpusDigest(record.corpus);
        if (!corpus) return null;
        const continuationHistory = record.continuationHistory === undefined
            ? undefined
            : parseContinuationHistory(record.continuationHistory);
        if (continuationHistory === null) return null;
        if (
            record.state === 'building'
            && (
                !continuationHistory
                || (
                    record.scanCursor === null
                        ? continuationHistory.length !== 0
                        : continuationHistory.at(-1) !== continuationCursorIdentity(record.scanCursor)
                )
            )
        ) return null;
        const parsedCandidates = Object.freeze(candidates as StoredCandidate[]);
        const candidatesSerializedBytes = Buffer.byteLength(JSON.stringify(record.candidates), 'utf8');
        if (
            parsedCandidates.length > MAX_INDEX_CANDIDATES
            || candidatesSerializedBytes > MAX_INDEX_SERIALIZED_BYTES
        ) return null;
        if (
            record.state === 'building'
            && !corpusDigestsEqual(
                corpus,
                extendCorpusDigest(emptyCorpusDigest(), parsedCandidates),
            )
        ) return null;
        if (record.state === 'complete') {
            const sortedCandidates = sortCandidates(parsedCandidates);
            if (
                canonicalJson(parsedCandidates) !== canonicalJson(sortedCandidates)
                || record.indexGeneration !== computeIndexGeneration(corpus, sortedCandidates)
            ) return null;
        }
        let validation: CandidateIndexValidation | undefined;
        if (record.validation !== undefined) {
            const parsedValidation = parseValidation(record.validation);
            if (!parsedValidation) return null;
            validation = parsedValidation;
        }
        const continuationStateBytes = (
            continuationHistory === undefined
                ? 0
                : Buffer.byteLength(JSON.stringify(continuationHistory), 'utf8')
        ) + (
            validation === undefined
                ? 0
                : Buffer.byteLength(JSON.stringify(validation.continuationHistory), 'utf8')
        );
        if (!isExternalSessionCandidateIndexStateWithinByteCapacity(
            candidatesSerializedBytes,
            continuationStateBytes,
        )) {
            return null;
        }
        return Object.freeze({
            v: 2,
            state: record.state,
            agentKey: expected.agentKey,
            sourceKey: expected.sourceKey,
            runtimeGeneration: expected.runtimeGeneration,
            startToken: record.startToken,
            ...(head === undefined ? {} : { head }),
            scanCursor: record.scanCursor as string | null,
            scanned: record.scanned as number,
            ...(record.total === undefined ? {} : { total: record.total as number }),
            corpus,
            ...(validation === undefined ? {} : { validation }),
            ...(continuationHistory === undefined ? {} : { continuationHistory }),
            ...(record.indexGeneration === undefined ? {} : { indexGeneration: record.indexGeneration as string }),
            candidates: parsedCandidates,
        });
    } catch {
        return null;
    }
}

async function readIndexRecord(
    indexPath: string,
    expected: CandidateIndexKeys,
): Promise<CandidateIndexRecord | null> {
    const handle = await open(indexPath, 'r').catch(() => null);
    if (!handle) return null;
    try {
        const stats = await handle.stat({ bigint: true }).catch(() => null);
        if (
            !stats
            || stats.size < 1n
            || stats.size > BigInt(MAX_INDEX_FILE_BYTES)
        ) return null;
        const buffer = Buffer.alloc(Number(stats.size));
        let bytesRead = 0;
        while (bytesRead < buffer.byteLength) {
            const result = await handle.read(
                buffer,
                bytesRead,
                buffer.byteLength - bytesRead,
                bytesRead,
            );
            if (result.bytesRead === 0) return null;
            bytesRead += result.bytesRead;
        }
        return parseIndexRecord(buffer.toString('utf8'), expected);
    } finally {
        await handle.close();
    }
}

type CompleteCandidateIndexHeader = Readonly<{
    v: 2;
    state: 'complete';
    agentKey: string;
    sourceKey: string;
    runtimeGeneration: string | null;
    startToken: string;
    scanCursor: null;
    scanned: number;
    total?: number;
    corpus: CandidateCorpusDigest;
    indexGeneration: string;
    candidateCount: number;
    candidatesByteOffset: number;
}>;

type SerializedCompleteCandidateIndex = Readonly<{
    bytes: Uint8Array;
    candidateByteOffsets: readonly number[];
}>;

/**
 * The one serializer for every completed-generation write, including a warm
 * validation checkpoint. `candidates` stays the last member of the object and
 * every row carries its ordinal and content address, so the page-addressable
 * reader keeps its bounded header window and its byte offsets. A validation
 * checkpoint is written as a trailer after the array rather than a header field
 * because its continuation history is bounded only by the candidate ceiling and
 * would otherwise push `"candidates":[` past the header read window.
 */
function serializeCompleteIndexRecord(
    record: CandidateIndexRecord,
): SerializedCompleteCandidateIndex {
    if (record.state !== 'complete' || !record.indexGeneration) {
        throw new Error('Candidate index must be complete before page-addressable serialization');
    }
    const header = {
        v: 2,
        state: 'complete',
        agentKey: record.agentKey,
        sourceKey: record.sourceKey,
        runtimeGeneration: record.runtimeGeneration,
        startToken: record.startToken,
        scanCursor: null,
        scanned: record.scanned,
        ...(record.total === undefined ? {} : { total: record.total }),
        corpus: record.corpus,
        indexGeneration: record.indexGeneration,
        candidateCount: record.candidates.length,
    } as const;
    const prefix = Buffer.from(`${JSON.stringify(header).slice(0, -1)},"candidates":[`, 'utf8');
    const suffix = Buffer.from(
        record.validation === undefined
            ? ']}\n'
            : `],"validation":${JSON.stringify(record.validation)}}\n`,
        'utf8',
    );
    const segments: Buffer[] = [prefix];
    const candidateByteOffsets: number[] = [];
    let byteOffset = prefix.byteLength;
    for (const [index, candidate] of record.candidates.entries()) {
        if (index > 0) {
            segments.push(Buffer.from(','));
            byteOffset += 1;
        }
        candidateByteOffsets.push(byteOffset);
        const persistedCandidate: PersistedCompleteCandidate = Object.freeze({
            ...candidate,
            indexOrdinal: index,
            contentAddressDigest: computePersistedCandidateDigest(
                record.indexGeneration,
                record.candidates.length,
                index,
                candidate,
            ),
        });
        const serialized = Buffer.from(JSON.stringify(persistedCandidate), 'utf8');
        segments.push(serialized);
        byteOffset += serialized.byteLength;
    }
    segments.push(suffix);
    return Object.freeze({
        bytes: Buffer.concat(segments),
        candidateByteOffsets: Object.freeze(candidateByteOffsets),
    });
}

async function writeCompleteIndexRecord(
    indexPath: string,
    record: CandidateIndexRecord,
): Promise<SerializedCompleteCandidateIndex> {
    const serialized = serializeCompleteIndexRecord(record);
    assertCandidateIndexStateWithinByteCapacity(serialized.bytes.byteLength, 0);
    await writeBytesAtomic(indexPath, serialized.bytes);
    return serialized;
}

/**
 * The single persistence owner for the candidate index. A completed generation
 * — with or without a validation checkpoint — always goes through the
 * page-addressable serializer, so a checkpoint can never persist a complete
 * record the reader rejects and cold-rebuilds.
 */
async function writeIndexRecord(
    indexPath: string,
    record: CandidateIndexRecord,
): Promise<void> {
    if (record.state === 'complete') {
        await writeCompleteIndexRecord(indexPath, record);
        return;
    }
    await writeJsonAtomic(indexPath, record);
}

function parseCompleteIndexHeader(
    raw: string,
    candidatesByteOffset: number,
    expected: CandidateIndexKeys,
): CompleteCandidateIndexHeader | null {
    try {
        const value = JSON.parse(raw) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const record = value as Record<string, unknown>;
        const optionalKeys = ['total'].filter((key) => record[key] !== undefined);
        if (!isExactKeys(record, [
            'v',
            'state',
            'agentKey',
            'sourceKey',
            'runtimeGeneration',
            'startToken',
            'scanCursor',
            'scanned',
            'corpus',
            'indexGeneration',
            'candidateCount',
            'candidates',
            ...optionalKeys,
        ])) return null;
        const corpus = parseCorpusDigest(record.corpus);
        if (
            record.v !== 2
            || record.state !== 'complete'
            || record.agentKey !== expected.agentKey
            || record.sourceKey !== expected.sourceKey
            || (record.runtimeGeneration !== null && typeof record.runtimeGeneration !== 'string')
            || record.runtimeGeneration !== expected.runtimeGeneration
            || typeof record.startToken !== 'string'
            || record.startToken.length === 0
            || record.scanCursor !== null
            || !isExternalSessionCandidateIndexSourceWorkWithinCapacity(record.scanned, record.total)
            || !corpus
            || !Array.isArray(record.candidates)
            || record.candidates.length !== 0
            || typeof record.indexGeneration !== 'string'
            || !/^[a-f0-9]{64}$/.test(record.indexGeneration)
            || !Number.isSafeInteger(record.candidateCount)
            || (record.candidateCount as number) < 0
            || (record.candidateCount as number) > MAX_INDEX_CANDIDATES
            || !Number.isSafeInteger(candidatesByteOffset)
            || candidatesByteOffset <= 0
        ) return null;
        return Object.freeze({
            v: 2,
            state: 'complete',
            agentKey: expected.agentKey,
            sourceKey: expected.sourceKey,
            runtimeGeneration: expected.runtimeGeneration,
            startToken: record.startToken,
            scanCursor: null,
            scanned: record.scanned as number,
            ...(record.total === undefined ? {} : { total: record.total as number }),
            corpus,
            indexGeneration: record.indexGeneration,
            candidateCount: record.candidateCount as number,
            candidatesByteOffset,
        });
    } catch {
        return null;
    }
}

async function readCompleteIndexHeaderFromHandle(
    handle: FileHandle,
    expected: CandidateIndexKeys,
): Promise<CompleteCandidateIndexHeader | null> {
    const buffer = Buffer.alloc(COMPLETE_INDEX_HEADER_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead === 0) return null;
    const prefix = buffer.subarray(0, bytesRead).toString('utf8');
    const marker = '"candidates":[';
    const markerOffset = prefix.indexOf(marker);
    if (markerOffset < 0) return null;
    const candidatesByteOffset = Buffer.byteLength(
        prefix.slice(0, markerOffset + marker.length),
        'utf8',
    );
    const headerJson = `${prefix.slice(0, markerOffset)}"candidates":[]}`;
    return parseCompleteIndexHeader(headerJson, candidatesByteOffset, expected);
}

async function readCompleteIndexHeader(
    indexPath: string,
    expected: CandidateIndexKeys,
): Promise<CompleteCandidateIndexHeader | null> {
    const handle = await open(indexPath, 'r').catch(() => null);
    if (!handle) return null;
    try {
        return await readCompleteIndexHeaderFromHandle(handle, expected);
    } finally {
        await handle.close();
    }
}

type StoredCandidatePageRead = Readonly<{
    candidates: readonly StoredCandidate[];
    candidateByteOffsets: readonly number[];
    nextByteOffset: number | null;
}>;

function isJsonWhitespaceByte(value: number): boolean {
    return value === 0x20 || value === 0x09 || value === 0x0a || value === 0x0d;
}

async function readStoredCandidatePage(
    handle: FileHandle,
    byteOffset: number,
    offset: number,
    limit: number,
    header: CompleteCandidateIndexHeader,
): Promise<StoredCandidatePageRead | null> {
    if (
        !Number.isSafeInteger(byteOffset)
        || byteOffset < 0
        || !Number.isSafeInteger(offset)
        || offset < 0
        || offset > header.candidateCount
    ) return null;
    let bufferedBytes = 0;
    let filePosition = byteOffset;
    let candidateStartByteOffset = -1;
    let candidateChunks: Buffer[] = [];
    let candidateBytes = 0;
    let depth = 0;
    let inString = false;
    let escaped = false;
    const candidates: StoredCandidate[] = [];
    const candidateByteOffsets: number[] = [];
    const candidateIdentities = new Set<string>();

    while (bufferedBytes <= MAX_INDEX_SERIALIZED_BYTES) {
        const chunk = Buffer.alloc(INDEX_PAGE_READ_CHUNK_BYTES);
        const chunkFilePosition = filePosition;
        const { bytesRead } = await handle.read(
            chunk,
            0,
            chunk.byteLength,
            filePosition,
        );
        if (bytesRead === 0) return null;
        bufferedBytes += bytesRead;
        filePosition += bytesRead;
        let candidateChunkStart = candidateStartByteOffset < 0 ? -1 : 0;

        for (let scanOffset = 0; scanOffset < bytesRead; scanOffset += 1) {
            const value = chunk[scanOffset]!;
            if (candidateStartByteOffset < 0) {
                if (isJsonWhitespaceByte(value) || value === 0x2c) continue;
                if (value === 0x5d) {
                    if (offset + candidates.length !== header.candidateCount) return null;
                    return Object.freeze({
                        candidates: Object.freeze(candidates),
                        candidateByteOffsets: Object.freeze(candidateByteOffsets),
                        nextByteOffset: null,
                    });
                }
                if (value !== 0x7b) return null;
                if (candidates.length === limit) {
                    if (offset + candidates.length >= header.candidateCount) return null;
                    return Object.freeze({
                        candidates: Object.freeze(candidates),
                        candidateByteOffsets: Object.freeze(candidateByteOffsets),
                        nextByteOffset: chunkFilePosition + scanOffset,
                    });
                }
                candidateStartByteOffset = chunkFilePosition + scanOffset;
                candidateByteOffsets.push(candidateStartByteOffset);
                candidateChunkStart = scanOffset;
                depth = 1;
                inString = false;
                escaped = false;
                continue;
            }
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (value === 0x5c) {
                    escaped = true;
                } else if (value === 0x22) {
                    inString = false;
                }
                continue;
            }
            if (value === 0x22) {
                inString = true;
            } else if (value === 0x7b || value === 0x5b) {
                depth += 1;
            } else if (value === 0x7d || value === 0x5d) {
                depth -= 1;
                if (depth < 0) return null;
                if (depth === 0) {
                    if (candidateChunkStart < 0) return null;
                    const finalChunk = chunk.subarray(candidateChunkStart, scanOffset + 1);
                    candidateChunks.push(finalChunk);
                    candidateBytes += finalChunk.byteLength;
                    const rawCandidate = (
                        candidateChunks.length === 1
                            ? candidateChunks[0]!
                            : Buffer.concat(candidateChunks, candidateBytes)
                    ).toString('utf8');
                    let parsedValue: unknown;
                    try {
                        parsedValue = JSON.parse(rawCandidate) as unknown;
                    } catch {
                        return null;
                    }
                    const expectedOrdinal = offset + candidates.length;
                    if (expectedOrdinal >= header.candidateCount) return null;
                    const candidate = parsePersistedCompleteCandidate(
                        parsedValue,
                        header.indexGeneration,
                        header.candidateCount,
                        expectedOrdinal,
                    );
                    if (!candidate) return null;
                    const previous = candidates.at(-1);
                    const identity = candidateIdentity(candidate);
                    if (
                        candidateIdentities.has(identity)
                        || (previous && compareCandidates(previous, candidate) >= 0)
                    ) return null;
                    candidateIdentities.add(identity);
                    candidates.push(candidate);
                    candidateStartByteOffset = -1;
                    candidateChunks = [];
                    candidateBytes = 0;
                    candidateChunkStart = -1;
                }
            }
        }
        if (candidateStartByteOffset >= 0) {
            if (candidateChunkStart < 0) return null;
            const pendingChunk = chunk.subarray(candidateChunkStart, bytesRead);
            candidateChunks.push(pendingChunk);
            candidateBytes += pendingChunk.byteLength;
        }
    }
    return null;
}

function computeCandidatePageDigest(
    candidates: readonly StoredCandidate[],
    offset: number,
    byteOffset: number,
): string {
    return digest(canonicalJson({
        offset,
        byteOffset,
        candidates,
    }));
}

const HEAD_ANCHOR_ENTRY_PATTERN = /^[a-f0-9]{128}$/;

/**
 * The rows a generation is anchored to: the first chunk exactly as it read when
 * the crawl started, one entry per row pairing that row's identity with its
 * content digest.
 *
 * Only rows are anchored. Preparation progress is scan bookkeeping about work in
 * front of the crawl — a corpus that grew a container, a source that counts its
 * sweep differently — and is not evidence about the region already crawled, so
 * it must not decide whether a generation survives.
 */
function candidateHeadAnchor(page: ExternalSessionCandidatesPage): readonly string[] {
    const candidates = page.candidates.map(sanitizeCandidate);
    if (candidates.some((candidate) => candidate === null)) {
        throw new ExternalSessionProviderFailureError({
            code: 'invalid_request',
            operation: 'listCandidates',
            message: 'External-session candidate-index chunk is invalid',
            retryable: false,
        });
    }
    return Object.freeze((candidates as StoredCandidate[]).map(
        (candidate) => `${candidateIdentity(candidate)}${digest(canonicalJson(candidate))}`,
    ));
}

function candidateHeadAnchorToken(anchor: readonly string[]): string {
    return digest(canonicalJson(anchor));
}

/**
 * Whether an in-progress crawl's anchor still holds against a freshly read first
 * chunk.
 *
 * A row APPEARING at the head is not evidence that the corpus already scanned has
 * changed: newest-first traversal puts every newly created session in front of
 * the crawl, where it pushes an anchor row out of the head window without
 * touching anything the build already holds. Such a row is absorbed — the build
 * keeps its cursor, its crawled rows and its corpus chain, and the arrival is
 * served by the generation that follows this one.
 *
 * A row the anchor DID hold whose content moved is the opposite fact, and still
 * restarts the generation. So does an anchor that is no longer visible at all:
 * once every anchored row has left the head window there is nothing left to
 * check the crawl against, so the build fails closed rather than absorbing
 * without evidence.
 */
function candidateHeadAnchorHolds(
    anchor: readonly string[],
    fresh: readonly string[],
): boolean {
    if (anchor.length === 0) return fresh.length === 0;
    const anchoredContentByIdentity = new Map(
        anchor.map((entry) => [entry.slice(0, 64), entry.slice(64)] as const),
    );
    let anchoredRowsStillVisible = 0;
    for (const entry of fresh) {
        const anchoredContent = anchoredContentByIdentity.get(entry.slice(0, 64));
        if (anchoredContent === undefined) continue;
        if (anchoredContent !== entry.slice(64)) return false;
        anchoredRowsStillVisible += 1;
    }
    return anchoredRowsStillVisible > 0;
}

/**
 * A completed generation has nothing left to absorb, so it keeps the strict
 * whole-first-chunk identity it published; an in-progress crawl absorbs
 * arrivals ahead of its anchor.
 */
function candidateIndexAnchorHolds(
    record: CandidateIndexRecord,
    freshAnchor: readonly string[],
): boolean {
    return record.state === 'building' && record.head
        ? candidateHeadAnchorHolds(record.head, freshAnchor)
        : record.startToken === candidateHeadAnchorToken(freshAnchor);
}

/**
 * How many rows of a freshly read first chunk sit AHEAD of an in-progress
 * crawl's anchor.
 *
 * Absorbing an arrival at the anchor check alone only defers the restart:
 * validation re-traverses the whole source from the true head, so an absorbed
 * row would enter validation's corpus chain, fail the comparison against the
 * chain the crawl accumulated, and discard the finished crawl. The rows in front
 * of the anchor are the same rows the anchor check already ruled are not
 * evidence about the crawled region, so validation skips exactly them and begins
 * its sweep at the first anchored row — the row the crawl itself began at.
 *
 * A completed generation is anchored by strict whole-chunk identity and so has
 * nothing in front of it, and a first chunk holding no anchored row at all is no
 * evidence about the crawled region: both start the sweep at the true head, so
 * the corpus comparison fails closed instead of absorbing without evidence.
 */
function countCandidatesAheadOfAnchor(
    record: CandidateIndexRecord,
    freshCandidates: readonly StoredCandidate[],
): number {
    if (record.state !== 'building' || !record.head) return 0;
    const anchoredIdentities = new Set(record.head.map((entry) => entry.slice(0, 64)));
    const firstAnchored = freshCandidates.findIndex(
        (candidate) => anchoredIdentities.has(candidateIdentity(candidate)),
    );
    return firstAnchored < 0 ? 0 : firstAnchored;
}

/**
 * The corpus chain a validation sweep starts from: the freshly read first chunk
 * with any rows that arrived in front of the crawl's anchor skipped.
 *
 * Only the head is skipped. Every row from the first anchored row onward is
 * chained exactly as the crawl chained it, so a mutation, reordering, insertion
 * or removal anywhere inside the crawled region still breaks the comparison and
 * restarts the generation.
 */
function beginValidationCorpus(
    record: CandidateIndexRecord,
    freshCandidates: readonly StoredCandidate[],
): CandidateCorpusDigest {
    return extendCorpusDigest(
        emptyCorpusDigest(),
        freshCandidates.slice(countCandidatesAheadOfAnchor(record, freshCandidates)),
    );
}

function readPreparedChunk(page: ExternalSessionCandidatesPage): Readonly<{
    candidates: readonly StoredCandidate[];
    corpus: CandidateCorpusDigest;
    scanned: number;
    total?: number;
    nextCursor: string | null;
}> {
    if (!page.preparation) {
        throw new ExternalSessionProviderFailureError({
            code: 'agent_unavailable',
            operation: 'listCandidates',
            message: 'External-session candidate index build changed mode',
            retryable: true,
        });
    }
    if (!isExternalSessionCandidateIndexSourceWorkWithinCapacity(
        page.preparation.scanned,
        page.preparation.total,
    )) {
        throw new ExternalSessionProviderFailureError({
            code: 'invalid_request',
            operation: 'listCandidates',
            message: 'External-session candidate source scan capacity exceeded',
            retryable: false,
        });
    }
    const candidates = page.candidates.map(sanitizeCandidate);
    if (candidates.some((candidate) => candidate === null)) {
        throw new ExternalSessionProviderFailureError({
            code: 'invalid_request',
            operation: 'listCandidates',
            message: 'External-session candidate-index chunk is invalid',
            retryable: false,
        });
    }
    return Object.freeze({
        candidates: Object.freeze(candidates as StoredCandidate[]),
        corpus: extendCorpusDigest(emptyCorpusDigest(), candidates as StoredCandidate[]),
        scanned: page.preparation.scanned,
        ...(page.preparation.total === undefined ? {} : { total: page.preparation.total }),
        nextCursor: page.nextCursor,
    });
}

function createBuildingRecord(
    keys: CandidateIndexKeys,
    initialPage: ExternalSessionCandidatesPage,
): CandidateIndexRecord {
    const chunk = readPreparedChunk(initialPage);
    const continuationHistory = Object.freeze(
        chunk.nextCursor ? [continuationCursorIdentity(chunk.nextCursor)] : [],
    );
    assertCandidateIndexStateWithinByteCapacity(
        Buffer.byteLength(JSON.stringify(chunk.candidates), 'utf8'),
        Buffer.byteLength(JSON.stringify(continuationHistory), 'utf8'),
    );
    const head = candidateHeadAnchor(initialPage);
    return Object.freeze({
        v: 2,
        state: 'building',
        agentKey: keys.agentKey,
        sourceKey: keys.sourceKey,
        runtimeGeneration: keys.runtimeGeneration,
        startToken: candidateHeadAnchorToken(head),
        head,
        scanCursor: chunk.nextCursor,
        scanned: chunk.scanned,
        ...(chunk.total === undefined ? {} : { total: chunk.total }),
        corpus: chunk.corpus,
        continuationHistory,
        candidates: chunk.candidates,
    });
}

/**
 * A continuation read either yields the next scan chunk, or reports that the
 * corpus moved underneath the build and the index was restarted.
 */
type CandidateContinuationRead =
    | Readonly<{ kind: 'chunk'; page: ExternalSessionCandidatesPage }>
    | Readonly<{ kind: 'rebuilt'; response: ExternalSessionCandidatesPage }>;

function sourceInvalid(message: string): ExternalSessionProviderFailureError {
    return new ExternalSessionProviderFailureError({
        code: 'source_invalid',
        operation: 'listCandidates',
        message,
        retryable: true,
    });
}

function addPreparationProgress(
    progressOffset: number,
    progress: number,
): number {
    const combined = progressOffset + progress;
    if (!Number.isSafeInteger(combined)) {
        throw new ExternalSessionProviderFailureError({
            code: 'invalid_request',
            operation: 'listCandidates',
            message: 'External-session candidate preparation progress capacity exceeded',
            retryable: false,
        });
    }
    return combined;
}

/**
 * A preparing index serves the rows it has already crawled so Browse can show a
 * growing page instead of nothing. Each served row is stamped and re-parsed
 * through the persisted content-address guard the completed index uses, so a
 * partial page can never publish a row a completed page would reject.
 */
function selectServablePreparingCandidatePage(
    record: CandidateIndexRecord,
    limit: number,
): readonly StoredCandidate[] {
    const sorted = record.state === 'complete'
        ? record.candidates
        : sortCandidates(record.candidates);
    const indexGeneration = record.state === 'complete' && record.indexGeneration
        ? record.indexGeneration
        : computeIndexGeneration(record.corpus, sorted);
    const page: StoredCandidate[] = [];
    for (const [indexOrdinal, candidate] of sorted.slice(0, limit).entries()) {
        const verified = parsePersistedCompleteCandidate(
            {
                ...candidate,
                indexOrdinal,
                contentAddressDigest: computePersistedCandidateDigest(
                    indexGeneration,
                    sorted.length,
                    indexOrdinal,
                    candidate,
                ),
            },
            indexGeneration,
            sorted.length,
            indexOrdinal,
        );
        if (!verified) break;
        page.push(verified);
    }
    return Object.freeze(page);
}

function publishCandidatePage(
    page: ExternalSessionCandidatesPage,
    maxItems: number,
    maxBytes: number,
): ExternalSessionCandidatesPage {
    const published = Object.freeze({
        ...page,
        candidates: Object.freeze(page.candidates.map((candidate) => Object.freeze({
            ...candidate,
            candidateKey: resolveExternalSessionCandidateIdentityKey(candidate),
        }))),
    });
    if (
        published.candidates.length > maxItems
        || new TextEncoder().encode(JSON.stringify(published)).byteLength > maxBytes
    ) {
        throw new ExternalSessionProviderFailureError({
            code: 'agent_error',
            operation: 'listCandidates',
            message: 'External-session candidate result exceeded its item or serialized-byte budget',
            retryable: false,
        });
    }
    return published;
}

function encodeIndexCursor(cursor: CandidateIndexCursor): string {
    return `${INDEX_CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')}`;
}

function decodeIndexCursor(value: string): CandidateIndexCursor | null {
    if (!value.startsWith(INDEX_CURSOR_PREFIX)) return null;
    try {
        const decoded = JSON.parse(
            Buffer.from(value.slice(INDEX_CURSOR_PREFIX.length), 'base64url').toString('utf8'),
        ) as unknown;
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
        const record = decoded as Record<string, unknown>;
        if (
            !isExactKeys(record, [
                'v',
                'kind',
                'agentKey',
                'sourceKey',
                'runtimeGeneration',
                'indexGeneration',
                'offset',
                'byteOffset',
                'pageLength',
                'pageDigest',
            ])
            || record.v !== 2
            || record.kind !== 'external_session_candidate_index'
            || typeof record.agentKey !== 'string'
            || typeof record.sourceKey !== 'string'
            || (record.runtimeGeneration !== null && typeof record.runtimeGeneration !== 'string')
            || typeof record.indexGeneration !== 'string'
            || !/^[a-f0-9]{64}$/.test(record.indexGeneration)
            || !Number.isSafeInteger(record.offset)
            || (record.offset as number) < 0
            || !Number.isSafeInteger(record.byteOffset)
            || (record.byteOffset as number) < 0
            || !Number.isSafeInteger(record.pageLength)
            || (record.pageLength as number) <= 0
            || (record.pageLength as number) > EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxItems
            || typeof record.pageDigest !== 'string'
            || !/^[a-f0-9]{64}$/.test(record.pageDigest)
        ) return null;
        return record as CandidateIndexCursor;
    } catch {
        return null;
    }
}

/**
 * A persisted row already carries every field the Agent candidate contract
 * admits: `parseCandidate` in the invocation policy owner accepts exactly
 * `remoteSessionId`, `updatedAtMs`, `title`, `createdAtMs`, `archived` and
 * `linkData` and rejects any other key, and {@link StoredCandidate} persists all
 * six. The one field a source may withhold from its bounded index chunk and
 * still supply on an exact read is the title, because reading it can cost a
 * transcript read the crawl deliberately avoids. So a stored row that already
 * has a title is source-complete: re-reading it through the leaf can only
 * return the same six values it already holds, at the cost of one Agent
 * round-trip per row.
 *
 * Existence is not re-checked per row here either. The corpus digest that every
 * root request revalidates is the single owner of create/delete/replace
 * detection for a generation, and a continuation page is served from the exact
 * digest-verified bytes of the generation it names; a per-row existence probe
 * was a second decision-maker for the same fact, reachable only on the rows
 * that happened to need a title.
 */
function isSourceCompleteStoredCandidate(candidate: StoredCandidate): boolean {
    return candidate.title !== undefined;
}

async function hydrateAndPublishStoredCandidatePage(params: Readonly<{
    storedCandidates: readonly StoredCandidate[];
    nextCursor: string | null;
    limit: number,
    maxBytes: number,
    hydrateCandidate: ((candidate: StoredCandidate) => Promise<ExternalSessionCandidatesPage['candidates'][number]>) | undefined,
    invalidate: () => Promise<void>,
    publish: (
        page: ExternalSessionCandidatesPage,
    ) => Promise<ExternalSessionCandidatesPage>,
}>): Promise<ExternalSessionCandidatesPage> {
    const candidates: ExternalSessionCandidatesPage['candidates'][number][] = [];
    for (const storedCandidate of params.storedCandidates) {
        if (!params.hydrateCandidate || isSourceCompleteStoredCandidate(storedCandidate)) {
            candidates.push(storedCandidate);
            continue;
        }
        let hydrated: ExternalSessionCandidatesPage['candidates'][number];
        try {
            hydrated = await params.hydrateCandidate(storedCandidate);
        } catch (error) {
            const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
            if (code === 'candidate_not_found' || code === 'source_invalid') {
                await params.invalidate();
                throw sourceInvalid(
                    'External-session candidate source changed while hydrating an indexed page',
                );
            }
            throw error;
        }
        if (
            resolveExternalSessionCandidateIdentityKey(hydrated)
            !== candidateIdentity(storedCandidate)
        ) {
            await params.invalidate();
            throw sourceInvalid(
                'External-session candidate identity changed while hydrating an indexed page',
            );
        }
        const hydratedWithoutLinkData = { ...hydrated };
        delete hydratedWithoutLinkData.linkData;
        candidates.push(Object.freeze({
            ...hydratedWithoutLinkData,
            remoteSessionId: storedCandidate.remoteSessionId,
            ...(storedCandidate.linkData === undefined
                ? {}
                : { linkData: storedCandidate.linkData }),
        }));
    }
    return await params.publish(Object.freeze({
        candidates: Object.freeze(candidates),
        nextCursor: params.nextCursor,
    }));
}

async function serveIndexPage(
    record: CandidateIndexRecord,
    offset: number,
    limit: number,
    maxBytes: number,
    hydrateCandidate: ((candidate: StoredCandidate) => Promise<ExternalSessionCandidatesPage['candidates'][number]>) | undefined,
    invalidate: () => Promise<void>,
    publish: (
        page: ExternalSessionCandidatesPage,
    ) => Promise<ExternalSessionCandidatesPage> = async (page) => publishCandidatePage(
        page,
        limit,
        maxBytes,
    ),
): Promise<ExternalSessionCandidatesPage> {
    if (record.state !== 'complete' || !record.indexGeneration) {
        throw new Error('Candidate index is not complete');
    }
    const storedCandidates = record.candidates.slice(offset, offset + limit);
    const nextOffset = offset + storedCandidates.length;
    let nextCursor: string | null = null;
    if (nextOffset < record.candidates.length) {
        const serialized = serializeCompleteIndexRecord(record);
        const byteOffset = serialized.candidateByteOffsets[nextOffset];
        if (byteOffset === undefined) throw new Error('Candidate index page address is missing');
        nextCursor = encodeIndexCursor({
            v: 2,
            kind: 'external_session_candidate_index',
            agentKey: record.agentKey,
            sourceKey: record.sourceKey,
            runtimeGeneration: record.runtimeGeneration,
            indexGeneration: record.indexGeneration,
            offset: nextOffset,
            byteOffset,
            pageLength: Math.min(limit, record.candidates.length - nextOffset),
            pageDigest: computeCandidatePageDigest(
                record.candidates.slice(nextOffset, nextOffset + limit),
                nextOffset,
                byteOffset,
            ),
        });
    }
    return await hydrateAndPublishStoredCandidatePage({
        storedCandidates,
        nextCursor,
        limit,
        maxBytes,
        hydrateCandidate,
        invalidate,
        publish,
    });
}

/**
 * The continuation the caller sent can no longer address a page: the generation
 * it names is gone (rebuilt, retired with its Agent runtime, or replaced by a
 * moved corpus), its body no longer verifies, or it was never a cursor this host
 * minted. Every one of those has the same and only recovery — drop the
 * continuation and rebuild the listing from the root — so they are one typed
 * outcome rather than a request error the caller could usefully retry. Retrying
 * a dead cursor can only fail again.
 */
export class ExternalSessionCandidateIndexCursorResetError extends Error {
    constructor() {
        super('External-session candidate index continuation is no longer addressable');
        this.name = 'ExternalSessionCandidateIndexCursorResetError';
    }
}

export function isExternalSessionCandidateIndexCursorResetError(
    error: unknown,
): error is ExternalSessionCandidateIndexCursorResetError {
    return error instanceof ExternalSessionCandidateIndexCursorResetError;
}

function invalidCursor(): never {
    throw new ExternalSessionCandidateIndexCursorResetError();
}

export async function executeExternalSessionCandidateQuery(params: Readonly<{
    activeServerDir: string;
    agentIdentity: PluginContributionIdentityV1;
    source: unknown;
    cursor?: string;
    limit: number;
    maxBytes?: number;
    searchTerm?: string;
    searchMode?: 'fast' | 'full';
    /**
     * Immutable generation id of the Agent runtime that will serve this query.
     * A persisted index is only reused by the generation that built it; see
     * `CandidateIndexRecord.runtimeGeneration`.
     */
    agentRuntimeGeneration?: string | null;
    /**
     * The caller's cancellation. It reaches the Agent leaf through the two
     * request closures below and fences candidate-index lock admission here.
     */
    signal?: AbortSignal;
    listCandidates(request: Readonly<{
        cursor?: string;
        limit: number;
        searchTerm?: string;
        searchMode?: 'fast' | 'full';
    }>): Promise<ExternalSessionCandidatesPage>;
    hydrateCandidate?(
        candidate: Readonly<{
            remoteSessionId: string;
            updatedAtMs: number;
            createdAtMs?: number;
            archived?: boolean;
            linkData?: StrictJsonObject;
        }>,
    ): Promise<ExternalSessionCandidatesPage['candidates'][number]>;
}>): Promise<ExternalSessionCandidatesPage> {
    const candidatePolicy = EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates;
    const limit = Math.min(
        candidatePolicy.maxItems,
        Math.max(1, Math.trunc(params.limit)),
    );
    const maxBytes = params.maxBytes === undefined
        ? candidatePolicy.maxSerializedBytes
        : Number.isSafeInteger(params.maxBytes) && params.maxBytes > 0
            ? Math.min(params.maxBytes, candidatePolicy.maxSerializedBytes)
            : 0;
    if (maxBytes === 0) {
        throw new ExternalSessionProviderFailureError({
            code: 'invalid_request',
            operation: 'listCandidates',
            message: 'External-session candidate result byte budget is invalid',
            retryable: false,
        });
    }
    const keys = resolveKeys(
        params.agentIdentity,
        params.source,
        params.agentRuntimeGeneration ?? null,
    );
    const paths = resolvePaths(params.activeServerDir, keys);
    const indexCursor = params.cursor ? decodeIndexCursor(params.cursor) : null;
    if (params.cursor && params.cursor.startsWith(INDEX_CURSOR_PREFIX) && !indexCursor) invalidCursor();

    if (params.searchTerm || (params.cursor && !indexCursor)) {
        return publishCandidatePage(await params.listCandidates({
            ...(params.cursor ? { cursor: params.cursor } : {}),
            limit,
            ...(params.searchTerm ? { searchTerm: params.searchTerm } : {}),
            ...(params.searchMode ? { searchMode: params.searchMode } : {}),
        }), limit, maxBytes);
    }

    if (indexCursor) {
        const handle = await open(paths.indexPath, 'r').catch(() => null);
        if (!handle) invalidCursor();
        let header: CompleteCandidateIndexHeader | null = null;
        let storedPage: StoredCandidatePageRead | null = null;
        let nextCursor: string | null = null;
        let bodyCorrupt = false;
        let inspectedFileIdentity: CandidateIndexFileIdentity | null = null;
        try {
            const parsedHeader = await readCompleteIndexHeaderFromHandle(handle, keys);
            if (
                !parsedHeader
                || parsedHeader.indexGeneration !== indexCursor.indexGeneration
                || parsedHeader.agentKey !== indexCursor.agentKey
                || parsedHeader.sourceKey !== indexCursor.sourceKey
                || parsedHeader.runtimeGeneration !== indexCursor.runtimeGeneration
                || indexCursor.offset >= MAX_INDEX_CANDIDATES
            ) invalidCursor();
            header = parsedHeader;
            const cursorPage = await readStoredCandidatePage(
                handle,
                indexCursor.byteOffset,
                indexCursor.offset,
                indexCursor.pageLength,
                header,
            );
            if (
                !cursorPage
                || cursorPage.candidates.length !== indexCursor.pageLength
                || computeCandidatePageDigest(
                    cursorPage.candidates,
                    indexCursor.offset,
                    indexCursor.byteOffset,
                ) !== indexCursor.pageDigest
            ) throw CORRUPT_CANDIDATE_INDEX_BODY;
            const selectedCount = Math.min(limit, cursorPage.candidates.length);
            const selectedCandidates = Object.freeze(cursorPage.candidates.slice(0, selectedCount));
            const nextByteOffset = selectedCount < cursorPage.candidates.length
                ? cursorPage.candidateByteOffsets[selectedCount] ?? null
                : cursorPage.nextByteOffset;
            storedPage = Object.freeze({
                candidates: selectedCandidates,
                candidateByteOffsets: Object.freeze(
                    cursorPage.candidateByteOffsets.slice(0, selectedCount),
                ),
                nextByteOffset,
            });
            if (nextByteOffset !== null) {
                const lookahead = await readStoredCandidatePage(
                    handle,
                    nextByteOffset,
                    indexCursor.offset + selectedCount,
                    limit,
                    header,
                );
                const previousCandidate = selectedCandidates.at(-1);
                const nextCandidate = lookahead?.candidates[0];
                if (
                    !lookahead
                    || !previousCandidate
                    || !nextCandidate
                    || compareCandidates(previousCandidate, nextCandidate) >= 0
                    || candidateIdentity(previousCandidate) === candidateIdentity(nextCandidate)
                ) throw CORRUPT_CANDIDATE_INDEX_BODY;
                nextCursor = encodeIndexCursor({
                    v: 2,
                    kind: 'external_session_candidate_index',
                    agentKey: header.agentKey,
                    sourceKey: header.sourceKey,
                    runtimeGeneration: header.runtimeGeneration,
                    indexGeneration: header.indexGeneration,
                    offset: indexCursor.offset + selectedCount,
                    byteOffset: nextByteOffset,
                    pageLength: lookahead.candidates.length,
                    pageDigest: computeCandidatePageDigest(
                        lookahead.candidates,
                        indexCursor.offset + selectedCount,
                        nextByteOffset,
                    ),
                });
            } else if (indexCursor.offset + selectedCount !== header.candidateCount) {
                throw CORRUPT_CANDIDATE_INDEX_BODY;
            }
        } catch (error) {
            if (error !== CORRUPT_CANDIDATE_INDEX_BODY) throw error;
            bodyCorrupt = true;
            inspectedFileIdentity = await readCandidateIndexHandleIdentity(handle);
        } finally {
            await handle.close();
        }
        if (!header) invalidCursor();
        const isCurrentGeneration = (current: CompleteCandidateIndexHeader | null): boolean => (
            current?.indexGeneration === header.indexGeneration
            && current.agentKey === header.agentKey
            && current.sourceKey === header.sourceKey
            && current.runtimeGeneration === header.runtimeGeneration
        );
        if (bodyCorrupt) {
            await withCandidateIndexLock(paths.lockPath, params.signal, async () => {
                if (!isCurrentGeneration(await readCompleteIndexHeader(paths.indexPath, keys))) return;
                if (!candidateIndexFileIdentitiesEqual(
                    inspectedFileIdentity,
                    await readCandidateIndexPathIdentity(paths.indexPath),
                )) return;
                await unlink(paths.indexPath).catch(() => undefined);
            });
            invalidCursor();
        }
        if (!storedPage) invalidCursor();
        return await hydrateAndPublishStoredCandidatePage({
            storedCandidates: storedPage.candidates,
            nextCursor,
            limit,
            maxBytes,
            hydrateCandidate: params.hydrateCandidate,
            invalidate: async () => {
                await withCandidateIndexLock(paths.lockPath, params.signal, async () => {
                    if (!isCurrentGeneration(await readCompleteIndexHeader(paths.indexPath, keys))) return;
                    await unlink(paths.indexPath).catch(() => undefined);
                });
            },
            publish: async (page) => await withCandidateIndexLock(paths.lockPath, params.signal, async () => {
                if (!isCurrentGeneration(await readCompleteIndexHeader(paths.indexPath, keys))) {
                    invalidCursor();
                }
                return publishCandidatePage(page, limit, maxBytes);
            }),
        });
    }

    const initialPage = await params.listCandidates({
        limit: Math.min(INDEX_SCAN_CHUNK_LIMIT, limit),
    });
    if (!initialPage.preparation) {
        return publishCandidatePage(initialPage, limit, maxBytes);
    }

    await ensurePrivateDirectory(paths.directory);
    const initialAnchor = candidateHeadAnchor(initialPage);
    return await withCandidateIndexLock(paths.lockPath, params.signal, async () => {
        const freshBuilding = createBuildingRecord(keys, initialPage);
        const continuationWorkStartedAt = performance.now();
        let continuationCalls = 0;
        const canContinueWorkSlice = (): boolean => (
            continuationCalls < INDEX_CONTINUATION_CALL_LIMIT
            && performance.now() - continuationWorkStartedAt < INDEX_CONTINUATION_WORK_BUDGET_MS
        );
        /**
         * A preparation response reports build progress and, when the index already
         * holds digest-verified rows, the page it has crawled so far. It never emits
         * a continuation cursor: only a completed generation is page-addressable.
         *
         * Partial rows preserve the one immutable content-derived field admitted by
         * `StoredCandidate`: a source-supplied first-message title. The host neither
         * derives nor refreshes titles during preparation, and it does not persist a
         * working directory or another candidate representation. The shared publish
         * path still applies the normal bounds and link-identity projection to the
         * selected page without making the entire in-progress index page-addressable.
         */
        const preparationResponse = async (
            page: ExternalSessionCandidatesPage,
            servedCandidates: readonly StoredCandidate[] = [],
            progressOffset = 0,
            totalOffset = progressOffset,
        ): Promise<ExternalSessionCandidatesPage> => {
            if (!page.preparation) {
                throw new Error('Candidate-index preparation response requires preparation state');
            }
            const preparation = progressOffset === 0 && totalOffset === 0
                ? page.preparation
                : Object.freeze({
                    ...page.preparation,
                    scanned: addPreparationProgress(progressOffset, page.preparation.scanned),
                    ...(page.preparation.total === undefined
                        ? {}
                        : { total: addPreparationProgress(totalOffset, page.preparation.total) }),
                });
            return await hydrateAndPublishStoredCandidatePage({
                storedCandidates: servedCandidates,
                nextCursor: null,
                limit,
                maxBytes,
                hydrateCandidate: undefined,
                invalidate: async () => undefined,
                publish: async (built) => publishCandidatePage(
                    Object.freeze({ ...built, preparation }),
                    limit,
                    maxBytes,
                ),
            });
        };
        const rebuildAndThrow = async (message: string): Promise<never> => {
            await writeIndexRecord(paths.indexPath, freshBuilding);
            throw sourceInvalid(message);
        };
        /**
         * Corpus drift is not a listing failure: the snapshot moved, so the index
         * restarts from the fresh first chunk and the caller keeps seeing
         * preparation progress instead of a typed source failure.
         */
        const rebuildAndReport = async (): Promise<ExternalSessionCandidatesPage> => {
            await writeIndexRecord(paths.indexPath, freshBuilding);
            return await preparationResponse(
                initialPage,
                [],
                0,
                initialPage.preparation?.total ?? 0,
            );
        };
        const requireContinuationProgress = async (params: Readonly<{
            phase: 'build' | 'validation';
            consumedCursor: string;
            previousScanned: number;
            chunk: Readonly<{
                scanned: number;
                nextCursor: string | null;
            }>;
        }>): Promise<void> => {
            if (params.chunk.scanned <= params.previousScanned) {
                return await rebuildAndThrow(
                    `External-session candidate ${params.phase} progress did not advance`,
                );
            }
            if (params.chunk.nextCursor === params.consumedCursor) {
                return await rebuildAndThrow(
                    `External-session candidate ${params.phase} continuation cursor cycled`,
                );
            }
        };
        const admitContinuationCursor = async (
            history: ContinuationHistoryAccumulator,
            nextCursor: string | null,
            phase: 'build' | 'validation',
            candidatesSerializedBytes: number,
        ): Promise<void> => {
            if (!nextCursor) return;
            const cursorIdentity = continuationCursorIdentity(nextCursor);
            if (history.identitySet.has(cursorIdentity)) {
                return await rebuildAndThrow(
                    `External-session candidate ${phase} continuation cursor repeated`,
                );
            }
            if (!isExternalSessionCandidateIndexContinuationStepCountWithinCapacity(
                history.identities.length + 1,
            )) {
                return await rebuildAndThrow(
                    `External-session candidate ${phase} continuation step capacity exceeded`,
                );
            }
            const additionalSerializedBytes = history.identities.length === 0 ? 66 : 67;
            assertCandidateIndexStateWithinByteCapacity(
                candidatesSerializedBytes,
                history.serializedBytes + additionalSerializedBytes,
            );
            history.identities.push(cursorIdentity);
            history.identitySet.add(cursorIdentity);
            history.serializedBytes += additionalSerializedBytes;
        };
        const readContinuation = async (cursor: string): Promise<CandidateContinuationRead> => {
            continuationCalls += 1;
            try {
                return {
                    kind: 'chunk',
                    page: await params.listCandidates({
                        cursor,
                        limit: INDEX_SCAN_CHUNK_LIMIT,
                    }),
                };
            } catch (error) {
                if (
                    error instanceof ExternalSessionProviderFailureError
                    && error.code === 'source_invalid'
                ) {
                    return { kind: 'rebuilt', response: await rebuildAndReport() };
                }
                throw error;
            }
        };
        const finishOrPersistValidation = async (
            record: CandidateIndexRecord,
            page: ExternalSessionCandidatesPage,
            corpus: CandidateCorpusDigest,
        ): Promise<ExternalSessionCandidatesPage> => {
            const chunk = readPreparedChunk(page);
            if (chunk.nextCursor) {
                const continuationHistory = createContinuationHistoryAccumulator(
                    record.validation?.continuationHistory ?? [],
                );
                await admitContinuationCursor(
                    continuationHistory,
                    chunk.nextCursor,
                    'validation',
                    Buffer.byteLength(JSON.stringify(record.candidates), 'utf8'),
                );
                const validating: CandidateIndexRecord = Object.freeze({
                    ...record,
                    ...(record.state === 'building'
                        ? { continuationHistory: Object.freeze([]) }
                        : {}),
                    validation: Object.freeze({
                        scanCursor: chunk.nextCursor,
                        scanned: chunk.scanned,
                        ...(chunk.total === undefined ? {} : { total: chunk.total }),
                        corpus,
                        continuationHistory: snapshotContinuationHistory(continuationHistory),
                    }),
                });
                await writeIndexRecord(paths.indexPath, validating);
                return await preparationResponse(
                    page,
                    selectServablePreparingCandidatePage(record, limit),
                    record.state === 'building' ? record.scanned : 0,
                );
            }
            if (!corpusDigestsEqual(record.corpus, corpus)) {
                return await rebuildAndReport();
            }
            const sorted = record.state === 'complete'
                ? record.candidates
                : sortCandidates(record.candidates);
            const indexGeneration = record.state === 'complete'
                ? record.indexGeneration!
                : computeIndexGeneration(record.corpus, sorted);
            const complete: CandidateIndexRecord = Object.freeze({
                v: 2,
                state: 'complete',
                agentKey: record.agentKey,
                sourceKey: record.sourceKey,
                runtimeGeneration: record.runtimeGeneration,
                startToken: record.startToken,
                scanCursor: null,
                scanned: record.scanned,
                ...(record.total === undefined ? {} : { total: record.total }),
                corpus: record.corpus,
                indexGeneration,
                candidates: sorted,
            });
            await writeIndexRecord(paths.indexPath, complete);
            return await serveIndexPage(
                complete,
                0,
                limit,
                maxBytes,
                params.hydrateCandidate,
                async () => {
                    await unlink(paths.indexPath).catch(() => undefined);
                },
            );
        };
        const continueValidation = async (
            record: CandidateIndexRecord,
            initialValidation: CandidateIndexValidation,
        ): Promise<ExternalSessionCandidatesPage> => {
            let scanCursor = initialValidation.scanCursor;
            let scanned = initialValidation.scanned;
            let total = initialValidation.total;
            let corpus = initialValidation.corpus;
            const continuationHistory = createContinuationHistoryAccumulator(
                initialValidation.continuationHistory,
            );
            const candidatesSerializedBytes = Buffer.byteLength(
                JSON.stringify(record.candidates),
                'utf8',
            );
            while (true) {
                const read = await readContinuation(scanCursor);
                if (read.kind === 'rebuilt') return read.response;
                const page = read.page;
                const chunk = readPreparedChunk(page);
                await requireContinuationProgress({
                    phase: 'validation',
                    consumedCursor: scanCursor,
                    previousScanned: scanned,
                    chunk,
                });
                corpus = extendCorpusDigest(corpus, chunk.candidates);
                if (!chunk.nextCursor) {
                    return await finishOrPersistValidation(record, page, corpus);
                }
                await admitContinuationCursor(
                    continuationHistory,
                    chunk.nextCursor,
                    'validation',
                    candidatesSerializedBytes,
                );
                scanCursor = chunk.nextCursor;
                scanned = chunk.scanned;
                total = chunk.total;
                if (canContinueWorkSlice()) continue;
                const validation: CandidateIndexValidation = Object.freeze({
                    scanCursor,
                    scanned,
                    ...(total === undefined ? {} : { total }),
                    corpus,
                    continuationHistory: snapshotContinuationHistory(continuationHistory),
                });
                const validating: CandidateIndexRecord = Object.freeze({
                    ...record,
                    validation,
                });
                await writeIndexRecord(paths.indexPath, validating);
                return await preparationResponse(
                    page,
                    selectServablePreparingCandidatePage(record, limit),
                    record.state === 'building' ? record.scanned : 0,
                );
            }
        };
        const beginValidation = async (
            record: CandidateIndexRecord,
            allowContinuation: boolean,
        ): Promise<ExternalSessionCandidatesPage> => {
            if (!candidateIndexAnchorHolds(record, initialAnchor)) {
                return await rebuildAndReport();
            }
            const initialChunk = readPreparedChunk(initialPage);
            const initialCorpus = beginValidationCorpus(record, initialChunk.candidates);
            if (!initialChunk.nextCursor) {
                return await finishOrPersistValidation(
                    record,
                    initialPage,
                    initialCorpus,
                );
            }
            const initialContinuationHistory = Object.freeze([
                continuationCursorIdentity(initialChunk.nextCursor),
            ]);
            assertCandidateIndexStateWithinByteCapacity(
                Buffer.byteLength(JSON.stringify(record.candidates), 'utf8'),
                Buffer.byteLength(JSON.stringify(initialContinuationHistory), 'utf8'),
            );
            if (!allowContinuation) {
                const validating: CandidateIndexRecord = Object.freeze({
                    ...record,
                    ...(record.state === 'building'
                        ? { continuationHistory: Object.freeze([]) }
                        : {}),
                    validation: Object.freeze({
                        scanCursor: initialChunk.nextCursor,
                        scanned: initialChunk.scanned,
                        ...(initialChunk.total === undefined ? {} : { total: initialChunk.total }),
                        corpus: initialCorpus,
                        continuationHistory: initialContinuationHistory,
                    }),
                });
                await writeIndexRecord(paths.indexPath, validating);
                return await preparationResponse(
                    initialPage,
                    selectServablePreparingCandidatePage(record, limit),
                    record.state === 'building' ? record.scanned : 0,
                );
            }
            return await continueValidation(
                record,
                Object.freeze({
                    scanCursor: initialChunk.nextCursor,
                    scanned: initialChunk.scanned,
                    ...(initialChunk.total === undefined ? {} : { total: initialChunk.total }),
                    corpus: initialCorpus,
                    continuationHistory: initialContinuationHistory,
                }),
            );
        };

        const existing = await readIndexRecord(paths.indexPath, keys);
        if (!existing) {
            await writeIndexRecord(paths.indexPath, freshBuilding);
            return await preparationResponse(
                initialPage,
                [],
                0,
                initialPage.preparation?.total ?? 0,
            );
        }

        if (!candidateIndexAnchorHolds(existing, initialAnchor)) {
            return await rebuildAndReport();
        }

        if (existing.validation) {
            return await continueValidation(existing, existing.validation);
        }

        if (existing.state === 'building' && existing.scanCursor) {
            /**
             * The partial page is drawn from the rows that were already persisted and
             * digest-verified when this slice started; rows crawled during this slice
             * become servable on the next one, once they too have round-tripped.
             */
            const persistedPage = selectServablePreparingCandidatePage(existing, limit);
            let scanCursor: string | null = existing.scanCursor;
            let scanned = existing.scanned;
            let total = existing.total;
            let corpus = existing.corpus;
            const continuationHistory = createContinuationHistoryAccumulator(
                existing.continuationHistory!,
            );
            const candidateAccumulator = createCandidateAccumulator(existing.candidates);
            const snapshotBuilding = (): CandidateIndexRecord => Object.freeze({
                v: 2,
                state: 'building',
                agentKey: existing.agentKey,
                sourceKey: existing.sourceKey,
                runtimeGeneration: existing.runtimeGeneration,
                startToken: existing.startToken,
                ...(existing.head === undefined ? {} : { head: existing.head }),
                scanCursor,
                scanned,
                ...(total === undefined ? {} : { total }),
                corpus,
                continuationHistory: snapshotContinuationHistory(continuationHistory),
                candidates: Object.freeze([...candidateAccumulator.candidates.values()]),
            });
            while (scanCursor) {
                const consumedCursor = scanCursor;
                const read = await readContinuation(consumedCursor);
                if (read.kind === 'rebuilt') return read.response;
                const page = read.page;
                const chunk = readPreparedChunk(page);
                await requireContinuationProgress({
                    phase: 'build',
                    consumedCursor,
                    previousScanned: scanned,
                    chunk,
                });
                scanCursor = chunk.nextCursor;
                scanned = chunk.scanned;
                total = chunk.total;
                corpus = extendCorpusDigest(corpus, chunk.candidates);
                appendCandidateChunk(candidateAccumulator, chunk.candidates);
                await admitContinuationCursor(
                    continuationHistory,
                    chunk.nextCursor,
                    'build',
                    candidateAccumulator.serializedBytes.value,
                );
                if (!chunk.nextCursor) {
                    return await beginValidation(snapshotBuilding(), false);
                }
                if (canContinueWorkSlice()) continue;
                const building = snapshotBuilding();
                await writeIndexRecord(paths.indexPath, building);
                return await preparationResponse(
                    page,
                    persistedPage,
                    0,
                    page.preparation?.total ?? 0,
                );
            }
        }

        return await beginValidation(existing, true);
    });
}
