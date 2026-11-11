import { SCM_OPERATION_ERROR_CODES, type ScmStatusEntriesRequest, type ScmStatusEntriesResponse } from '@happier-dev/protocol';

import { scmRepositoryService } from '@/scm/scmRepositoryService';
import { resolveRepoScmSessionRequest } from '@/scm/repository/resolveRepoScmSessionRequest';
import { machineScmStatusEntries } from '@/sync/ops/scm/machineScm';
import type { ScmWorkingEntry, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

/**
 * Bounded entries window for the Files surface (plan units 6 / D3 / T5 / T7).
 *
 * One freshness owner: the surface's snapshot signature/`fetchedAt` advance
 * drives `refresh()`. No TTL cache, no second poll, no generation machinery —
 * each page is a fresh bounded read and the window re-resolves on advance.
 *
 * Modes:
 *  - `window` — collapsed rows from one entries-carrying `'normal'`-mode
 *    snapshot fetch (directory rows + loose files, bounded even for 30k-file
 *    trees). Directory rows expand via the paged `scm.status.entries`
 *    `expandPath` read with load-more.
 *  - `snapshot-fallback` (T5) — the entries RPC is unsupported (old daemon or
 *    sapling backend): refetch the snapshot with `includeEntries: true` and
 *    render today's per-file UX. Never a dead-end error state.
 */

export type ScmStatusEntriesWindowMode = 'idle' | 'window' | 'snapshot-fallback';

export type ScmStatusEntriesExpansionState = Readonly<{
    directoryPath: string;
    entries: readonly ScmWorkingEntry[];
    loading: boolean;
    hasMore: boolean;
    error?: string;
}>;

export type ScmStatusEntriesWindowState = Readonly<{
    mode: ScmStatusEntriesWindowMode;
    status: 'idle' | 'loading' | 'ready' | 'error';
    /** Collapsed rows (directory entries + loose files) served by the window. */
    entries: readonly ScmWorkingEntry[];
    /** T5 fallback rows: entries-carrying snapshot in today's per-file shape. */
    fallbackEntries: readonly ScmWorkingEntry[] | null;
    expansions: ReadonlyMap<string, ScmStatusEntriesExpansionState>;
    /** The daemon's shared entry budget truncated the collapsed rows. */
    truncated: boolean;
    error?: string;
}>;

const IDLE_STATE: ScmStatusEntriesWindowState = Object.freeze({
    mode: 'idle',
    status: 'idle',
    entries: [],
    fallbackEntries: null,
    expansions: Object.freeze(new Map()),
    truncated: false,
});

const ENTRIES_WINDOW_SNAPSHOT_OPTIONS = Object.freeze({
    includeEntries: true,
    untrackedFiles: 'normal',
} as const);

const FALLBACK_SNAPSHOT_OPTIONS = Object.freeze({
    includeEntries: true,
    untrackedFiles: 'all',
} as const);

function isEntriesRpcUnsupported(response: ScmStatusEntriesResponse): boolean {
    return (
        response.success !== true
        && (
            response.errorCode === SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED
            || response.errorCode === SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE
        )
    );
}

/**
 * In-flight sharing for identical page requests: two open surfaces (files pane,
 * commit tab) must collapse onto one request instead of racing duplicate reads.
 * Keyed by the full request shape; entries settle, so coalescing is safe.
 */
const inFlightPageRequests = new Map<string, Promise<ScmStatusEntriesResponse>>();

function requestPageKey(machineId: string, resolvedPath: string, request: ScmStatusEntriesRequest): string {
    return [machineId, resolvedPath, request.expandPath ?? '', request.afterPath ?? '', request.limit ?? ''].join('\u0000');
}

async function fetchEntriesPage(
    machineId: string,
    resolvedPath: string,
    request: ScmStatusEntriesRequest
): Promise<ScmStatusEntriesResponse> {
    const key = requestPageKey(machineId, resolvedPath, request);
    const existing = inFlightPageRequests.get(key);
    if (existing) return await existing;

    const requestPromise = (async () => {
        return await machineScmStatusEntries(machineId, { cwd: resolvedPath, ...request });
    })();
    inFlightPageRequests.set(key, requestPromise);
    try {
        return await requestPromise;
    } finally {
        if (inFlightPageRequests.get(key) === requestPromise) {
            inFlightPageRequests.delete(key);
        }
    }
}

type RequestTarget = Readonly<{
    machineId: string;
    resolvedPath: string;
}>;

function resolveRequestTarget(sessionId: string): RequestTarget | null {
    const request = resolveRepoScmSessionRequest({ sessionId });
    if (!request || !request.machineId) return null;
    return { machineId: request.machineId, resolvedPath: request.resolvedPath };
}

export class ScmStatusEntriesWindow {
    private readonly sessionId: string;
    private state: ScmStatusEntriesWindowState = IDLE_STATE;
    private readonly listeners = new Set<() => void>();
    private requestSeq = 0;
    private readonly expansionCursors = new Map<string, string>();

    constructor(input: { sessionId: string }) {
        this.sessionId = input.sessionId;
    }

    getState(): ScmStatusEntriesWindowState {
        return this.state;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private publish(next: ScmStatusEntriesWindowState): void {
        this.state = next;
        for (const listener of this.listeners) {
            listener();
        }
    }

    /**
     * One freshness owner: driven by the snapshot signature/fetchedAt advance.
     * Keeps last-known rows mounted while loading (no empty-state flash).
     */
    async refresh(): Promise<void> {
        const seq = ++this.requestSeq;
        const target = resolveRequestTarget(this.sessionId);
        if (!target) {
            this.publish({ ...IDLE_STATE, status: 'error', error: 'unresolved_session_repo' });
            return;
        }

        this.publish({
            ...this.state,
            // Honest status while a refresh is in flight; last-known rows stay
            // mounted (no empty-state flash) and the mode keeps serving rows.
            status: 'loading',
        });

        try {
            if (this.state.mode === 'snapshot-fallback') {
                await this.refreshSnapshotFallback(target, seq);
                return;
            }

            const snapshot = await scmRepositoryService.fetchSnapshotForSession(this.sessionId, ENTRIES_WINDOW_SNAPSHOT_OPTIONS);
            if (seq !== this.requestSeq) return;
            if (!snapshot || !snapshot.repo.isRepo) {
                this.publish({ ...IDLE_STATE, status: 'error', error: 'unresolved_session_repo' });
                return;
            }
            if (snapshot.entriesPresentation === 'omitted') {
                // Entries-carrying requests must never come back omitted; treat
                // the shape as unsupported and degrade to today's snapshot UX.
                await this.refreshSnapshotFallback(target, seq);
                return;
            }

            this.expansionCursors.clear();
            this.publish({
                mode: 'window',
                status: 'ready',
                entries: snapshot.entries,
                fallbackEntries: null,
                expansions: new Map(),
                truncated: snapshot.entriesPresentation === 'truncated',
            });
        } catch (error) {
            if (seq !== this.requestSeq) return;
            const message = error instanceof Error ? error.message : 'Unknown source-control error';
            // Preserve last-known rows; surface the error without a dead end.
            this.publish({ ...this.state, status: 'error', error: message });
        }
    }

    private async refreshSnapshotFallback(target: RequestTarget, seq: number): Promise<void> {
        const snapshot = await scmRepositoryService.fetchSnapshotForSession(this.sessionId, FALLBACK_SNAPSHOT_OPTIONS);
        if (seq !== this.requestSeq) return;
        if (!snapshot || !snapshot.repo.isRepo) {
            this.publish({ ...IDLE_STATE, status: 'error', error: 'unresolved_session_repo' });
            return;
        }
        this.expansionCursors.clear();
        this.publish({
            mode: 'snapshot-fallback',
            status: 'ready',
            entries: [],
            fallbackEntries: snapshot.entries,
            expansions: new Map(),
            truncated: snapshot.entriesPresentation === 'truncated',
        });
    }

    /**
     * Continue a truncated normal-mode window through the paged entries route: the RPC pages
     * top-level rows with an exclusive `afterPath` cursor (same route the directory expansions
     * use), so a snapshot whose entry budget cut the list short can still reach the rest.
     */
    async loadMoreTopLevel(): Promise<void> {
        if (this.state.mode !== 'window' || this.state.status !== 'ready' || !this.state.truncated) return;
        if (this.state.entries.length === 0) return;
        const target = resolveRequestTarget(this.sessionId);
        if (!target) return;
        const afterPath = this.state.entries[this.state.entries.length - 1]?.path;
        if (!afterPath) return;

        this.publish({ ...this.state, status: 'loading' });
        const seq = ++this.requestSeq;
        try {
            const response = await fetchEntriesPage(target.machineId, target.resolvedPath, { afterPath });
            if (seq !== this.requestSeq) return;
            if (isEntriesRpcUnsupported(response)) {
                await this.enterSnapshotFallback();
                return;
            }
            if (response.success !== true) {
                this.publish({ ...this.state, status: 'ready', error: response.error ?? 'Failed to load entries' });
                return;
            }
            const knownPaths = new Set(this.state.entries.map((entry) => entry.path));
            const appended = response.entries.filter((entry) => !knownPaths.has(entry.path));
            this.publish({
                ...this.state,
                status: 'ready',
                error: undefined,
                entries: [...this.state.entries, ...appended],
                truncated: response.hasMore,
            });
        } catch (error) {
            if (seq !== this.requestSeq) return;
            this.publish({ ...this.state, status: 'ready', error: error instanceof Error ? error.message : 'Failed to load entries' });
        }
    }

    async expandDirectory(directoryPath: string): Promise<void> {
        const normalized = directoryPath;
        if (this.state.expansions.has(normalized)) return;
        const target = resolveRequestTarget(this.sessionId);
        if (!target || this.state.mode === 'snapshot-fallback') return;

        this.publishExpansion(normalized, {
            directoryPath: normalized,
            entries: [],
            loading: true,
            hasMore: false,
        });
        // Identity of the placeholder this request owns. A collapse (or a newer expand for the
        // same directory) replaces the map entry; a reply that no longer targets the live
        // expansion object must be dropped, or it resurrects a collapsed directory.
        const requestExpansion = this.state.expansions.get(normalized);
        const isLiveRequest = () => this.state.expansions.get(normalized) === requestExpansion;

        const seq = this.requestSeq;
        try {
            const response = await fetchEntriesPage(target.machineId, target.resolvedPath, {
                expandPath: normalized,
            });
            if (seq !== this.requestSeq || !isLiveRequest()) return;
            if (isEntriesRpcUnsupported(response)) {
                await this.enterSnapshotFallback();
                return;
            }
            if (response.success !== true) {
                if (!isLiveRequest()) return;
                this.publishExpansion(normalized, {
                    directoryPath: normalized,
                    entries: [],
                    loading: false,
                    hasMore: false,
                    error: response.error ?? 'Failed to load directory entries',
                });
                return;
            }
            if (!isLiveRequest()) return;
            this.expansionCursors.set(normalized, response.nextCursor ?? '');
            this.publishExpansion(normalized, {
                directoryPath: normalized,
                entries: response.entries,
                loading: false,
                hasMore: response.hasMore,
            });
        } catch (error) {
            if (seq !== this.requestSeq || !isLiveRequest()) return;
            this.publishExpansion(normalized, {
                directoryPath: normalized,
                entries: [],
                loading: false,
                hasMore: false,
                error: error instanceof Error ? error.message : 'Failed to load directory entries',
            });
        }
    }

    collapseDirectory(directoryPath: string): void {
        const normalized = directoryPath;
        if (!this.state.expansions.has(normalized)) return;
        this.expansionCursors.delete(normalized);
        const expansions = new Map(this.state.expansions);
        expansions.delete(normalized);
        this.publish({ ...this.state, expansions });
    }

    async loadMoreExpanded(directoryPath: string): Promise<void> {
        const normalized = directoryPath;
        const expansion = this.state.expansions.get(normalized);
        const cursor = this.expansionCursors.get(normalized);
        if (!expansion || expansion.loading || !expansion.hasMore || !cursor) return;
        const target = resolveRequestTarget(this.sessionId);
        if (!target) return;

        this.publishExpansion(normalized, { ...expansion, loading: true });
        // Same liveness contract as expandDirectory: drop replies that no longer target the
        // live expansion object (collapsed or replaced while the page request was in flight).
        const requestExpansion = this.state.expansions.get(normalized);
        const isLiveRequest = () => this.state.expansions.get(normalized) === requestExpansion;

        const seq = this.requestSeq;
        try {
            const response = await fetchEntriesPage(target.machineId, target.resolvedPath, {
                expandPath: normalized,
                afterPath: cursor,
            });
            if (seq !== this.requestSeq || !isLiveRequest()) return;
            if (isEntriesRpcUnsupported(response)) {
                await this.enterSnapshotFallback();
                return;
            }
            if (response.success !== true) {
                if (!isLiveRequest()) return;
                this.publishExpansion(normalized, {
                    ...expansion,
                    loading: false,
                    error: response.error ?? 'Failed to load directory entries',
                });
                return;
            }
            if (!isLiveRequest()) return;
            this.expansionCursors.set(normalized, response.nextCursor ?? '');
            const knownPaths = new Set(expansion.entries.map((entry) => entry.path));
            const appended = response.entries.filter((entry) => !knownPaths.has(entry.path));
            this.publishExpansion(normalized, {
                directoryPath: normalized,
                entries: [...expansion.entries, ...appended],
                loading: false,
                hasMore: response.hasMore,
            });
        } catch (error) {
            if (seq !== this.requestSeq || !isLiveRequest()) return;
            this.publishExpansion(normalized, {
                ...expansion,
                loading: false,
                error: error instanceof Error ? error.message : 'Failed to load directory entries',
            });
        }
    }

    private async enterSnapshotFallback(): Promise<void> {
        const target = resolveRequestTarget(this.sessionId);
        if (!target) return;
        const seq = this.requestSeq;
        try {
            await this.refreshSnapshotFallback(target, seq);
        } catch {
            // Keep the window state honest; the surface renders snapshot rows.
        }
    }

    private publishExpansion(directoryPath: string, expansion: ScmStatusEntriesExpansionState): void {
        const expansions = new Map(this.state.expansions);
        expansions.set(directoryPath, expansion);
        this.publish({ ...this.state, expansions });
    }

    /** Stops in-flight page/snapshot work from publishing after the surface closed. */
    dispose(): void {
        this.requestSeq += 1;
        this.listeners.clear();
    }
}
