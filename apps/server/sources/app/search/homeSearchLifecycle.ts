import type { MemorySearchQueryV1, MemorySearchResultV1 } from '@happier-dev/protocol/memory/memorySearch';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
    registerSessionTranscriptMutationObserver,
    type SessionTranscriptMutation,
} from '@/app/session/sessionTranscriptMutationObserver';
import {
    isPlainHomeStoragePolicy,
    resolveHomeSearchCapability,
    type HomeSearchCapability,
} from './homeSearchCapability';
import { openHomeSearchDb, type HomeSearchDb } from './homeSearchDb';
import {
    createHomeSearchIndexer,
    type HomeSearchCanonicalMessage,
    type HomeSearchCanonicalPageReader,
    type HomeSearchIndexer,
} from './homeSearchIndexer';
import { createHomeSearchService } from './homeSearchService';
import type { HomeSearchRequestContext } from './homeSearchService';

type HomeSearchInvalidationReason = 'restore' | 'erase' | 'corruption' | 'explicit-repair';

/**
 * Bound on distinct canonical identities retained while the derived projection is unsettled.
 * It protects process memory — each retained upsert keeps a full canonical message snapshot —
 * and never caps user content: exceeding it discards the dirty projection, and one additional
 * canonical paged reconciliation restores exactness. The value only trades a rare extra
 * reconciliation against unbounded retained snapshots during long startup/rebuild windows.
 */
export const HOME_SEARCH_CATCHUP_DIRTY_IDENTITY_LIMIT = 1_000;

/** Coalesced catch-up state for one canonical identity; the last committed op per identity wins. */
type HomeSearchDirtyOp =
    | Readonly<{ kind: 'upsert'; message: HomeSearchCanonicalMessage }>
    | Readonly<{ kind: 'remove-message'; messageId: string }>
    | Readonly<{ kind: 'remove-session'; sessionId: string }>;

export type HomeSearchLifecycle = Readonly<{
    capability(): HomeSearchCapability;
    search(query: MemorySearchQueryV1, context?: HomeSearchRequestContext): MemorySearchResultV1;
    prepare(sessionIds: readonly string[]): Promise<void>;
    whenReady(): Promise<void>;
    invalidateAndRebuild(reason: HomeSearchInvalidationReason): Promise<void>;
    stop(): Promise<void>;
}>;

function isRebuildableIndexError(error: unknown): boolean {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const message = error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
    return code === 'SQLITE_CORRUPT'
        || code === 'SQLITE_NOTADB'
        || /malformed|not a database|SQLITE_CORRUPT|SQLITE_NOTADB|Unsupported Personal Home search schema version/iu.test(message);
}

async function removeDerivedIndexFiles(dbPath: string): Promise<void> {
    const exactPath = resolve(dbPath);
    await Promise.all([
        rm(exactPath, { force: true }),
        rm(`${exactPath}-wal`, { force: true }),
        rm(`${exactPath}-shm`, { force: true }),
    ]);
}

