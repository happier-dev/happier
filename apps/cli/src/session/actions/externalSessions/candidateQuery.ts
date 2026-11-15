import { createHash } from 'node:crypto';
import { chmod, mkdir, opendir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type {
    ExternalSessionsSource,
    PluginContributionIdentityV1,
    PluginSourceCustodyV1,
} from '@happier-dev/protocol';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { resolveExternalSessionCandidateIdentityKey } from '@happier-dev/plugin-sdk/sessions/external';

import {
    ExternalSessionProviderFailureError,
    type ExternalSessionCandidatesPage,
    type ExternalSessionExecutionSurface,
} from '@/session/external/providerOps';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from '@/session/external/agentExternalSessionsInvocation';
import { preservesExternalSessionSourceIdentity } from '@/session/external/sourceIdentity';
import { isManagedSessionDirectoryPath } from '@/session/creation/managedSessionDirectories';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

/**
 * External Sessions Browse, host side.
 *
 * Every Agent source serves Browse in its own newest-activity-first order from
 * a cheap per-row fact (file mtime, provider recency) and reads heads only for
 * the rows a page shows (`pageExternalSessionCandidatesByActivity` in the
 * plugin SDK). The host therefore serves each page straight from the Agent:
 * there is no whole-corpus candidate index, crawl or preparation phase. What
 * the host keeps is the Agent's opaque per-row checkpoint
 * (`candidateIndexState`) for rows it has shown or searched, so reopening
 * Browse re-reads no unchanged head. The Agent validates each checkpoint
 * against its own source facts; the host never interprets it.
 */

const RETIRED_INDEX_CURSOR_PREFIX = 'happier_external_candidate_index_v1:';
const HYDRATION_CONTINUATION_CALL_LIMIT = 250;
const ROW_STATE_STORE_VERSION = 1;

type StrictJson =
    | null
    | boolean
    | number
    | string
    | readonly StrictJson[]
    | Readonly<{ [key: string]: StrictJson }>;

type StrictJsonObject = Readonly<{ [key: string]: StrictJson }>;


function digest(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

type CandidateIndexKeys = Readonly<{
    agentKey: string;
    sourceKey: string;
    sourceCustody: PluginSourceCustodyV1 | null;
}>;

type CandidateIndexIdentity = Readonly<{
    agentIdentity: PluginContributionIdentityV1;
    source: unknown;
}>;

function resolveKeys(
    agentIdentity: PluginContributionIdentityV1,
    source: unknown,
    sourceCustody: PluginSourceCustodyV1 | null,
): CandidateIndexKeys {
    const agentKey = digest(`${agentIdentity.pluginId}\u0000${agentIdentity.localId}`);
    const sourceKey = digest(createCanonicalJsonSigningInput(source));
    return Object.freeze({
        agentKey,
        sourceKey,
        sourceCustody,
    });
}

function candidateIndexRoot(activeServerDir: string): string {
    return join(
        activeServerDir,
        'external-sessions',
        'candidate-indexes',
        'v1',
    );
}

/**
 * One private directory per Agent/source holds the per-row checkpoint store
 * (`row-state.json`). `index.json`, its `index.rows.jsonl` append log and the
 * `threads/` index are the retired whole-corpus candidate index; the first
 * checkpoint write removes them.
 */
function resolvePaths(
    activeServerDir: string,
    keys: CandidateIndexKeys,
): Readonly<{ directory: string; statePath: string; lockPath: string; retiredIndexPaths: readonly string[] }> {
    const directory = join(
        candidateIndexRoot(activeServerDir),
        keys.agentKey,
        keys.sourceKey,
    );
    return Object.freeze({
        directory,
        statePath: join(directory, 'row-state.json'),
        lockPath: join(directory, 'index.lock'),
        retiredIndexPaths: Object.freeze([
            join(directory, 'index.json'),
            join(directory, 'index.rows.jsonl'),
            join(directory, 'threads'),
        ]),
    });
}

async function retireExternalSessionCandidateIndexAtPaths(
    paths: ReturnType<typeof resolvePaths>,
    signal?: AbortSignal,
): Promise<void> {
    if (signal?.aborted) return;
    await withCandidateIndexLock(paths.lockPath, signal, async () => {
        if (signal?.aborted) return;
        await rm(paths.statePath, { force: true });
        for (const retired of paths.retiredIndexPaths) await rm(retired, { recursive: true, force: true });
    });
    if (signal?.aborted) return;
    await rm(paths.directory, { recursive: true, force: true });
}

/**
 * Retires only the persisted candidate index owned by one exact Agent/source
 * identity. The shared index lock serializes retirement behind any write that
 * is already in flight; the caller retires its cancellation signal first so no
 * later write can reacquire the lock and recreate the directory. The payload is
 * removed while holding the lock; the now-empty directory is removed only after
 * lock release so the lock owner can verify and release its own custody file.
 */
export async function retireExternalSessionCandidateIndex(params: Readonly<{
    activeServerDir: string;
    agentIdentity: PluginContributionIdentityV1;
    source: unknown;
}>): Promise<void> {
    const paths = resolvePaths(
        params.activeServerDir,
        resolveKeys(params.agentIdentity, params.source, null),
    );
    await retireExternalSessionCandidateIndexAtPaths(paths);
}

function isCandidateIndexStorageKey(value: string): boolean {
    return /^[a-f0-9]{64}$/u.test(value);
}

async function* readCandidateIndexDirectoryNames(path: string): AsyncGenerator<string> {
    let directory: Awaited<ReturnType<typeof opendir>>;
    try {
        directory = await opendir(path);
    } catch (error: unknown) {
        if (
            typeof error === 'object'
            && error !== null
            && 'code' in error
            && error.code === 'ENOENT'
        ) {
            return;
        }
        throw error;
    }
    for await (const entry of directory) {
        if (entry.isDirectory() && isCandidateIndexStorageKey(entry.name)) {
            yield entry.name;
        }
    }
}

/**
 * At successful configured-source admission, removes stale private candidate
 * indexes from the existing versioned layout. This is intentionally a rebuild
 * boundary reconciliation, not a background cleaner: the admitted source set
 * is the sole authority for which Agent/source identities may retain an index.
 */
export async function reconcileExternalSessionCandidateIndexes(params: Readonly<{
    activeServerDir: string;
    admitted: readonly CandidateIndexIdentity[];
    signal?: AbortSignal;
}>): Promise<void> {
    if (params.signal?.aborted) return;
    const retainedSourceKeysByAgentKey = new Map<string, Set<string>>();
    for (const identity of params.admitted) {
        const keys = resolveKeys(identity.agentIdentity, identity.source, null);
        const retainedSourceKeys = retainedSourceKeysByAgentKey.get(keys.agentKey) ?? new Set<string>();
        retainedSourceKeys.add(keys.sourceKey);
        retainedSourceKeysByAgentKey.set(keys.agentKey, retainedSourceKeys);
    }
    const root = candidateIndexRoot(params.activeServerDir);
    for await (const agentKey of readCandidateIndexDirectoryNames(root)) {
        if (params.signal?.aborted) return;
        const retainedSourceKeys = retainedSourceKeysByAgentKey.get(agentKey);
        const agentDirectory = join(root, agentKey);
        for await (const sourceKey of readCandidateIndexDirectoryNames(agentDirectory)) {
            if (params.signal?.aborted) return;
            if (retainedSourceKeys?.has(sourceKey)) continue;
            await retireExternalSessionCandidateIndexAtPaths(resolvePaths(params.activeServerDir, {
                agentKey,
                sourceKey,
                sourceCustody: null,
            }), params.signal);
        }
    }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(path, 0o700);
}

/**
 * Serializes checkpoint-store writes and retirement for one Agent/source. A
 * browse that was superseded or closed stops queueing (its signal is the
 * admission fence); an effect that already holds the lock is never interrupted.
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
    const parsed = Object.create(null) as Record<string, StrictJson>;
    for (const [key, item] of Object.entries(record)) {
        const next = readStrictJson(item);
        if (next === null && item !== null) return null;
        parsed[key] = next;
    }
    return Object.freeze(parsed);
}

type CandidateRowStateStore = Map<string, StrictJsonObject>;

function readStrictJsonObject(value: unknown): StrictJsonObject | null {
    const parsed = readStrictJson(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as StrictJsonObject : null;
}

async function readCandidateRowStateStore(statePath: string): Promise<CandidateRowStateStore> {
    const store: CandidateRowStateStore = new Map();
    let raw: string;
    try {
        raw = await readFile(statePath, 'utf8');
    } catch {
        return store;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // A torn or foreign file is a lost checkpoint set; heads are re-read.
        return store;
    }
    const rows = parsed && typeof parsed === 'object' && Reflect.get(parsed, 'v') === ROW_STATE_STORE_VERSION
        ? Reflect.get(parsed, 'rows')
        : null;
    if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return store;
    for (const [identity, value] of Object.entries(rows as Record<string, unknown>)) {
        const state = readStrictJsonObject(value);
        if (state) store.set(identity, state);
    }
    return store;
}

/**
 * Records the checkpoints the Agent returned for the rows this page served.
 * Only changed checkpoints cause a write; a page of unchanged rows writes
 * nothing. A source the Live source-set owner already retired is not
 * recreated.
 */
async function recordCandidateRowStates(params: Readonly<{
    paths: ReturnType<typeof resolvePaths>;
    keys: CandidateIndexKeys;
    candidates: ExternalSessionCandidatesPage['candidates'];
    known: CandidateRowStateStore;
    readRetainedIndexIdentities?: () => readonly CandidateIndexIdentity[];
    signal?: AbortSignal;
}>): Promise<void> {
    const changed = new Map<string, StrictJsonObject>();
    for (const candidate of params.candidates) {
        const state = readStrictJsonObject(Reflect.get(candidate as object, 'candidateIndexState'));
        if (!state) continue;
        let identity: string;
        try {
            identity = resolveExternalSessionCandidateIdentityKey(candidate);
        } catch {
            continue;
        }
        const previous = params.known.get(identity);
        if (previous && createCanonicalJsonSigningInput(previous) === createCanonicalJsonSigningInput(state)) continue;
        changed.set(identity, state);
    }
    if (changed.size === 0) return;
    const retained = params.readRetainedIndexIdentities?.();
    if (retained && !retained.some((identity) => {
        const retainedKeys = resolveKeys(identity.agentIdentity, identity.source, null);
        return retainedKeys.agentKey === params.keys.agentKey && retainedKeys.sourceKey === params.keys.sourceKey;
    })) return;
    await ensurePrivateDirectory(params.paths.directory);
    await withCandidateIndexLock(params.paths.lockPath, params.signal, async () => {
        const current = await readCandidateRowStateStore(params.paths.statePath);
        for (const [identity, state] of changed) current.set(identity, state);
        await writeJsonAtomic(params.paths.statePath, {
            v: ROW_STATE_STORE_VERSION,
            rows: Object.fromEntries(current),
        });
        for (const retired of params.paths.retiredIndexPaths) await rm(retired, { recursive: true, force: true });
    });
}

/**
 * Fresh display metadata for the selected page only (for example native thread
 * names). Count, order and identity are the Agent page's.
 */
async function hydrateSelectedPage(
    page: ExternalSessionCandidatesPage,
    hydrateCandidates: NonNullable<ExternalSessionCandidateQueryRequest['hydrateCandidates']>,
): Promise<ExternalSessionCandidatesPage> {
    if (page.candidates.length === 0) return page;
    const enriched = await hydrateCandidates(page.candidates);
    if (enriched.length !== page.candidates.length || enriched.some((candidate, index) =>
        resolveExternalSessionCandidateIdentityKey(candidate)
            !== resolveExternalSessionCandidateIdentityKey(page.candidates[index]!)
    )) {
        throw new ExternalSessionProviderFailureError({
            code: 'agent_error', operation: 'hydrateCandidates', retryable: false,
            message: 'External-session candidate hydration changed the selected page',
        });
    }
    return Object.freeze({
        ...page,
        candidates: Object.freeze(page.candidates.map((candidate, index) => {
            const metadata = enriched[index]!;
            return Object.freeze({
                ...candidate,
                ...(metadata.title === undefined ? {} : { title: metadata.title }),
                ...(metadata.cwd === undefined ? {} : { cwd: metadata.cwd }),
                ...(metadata.messageCount === undefined ? {} : { messageCount: metadata.messageCount }),
            });
        })),
    });
}

export { resolveExternalSessionCandidateIdentityKey };

export async function hydrateExternalSessionCandidateThroughAgentSource(params: Readonly<{
    source: ExternalSessionsSource;
    candidate: Readonly<{
        remoteSessionId: string;
        updatedAtMs: number;
        createdAtMs?: number;
        archived?: boolean;
        linkData?: StrictJsonObject;
        candidateIndexState?: StrictJsonObject;
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
    const expectedIdentity = resolveExternalSessionCandidateIdentityKey(params.candidate);
    let page = await params.providerOps.listCandidates({
        source: resolved.source,
        limit: 1,
        searchTerm: params.candidate.remoteSessionId,
        searchMode: 'fast',
        // An admitted row may be one of the Agent's internal threads.
        includeThreads: true,
        ...(params.candidate.candidateIndexState === undefined
            ? {}
            : {
                readCandidateIndexState: (candidate) => (
                    resolveExternalSessionCandidateIdentityKey(candidate) === expectedIdentity
                        ? params.candidate.candidateIndexState
                        : undefined
                ),
            }),
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
            || continuationCalls >= HYDRATION_CONTINUATION_CALL_LIMIT
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
            includeThreads: true,
            ...(params.candidate.candidateIndexState === undefined
                ? {}
                : {
                    readCandidateIndexState: (candidate) => (
                        resolveExternalSessionCandidateIdentityKey(candidate) === expectedIdentity
                            ? params.candidate.candidateIndexState
                            : undefined
                    ),
                }),
            ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }),
            ...(params.signal === undefined ? {} : { signal: params.signal }),
        });
    }
    throw new ExternalSessionProviderFailureError({
        code: 'candidate_not_found',
        operation: 'listCandidates',
        message: 'External-session candidate disappeared while hydrating a selected row',
        retryable: true,
    });
}

function publishCandidatePage(
    page: ExternalSessionCandidatesPage,
    maxItems: number,
    maxBytes: number,
): ExternalSessionCandidatesPage {
    const published = Object.freeze({
        ...page,
        candidates: Object.freeze(page.candidates.map((candidate) => {
            const { candidateIndexState: _candidateIndexState, ...publicCandidate } = candidate;
            return Object.freeze({
                ...publicCandidate,
                candidateKey: resolveExternalSessionCandidateIdentityKey(candidate),
            });
        })),
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

/**
 * The continuation the caller sent can no longer address a page: the Agent no
 * longer recognises it (its source changed shape, or it was minted by the
 * retired candidate index). Its only recovery is to drop it and list from the
 * root, so it is one typed outcome rather than a request error the caller could
 * usefully retry. Retrying a dead cursor can only fail again.
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

type ExternalSessionCandidateQueryRequest = Readonly<{
    activeServerDir: string;
    agentIdentity: PluginContributionIdentityV1;
    source: unknown;
    cursor?: string;
    limit: number;
    maxBytes?: number;
    searchTerm?: string;
    searchMode?: 'fast' | 'full';
    searchTarget?: 'metadata' | 'content';
    /** List the Agent's internal threads too. */
    includeThreads?: boolean;
    /** Durable source custody of the Agent runtime that will serve this query. */
    agentSourceCustody: PluginSourceCustodyV1;
    /** Existing Live source-set projection; omitted by ordinary retained compositions. */
    readRetainedIndexIdentities?: () => readonly CandidateIndexIdentity[];
    /**
     * The caller's cancellation. It reaches the Agent leaf through the request
     * closures below and fences checkpoint-store lock admission here.
     */
    signal?: AbortSignal;
    listCandidates(request: Readonly<{
        cursor?: string;
        limit: number;
        searchTerm?: string;
        searchMode?: 'fast' | 'full';
        searchTarget?: 'metadata' | 'content';
        includeThreads?: boolean;
        readCandidateIndexState?(candidate: Readonly<{
            remoteSessionId: string;
            linkData?: StrictJsonObject;
        }>): StrictJsonObject | undefined;
    }>): Promise<ExternalSessionCandidatesPage>;
    /** Fresh display metadata for this selected page; never stored in the index. */
    hydrateCandidates?(
        candidates: readonly ExternalSessionCandidatesPage['candidates'][number][],
    ): Promise<readonly ExternalSessionCandidatesPage['candidates'][number][]>;
}>;

export async function executeExternalSessionCandidateQuery(params: ExternalSessionCandidateQueryRequest): Promise<ExternalSessionCandidatesPage> {
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
    if (params.cursor?.startsWith(RETIRED_INDEX_CURSOR_PREFIX)) invalidCursor();
    const keys = resolveKeys(
        params.agentIdentity,
        params.source,
        params.agentSourceCustody,
    );
    const paths = resolvePaths(params.activeServerDir, keys);
    const known = await readCandidateRowStateStore(paths.statePath);
    const readCandidateIndexState = (candidate: Readonly<{
        remoteSessionId: string;
        linkData?: StrictJsonObject;
    }>): StrictJsonObject | undefined => {
        try {
            return known.get(resolveExternalSessionCandidateIdentityKey(candidate));
        } catch {
            return undefined;
        }
    };
    let page: ExternalSessionCandidatesPage;
    try {
        page = await params.listCandidates({
            ...(params.cursor ? { cursor: params.cursor } : {}),
            limit,
            ...(params.searchTerm ? { searchTerm: params.searchTerm } : {}),
            ...(params.searchMode ? { searchMode: params.searchMode } : {}),
            ...(params.searchTarget ? { searchTarget: params.searchTarget } : {}),
            ...(params.includeThreads ? { includeThreads: true } : {}),
            readCandidateIndexState,
        });
    } catch (error) {
        if (params.cursor && error instanceof ExternalSessionProviderFailureError && error.code === 'source_invalid') {
            invalidCursor();
        }
        throw error;
    }
    params.signal?.throwIfAborted();
    await recordCandidateRowStates({
        paths,
        keys,
        candidates: page.candidates,
        known,
        ...(params.readRetainedIndexIdentities ? { readRetainedIndexIdentities: params.readRetainedIndexIdentities } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
    });
    const unsearched = !params.searchTerm && params.searchTarget !== 'content';
    const selected = unsearched && params.hydrateCandidates
        ? await hydrateSelectedPage(page, params.hydrateCandidates)
        : page;
    return publishCandidatePage({
        ...selected,
        candidates: selected.candidates.filter(candidate => !candidate.cwd || !isManagedSessionDirectoryPath(candidate.cwd)),
    }, limit, maxBytes);
}