/** Owns one derived FTS database, demanded Session scopes, live observer, rebuild, and shutdown. */
export function startHomeSearchLifecycle(params: Readonly<{
    dbPath: string;
    homeServerIdentityId: string | (() => Promise<string>);
    storagePolicy: string;
    readCanonicalMessagesPage: HomeSearchCanonicalPageReader;
    openDb?: typeof openHomeSearchDb;
}>): HomeSearchLifecycle {
    const plainHome = isPlainHomeStoragePolicy(params.storagePolicy);
    // Visibility is decided by the request's canonical access owner. Retain only the scopes
    // that have actually been requested, including shared Sessions owned by another Account.
    const demandedSessionIds = new Set<string>();
    // Bounded coalesced catch-up for mutations committed while the derived projection is not
    // settled (before attach, during rebuild, and until the post-reconcile flush completes).
    // Ordered by each identity's last committed mutation. Applying those final operations in
    // last-occurrence order preserves overlap between a session removal and later message
    // recreation while retaining at most one operation per canonical identity.
    const dirty = new Map<string, HomeSearchDirtyOp>();
    let dirtyOverflow = false;
    let settledIndexer: HomeSearchIndexer | null = null;
    let catchUpPromise: Promise<void> | null = null;
    let homeServerIdentityId = typeof params.homeServerIdentityId === 'string' ? params.homeServerIdentityId : '';
    let db: HomeSearchDb | null = null;
    let indexer: HomeSearchIndexer | null = null;
    let started = false;
    let stopped = false;
    let failed = false;
    let readyPromise: Promise<void> = Promise.resolve();
    let rebuildPromise: Promise<void> | null = null;

    const assertReadyCurrentIndexer = () => {
        if (failed || indexer === null || indexer !== settledIndexer || !indexer.ready()) {
            throw new Error('Personal Home search rebuild did not produce a ready index');
        }
    };

    const deliverMutation = (target: HomeSearchIndexer, mutation: SessionTranscriptMutation) => {
        if (mutation.kind === 'upsert') target.notify(mutation.message);
        else if (mutation.kind === 'remove-messages') target.removeMessages(mutation.messageIds);
        else target.removeSession(mutation.sessionId);
    };
    const recordDirty = (key: string, op: HomeSearchDirtyOp) => {
        if (!dirty.has(key) && dirty.size >= HOME_SEARCH_CATCHUP_DIRTY_IDENTITY_LIMIT) {
            // Coalescing no longer protects process memory. Discard the projection; the flush
            // falls back to the existing canonical paged reconciliation for an exact result.
            dirty.clear();
            dirtyOverflow = true;
        }
        // Map#set does not move an existing key. Move it explicitly so cross-identity
        // operations replay in their last committed order (for example, remove-session then
        // recreate-message), rather than the order in which each identity first became dirty.
        dirty.delete(key);
        dirty.set(key, op);
    };
    const bufferMutation = (mutation: SessionTranscriptMutation) => {
        if (mutation.kind === 'upsert') recordDirty(`message:${mutation.message.id}`, { kind: 'upsert', message: mutation.message });
        else if (mutation.kind === 'remove-messages') {
            for (const messageId of mutation.messageIds) recordDirty(`message:${messageId}`, { kind: 'remove-message', messageId });
        } else recordDirty(`session:${mutation.sessionId}`, { kind: 'remove-session', sessionId: mutation.sessionId });
    };
    const discardDirtyCatchUp = () => {
        dirty.clear();
        dirtyOverflow = false;
    };
    const flushCatchUp = (target: HomeSearchIndexer): Promise<void> => {
        if (catchUpPromise) return catchUpPromise;
        const work = (async () => {
            while (indexer === target && !stopped) {
                if (dirtyOverflow) {
                    dirtyOverflow = false;
                    dirty.clear();
                    await target.reconcile([...demandedSessionIds]);
                    continue;
                }
                const pending = [...dirty.values()];
                dirty.clear();
                for (const op of pending) {
                    deliverMutation(target, op.kind === 'upsert'
                        ? { kind: 'upsert', message: op.message }
                        : op.kind === 'remove-message'
                            ? { kind: 'remove-messages', messageIds: [op.messageId] }
                            : { kind: 'remove-session', sessionId: op.sessionId });
                }
                // Deliveries append to the indexer's serialization tail. Do not advertise the
                // lifecycle as settled until every SQLite effect has completed; mutations that
                // commit during this drain remain in `dirty` and are consumed by the next loop.
                await target.whenIdle();
                if (!target.ready()) return;
                if (dirtyOverflow || dirty.size > 0) continue;
                settledIndexer = target;
                return;
            }
        })().finally(() => {
            if (catchUpPromise === work) catchUpPromise = null;
        });
        catchUpPromise = work;
        return work;
    };
    const applyMutation = (mutation: SessionTranscriptMutation) => {
        if (stopped || !plainHome) return;
        if (failed && !rebuildPromise) return;
        if (mutation.kind === 'upsert' && !demandedSessionIds.has(mutation.message.sessionId)) return;
        if (mutation.kind === 'remove-session' && !demandedSessionIds.has(mutation.sessionId)) return;
        if (demandedSessionIds.size === 0) return;
        if (!indexer) {
            // Retain catch-up only while startup or a rebuild is actively able to produce a
            // replacement indexer. Once that finite transition fails, canonical reconciliation
            // on the next explicit repair is the source of truth; detached mutations are dropped.
            if (started && (!failed || rebuildPromise)) bufferMutation(mutation);
            return;
        }
        if (indexer !== settledIndexer || rebuildPromise || catchUpPromise) {
            bufferMutation(mutation);
            return;
        }
        deliverMutation(indexer, mutation);
    };

    let unregisterObserver: (() => void) | null = plainHome
        ? registerSessionTranscriptMutationObserver(applyMutation)
        : null;

    const beginRebuild = (reason: HomeSearchInvalidationReason): Promise<void> => {
        if (stopped || !plainHome) return Promise.resolve();
        if (rebuildPromise) {
            if (reason !== 'explicit-repair') return rebuildPromise;
            return rebuildPromise.then(assertReadyCurrentIndexer);
        }
        started = true;
        failed = true;
        // Recovery starts from canonical transcript rows. Dirty events retained before this
        // boundary may belong to the failed projection and must not be replayed over the new
        // canonical snapshot. Mutations committed after this point are buffered normally while
        // the replacement projection reconciles.
        discardDirtyCatchUp();
        const work = Promise.resolve().then(async () => {
            const previousIndexer = indexer;
            indexer = null;
            settledIndexer = null;
            await previousIndexer?.stop();
            db?.close();
            db = null;
            await removeDerivedIndexFiles(params.dbPath);
            if (!stopped) await openAndStart(false, reason === 'explicit-repair');
            if (reason === 'explicit-repair') assertReadyCurrentIndexer();
        }).catch((error: unknown) => {
            failed = true;
            if (!indexer) discardDirtyCatchUp();
            // Automatic startup/corruption recovery is reflected through capability/readiness
            // so it cannot crash server startup. An authenticated explicit repair is different:
            // its caller needs a truthful operation result rather than a false success response.
            if (reason === 'explicit-repair') throw error;
        }).finally(() => {
            if (rebuildPromise === work) rebuildPromise = null;
        });
        rebuildPromise = work;
        // Readiness settles unavailable on failure; the explicit operation keeps its rejection.
        readyPromise = work.catch(() => undefined);
        return work;
    };

    const handleFailure = (error: unknown) => {
        failed = true;
        if (!stopped && started && isRebuildableIndexError(error)) {
            queueMicrotask(() => { void beginRebuild('corruption'); });
        }
    };

    const handleQueryFailure = (error: unknown) => {
        // An ordinary request failure is local to that request. Only evidence that the
        // rebuildable SQLite projection is corrupt changes provider readiness.
        if (isRebuildableIndexError(error)) handleFailure(error);
    };

    const attach = (nextDb: HomeSearchDb, sessionIds: readonly string[]) => {
        db = nextDb;
        const nextIndexer = createHomeSearchIndexer({
            db: nextDb,
            readCanonicalMessagesPage: params.readCanonicalMessagesPage,
            onFailure: handleFailure,
        });
        indexer = nextIndexer;
        nextIndexer.start(sessionIds);
        return nextIndexer;
    };

    async function openDatabase(repairCorruption: boolean): Promise<HomeSearchDb> {
        const opener = params.openDb ?? openHomeSearchDb;
        try {
            return await opener({ dbPath: params.dbPath });
        } catch (error) {
            if (!repairCorruption || !isRebuildableIndexError(error)) throw error;
            await removeDerivedIndexFiles(params.dbPath);
            return await opener({ dbPath: params.dbPath });
        }
    }

    async function openAndStart(repairCorruption: boolean, propagateFailure = false, sessionIds = [...demandedSessionIds]): Promise<void> {
        try {
            if (typeof params.homeServerIdentityId === 'function') {
                homeServerIdentityId = await params.homeServerIdentityId();
            }
            const nextDb = await openDatabase(repairCorruption);
            if (stopped) {
                nextDb.close();
                return;
            }
            failed = false;
            const nextIndexer = attach(nextDb, sessionIds);
            await nextIndexer.whenReady();
            // Reconciliation can overlap canonical commits. Catch up everything coalesced
            // while this projection was unsettled; an overflowed projection re-derives its
            // exact state through the existing canonical paged reconciliation.
            if (indexer === nextIndexer) await flushCatchUp(nextIndexer);
            if (indexer === nextIndexer && nextIndexer.ready()) failed = false;
        } catch (error) {
            handleFailure(error);
            if (!indexer) discardDirtyCatchUp();
            if (propagateFailure) throw error;
        }
    }

    const currentService = () => createHomeSearchService({
        db,
        homeServerIdentityId,
        storagePolicy: params.storagePolicy,
        isReady: () => !failed && indexer !== null && indexer === settledIndexer,
        onFailure: handleQueryFailure,
    });

    return {
        capability() {
            if (!plainHome) return resolveHomeSearchCapability({ indexReady: false });
            if (stopped || failed || rebuildPromise) {
                return { enabled: false, reason: 'index_unavailable' };
            }
            // A cold provider accepts demand. Advertising unavailable until a request starts
            // indexing would prevent clients that select a provider from ever making it.
            if (!started) return { enabled: true };
            return resolveHomeSearchCapability({
                indexReady: db !== null,
                indexing: indexer === null || indexer !== settledIndexer,
            });
        },
        search(query, context) {
            if (stopped || failed || rebuildPromise) {
                return { v: 1, ok: false, errorCode: 'memory_index_missing', error: 'Personal Home search index is unavailable' };
            }
            return currentService().search(query, context);
        },
        prepare(sessionIds) {
            if (stopped || !plainHome || (failed && !rebuildPromise)) return readyPromise;
            const missing = [...new Set(sessionIds)].filter(sessionId => !demandedSessionIds.has(sessionId));
            for (const sessionId of missing) demandedSessionIds.add(sessionId);
            if (!started) {
                started = true;
                const initialScope = [...demandedSessionIds];
                readyPromise = Promise.resolve().then(() => openAndStart(true, false, initialScope));
            } else if (missing.length > 0) {
                const previous = readyPromise;
                const work = previous.then(async () => {
                    if (stopped || failed || !indexer) return;
                    const target = indexer;
                    settledIndexer = null;
                    await target.reconcile(missing);
                    if (indexer === target) await flushCatchUp(target);
                }).catch(handleFailure);
                readyPromise = work;
            }
            return readyPromise;
        },
        whenReady() { return readyPromise; },
        invalidateAndRebuild(reason) { return beginRebuild(reason); },
        async stop() {
            if (stopped) return;
            stopped = true;
            unregisterObserver?.();
            unregisterObserver = null;
            // Signal the current indexer before joining readiness. The startup/rebuild
            // projection is reconstructible canonical-derived state, so shutdown must not wait
            // for its remaining pages; the signal makes that reconciliation stop at its current
            // page. Once `stopped` is set, `openAndStart` can no longer attach a replacement
            // indexer, so nothing restarts reconciliation behind this signal.
            const stopRequest = indexer?.stop() ?? Promise.resolve();
            await readyPromise.catch(() => undefined);
            // Join the in-flight page before closing SQLite.
            await stopRequest;
            await indexer?.stop();
            indexer = null;
            db?.close();
            db = null;
        },
    };
}
