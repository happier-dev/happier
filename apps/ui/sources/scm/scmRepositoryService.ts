import type {
    ScmStatusSnapshotResponse,
    ScmWorkingSnapshot as ProtocolScmWorkingSnapshot,
    ScmWorktreeEnrichmentEntry,
} from '@happier-dev/protocol';
import { SCM_WORKTREES_ENRICHMENT_MAX_PATHS } from '@happier-dev/protocol';

import type { ScmCapabilities, ScmStatus, ScmWorkingSnapshot as UiScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { sessionScmStatusSnapshot } from '@/sync/ops';
import { machineScmStatusSnapshot, machineScmWorktreesEnrichment } from '@/sync/ops/scm/machineScm';
import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { resolveRepoScmMachinePathRequest } from '@/scm/repository/resolveRepoScmMachinePathRequest';
import { resolveRepoScmSessionRequest } from '@/scm/repository/resolveRepoScmSessionRequest';
import { LruMap } from '@/utils/cache/lruMap';
import {
    EMPTY_SCM_CAPABILITIES,
    mapProtocolSnapshotToUiSnapshot,
    mergeScmCapabilities,
} from '@/scm/core/snapshotMappers';
import { resolveCanonicalScmProjectKey } from '@/scm/core/resolveCanonicalScmProjectKey';

/**
 * FR4-13 — bounded enrichment cache defaults.
 *
 *   - `DEFAULT_MAX_REPO_ENRICHMENT_CACHE_ENTRIES` caps the OUTER cache (distinct repos).
 *   - `DEFAULT_MAX_PER_REPO_ENRICHMENT_ENTRIES` caps the INNER cache (worktree paths
 *     within a single repo). Both are tunable via the constructor for tests.
 */
const DEFAULT_MAX_REPO_ENRICHMENT_CACHE_ENTRIES = 32;
const DEFAULT_MAX_PER_REPO_ENRICHMENT_ENTRIES = 64;

type RepoSnapshotRequestContext = Readonly<{
    machineId: string;
    resolvedPath: string;
    includeWorktreeStatus: boolean;
}>;

/**
 * Entry-delivery options for a snapshot fetch.
 *
 * Default (no options) = the summary poll shape:
 * `{ includeEntries: false, untrackedFiles: 'normal' }` — totals and non-entry
 * facts only, per the delivery-follows-consumption split. Entry rows load on
 * demand (Files surface window, attribution refetch) via explicit options:
 *
 *  - `{ includeEntries: true, untrackedFiles: 'normal' }` — collapsed rows
 *    (directory entries + loose files); the attribution diff shape.
 *  - `{ includeEntries: true, untrackedFiles: 'all' }` — today's per-file UX;
 *    the fallback shape when the paged entries RPC is unsupported (old daemon,
 *    sapling backend).
 *
 * Old daemons strip the unknown request fields and return today's exact
 * full-entry response, so every shape degrades safely.
 */
export type ScmSnapshotFetchOptions = Readonly<{
    includeEntries?: boolean;
    untrackedFiles?: 'normal' | 'all';
}>;

const SUMMARY_SCM_STATUS_REQUEST_FIELDS = Object.freeze({
    includeEntries: false,
    untrackedFiles: 'normal',
} as const);

function buildScmStatusRequestFields(options?: ScmSnapshotFetchOptions): {
    includeEntries: boolean;
    untrackedFiles: 'normal' | 'all';
} {
    if (options?.includeEntries === true) {
        return {
            includeEntries: true,
            untrackedFiles: options.untrackedFiles ?? 'normal',
        };
    }
    return { ...SUMMARY_SCM_STATUS_REQUEST_FIELDS };
}

function scmStatusRequestCacheNamespaceSuffix(options?: ScmSnapshotFetchOptions): string {
    // Entry-carrying fetches have a different response shape than summary
    // fetches for the same repo identity; they must never dedupe against each
    // other in flight or collide in the snapshot cache. Summary stays on the
    // bare identity key so every existing readCached consumer keeps working.
    if (options?.includeEntries === true) {
        return `::entries=${options.untrackedFiles ?? 'normal'}`;
    }
    return '';
}

function splitNormalizedPathSegments(path: string): readonly string[] {
    const normalized = normalizeFileSystemPath(path);
    if (!normalized) return [];
    return normalized.split('/').filter(Boolean);
}

function countSharedLeadingPathSegments(left: string, right: string): number {
    const leftSegments = splitNormalizedPathSegments(left);
    const rightSegments = splitNormalizedPathSegments(right);
    const max = Math.min(leftSegments.length, rightSegments.length);
    let count = 0;
    while (count < max && leftSegments[count] === rightSegments[count]) {
        count += 1;
    }
    return count;
}

function chunkWorktreePathsForEnrichment(
    worktreePaths: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> {
    if (worktreePaths.length === 0) return [[]];
    const chunks: string[][] = [];
    for (let index = 0; index < worktreePaths.length; index += SCM_WORKTREES_ENRICHMENT_MAX_PATHS) {
        chunks.push(worktreePaths.slice(index, index + SCM_WORKTREES_ENRICHMENT_MAX_PATHS));
    }
    return chunks;
}

function isProtocolScmSnapshot(
    snapshot: UiScmWorkingSnapshot | ProtocolScmWorkingSnapshot
): snapshot is ProtocolScmWorkingSnapshot {
    const repo = (snapshot as ProtocolScmWorkingSnapshot).repo as ProtocolScmWorkingSnapshot['repo'] | undefined;
    return Boolean(repo && typeof repo === 'object' && 'isRepo' in repo);
}

function isScmStatusSnapshotResponse(response: unknown): response is ScmStatusSnapshotResponse {
    return Boolean(
        response
        && typeof response === 'object'
        && typeof (response as { success?: unknown }).success === 'boolean',
    );
}

function readSuccessfulSnapshot(response: unknown): ProtocolScmWorkingSnapshot | undefined {
    if (!isScmStatusSnapshotResponse(response) || response.success !== true) {
        return undefined;
    }
    return response.snapshot;
}

export function normalizeWorkingSnapshotForUi(
    snapshot: UiScmWorkingSnapshot | ProtocolScmWorkingSnapshot,
    projectKey: string
): UiScmWorkingSnapshot {
    if (!isProtocolScmSnapshot(snapshot)) {
        const backendId = snapshot.repo.backendId ?? null;
        const capabilities = mergeScmCapabilities(snapshot.capabilities ?? {});
        return {
            ...snapshot,
            projectKey: snapshot.projectKey || projectKey,
            repo: {
                ...snapshot.repo,
                backendId,
                mode: snapshot.repo.mode ?? null,
                worktrees: snapshot.repo.worktrees ?? [],
                remotes: snapshot.repo.remotes ?? [],
            },
            capabilities,
            hostingProvider: snapshot.hostingProvider ?? null,
            pullRequest: snapshot.pullRequest ?? null,
        };
    }

    return mapProtocolSnapshotToUiSnapshot(snapshot, projectKey);
}

function createEmptyScmSnapshot(input: {
    projectKey: string;
    fetchedAt?: number;
    rootPath?: string | null;
}): UiScmWorkingSnapshot {
    return {
        projectKey: input.projectKey,
        fetchedAt: input.fetchedAt ?? Date.now(),
        repo: { isRepo: false, rootPath: input.rootPath ?? null, backendId: null, mode: null },
        capabilities: EMPTY_SCM_CAPABILITIES,
        branch: { head: null, upstream: null, ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hostingProvider: null,
        pullRequest: null,
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
    };
}

function normalizeScmSnapshotResponseOrThrow(input: {
    response: unknown;
    projectKey: string;
    fetchedAt: number;
    emptyRootPath?: string | null;
}): UiScmWorkingSnapshot {
    const { response, projectKey, fetchedAt, emptyRootPath } = input;
    if (!isScmStatusSnapshotResponse(response)) {
        throw new Error('Invalid source-control status snapshot response');
    }
    if (!response.success) {
        const message = response.error || 'Failed to fetch source-control status snapshot';
        const err = new Error(message) as Error & { scmErrorCode?: string };
        if (typeof (response as { errorCode?: unknown }).errorCode === 'string') {
            err.scmErrorCode = (response as { errorCode?: string }).errorCode;
        }
        throw err;
    }

    if (!response.snapshot) {
        return createEmptyScmSnapshot({
            projectKey,
            fetchedAt,
            rootPath: emptyRootPath ?? null,
        });
    }

    return normalizeWorkingSnapshotForUi(response.snapshot, projectKey);
}

export function snapshotToScmStatus(snapshot: UiScmWorkingSnapshot): ScmStatus {
    // Totals-first: totals are computed by the backend from the FULL entry set
    // before any bounding or collapsing, so they stay truthful in every
    // delivery mode (T2). No consumer may claim "no changes" or "N changes"
    // from an omitted or truncated entries array.
    const totals = snapshot.totals;
    const totalsChangedFiles = totals.changedFiles;
    const untrackedCount = totals.untrackedFiles;
    const modifiedCount = totalsChangedFiles !== undefined
        ? Math.max(0, totalsChangedFiles - untrackedCount)
        : snapshot.entries.filter((entry) => entry.kind !== 'untracked').length;
    const isDirty = totalsChangedFiles !== undefined
        ? totalsChangedFiles > 0
        : totals.includedFiles + totals.pendingFiles + untrackedCount > 0;
    const includedCount = totals.includedFiles;
    const includedLinesAdded = totals.includedAdded;
    const includedLinesRemoved = totals.includedRemoved;
    const pendingLinesAdded = totals.pendingAdded;
    const pendingLinesRemoved = totals.pendingRemoved;
    const linesAdded = includedLinesAdded + pendingLinesAdded;
    const linesRemoved = includedLinesRemoved + pendingLinesRemoved;

    return {
        branch: snapshot.branch.head,
        isDirty,
        modifiedCount,
        untrackedCount,
        includedCount,
        lastUpdatedAt: snapshot.fetchedAt,
        includedLinesAdded,
        includedLinesRemoved,
        pendingLinesAdded,
        pendingLinesRemoved,
        linesAdded,
        linesRemoved,
        linesChanged: linesAdded + linesRemoved,
        ...(totals.isComplete === undefined ? {} : { isComplete: totals.isComplete }),
        upstreamBranch: snapshot.branch.upstream,
        aheadCount: snapshot.branch.ahead,
        behindCount: snapshot.branch.behind,
        stashCount: snapshot.stashCount,
    };
}

/**
 * Returns a NEW snapshot with per-worktree enrichment fields merged in, leaving
 * the original snapshot untouched. Worktrees that don't appear in `enrichment`
 * are returned as-is (so an empty enrichment array is a no-op that yields the
 * same snapshot reference — useful for React equality short-circuits).
 *
 * This is the canonical merge used by the SCM-aware new-session screen: the
 * UI fetches a lightweight snapshot first, then refines per-worktree
 * `changeCount` + `lastActivityAt` in the background via the dedicated
 * `scm.worktrees.enrichment` RPC. Splitting the heavy enrichment off the hot
 * path keeps the worktree-picker chip visible within sub-second latency.
 */
export function mergeWorktreesEnrichmentIntoSnapshot(
    snapshot: UiScmWorkingSnapshot,
    enrichment: ReadonlyArray<ScmWorktreeEnrichmentEntry>,
): UiScmWorkingSnapshot {
    if (enrichment.length === 0) return snapshot;
    if (!snapshot.repo.worktrees || snapshot.repo.worktrees.length === 0) return snapshot;

    const enrichmentByPath = new Map<string, ScmWorktreeEnrichmentEntry>();
    for (const entry of enrichment) {
        enrichmentByPath.set(entry.path, entry);
    }

    let didChange = false;
    const nextWorktrees = snapshot.repo.worktrees.map((worktree) => {
        const enrichmentEntry = enrichmentByPath.get(worktree.path);
        if (!enrichmentEntry) return worktree;
        const merged = { ...worktree };
        if (enrichmentEntry.changeCount !== undefined) {
            merged.changeCount = enrichmentEntry.changeCount;
            didChange = didChange || worktree.changeCount !== enrichmentEntry.changeCount;
        }
        if (enrichmentEntry.lastActivityAt !== undefined) {
            merged.lastActivityAt = enrichmentEntry.lastActivityAt;
            didChange = didChange || worktree.lastActivityAt !== enrichmentEntry.lastActivityAt;
        }
        return merged;
    });

    if (!didChange) return snapshot;

    return {
        ...snapshot,
        repo: {
            ...snapshot.repo,
            worktrees: nextWorktrees,
        },
    };
}

export class ScmRepositoryService {
    private repoSnapshotRequests = new Map<string, Promise<UiScmWorkingSnapshot | null>>();
    private repoSnapshotRequestContexts = new Map<string, RepoSnapshotRequestContext>();
    private repoSnapshotCache = new Map<string, UiScmWorkingSnapshot | null>();
    private repoSnapshotAliases: LruMap<string, string>;
    // Enrichment-only cache: per-repo LruMap of canonical worktree path → entry.
    // Storing per-path entries (rather than per-request snapshots) lets us merge
    // the result of multiple requests over different worktree subsets WITHOUT
    // invalidating earlier entries. This is the F6 fix: a previous design keyed
    // both the cache and the in-flight map by repo identity only, which meant a
    // request for [b,c] would either receive the in-flight response for [a,b]
    // (silent shape mismatch) or overwrite the cached [a,b] entries with [b,c].
    //
    // FR4-13: both the outer (per-repo) and inner (per-worktree-path) caches are now
    // bounded via LruMap so a long-running UI session that visits many repos and
    // worktrees cannot accumulate enrichment entries indefinitely. Reading via the
    // public `readCachedWorktreesEnrichment` API refreshes LRU recency on the outer
    // map so an actively-used repo is not evicted ahead of an idle one.
    private worktreesEnrichmentCache: LruMap<string, LruMap<string, ScmWorktreeEnrichmentEntry>>;
    private readonly maxPerRepoEnrichmentEntries: number;
    // In-flight key includes a deterministic projection of the requested paths
    // so identical concurrent requests are deduped, but requests for different
    // subsets can run in parallel.
    private worktreesEnrichmentRequests = new Map<string, Promise<ScmWorktreeEnrichmentEntry[] | null>>();

    constructor(options?: Readonly<{
        maxAliasEntries?: number;
        /** FR4-13: cap on distinct repos held in the enrichment cache (default 32). */
        maxRepoEnrichmentCacheEntries?: number;
        /** FR4-13: cap on per-repo worktree-path entries (default 64). */
        maxPerRepoEnrichmentEntries?: number;
    }>) {
        this.repoSnapshotAliases = new LruMap<string, string>({
            maxEntries: this.normalizeMaxAliasEntries(options?.maxAliasEntries),
        });
        const maxRepoEntries = this.normalizePositiveCount(
            options?.maxRepoEnrichmentCacheEntries,
            DEFAULT_MAX_REPO_ENRICHMENT_CACHE_ENTRIES,
        );
        this.worktreesEnrichmentCache = new LruMap<string, LruMap<string, ScmWorktreeEnrichmentEntry>>({
            maxEntries: maxRepoEntries,
        });
        this.maxPerRepoEnrichmentEntries = this.normalizePositiveCount(
            options?.maxPerRepoEnrichmentEntries,
            DEFAULT_MAX_PER_REPO_ENRICHMENT_ENTRIES,
        );
    }

    private normalizePositiveCount(value: unknown, fallback: number): number {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return Math.max(1, Math.floor(value));
        }
        return fallback;
    }

    private normalizeMaxAliasEntries(value: unknown): number {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return Math.max(0, Math.floor(value));
        }

        const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SCM_REPO_SNAPSHOT_ALIAS_CACHE_MAX ?? '').trim();
        if (!raw) return 2048;
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed)) return 2048;
        return Math.max(0, Math.min(100_000, parsed));
    }

    private resolveCachedRepoIdentityKeyForMachinePath(input: Readonly<{
        machineId: string;
        resolvedPath: string;
        repoIdentityKey: string;
    }>): string | null {
        const normalizedResolvedPath = normalizeFileSystemPath(input.resolvedPath);
        if (!normalizedResolvedPath) {
            return null;
        }

        const aliasedIdentityKey = this.repoSnapshotAliases.get(input.repoIdentityKey);
        if (aliasedIdentityKey) {
            if (this.repoSnapshotCache.has(aliasedIdentityKey)) {
                return aliasedIdentityKey;
            }
            // Alias is stale (cache was cleared); drop it so we can fall back to lookup.
            this.repoSnapshotAliases.delete(input.repoIdentityKey);
        }

        if (this.repoSnapshotCache.has(input.repoIdentityKey)) {
            return input.repoIdentityKey;
        }

        let bestMatchKey: string | null = null;
        let bestMatchRootLen = -1;
        for (const [candidateKey, candidateSnapshot] of this.repoSnapshotCache) {
            if (candidateKey.includes('::entries=')) {
                // Entry-shape variants are fetch-shape cache artifacts, never a
                // summary reader's snapshot; do not alias readers onto them.
                continue;
            }
            if (!candidateKey.startsWith(`${input.machineId}:`)) {
                continue;
            }
            if (!candidateSnapshot?.repo?.isRepo) {
                continue;
            }

            const normalizedRootPath = normalizeFileSystemPath(candidateSnapshot.repo.rootPath);
            if (!normalizedRootPath) {
                continue;
            }

            const isMatch =
                normalizedResolvedPath === normalizedRootPath
                || normalizedResolvedPath.startsWith(`${normalizedRootPath}/`);
            if (!isMatch) {
                continue;
            }

            if (normalizedRootPath.length > bestMatchRootLen) {
                bestMatchRootLen = normalizedRootPath.length;
                bestMatchKey =
                    candidateSnapshot.projectKey && this.repoSnapshotCache.has(candidateSnapshot.projectKey)
                        ? candidateSnapshot.projectKey
                        : candidateKey;
            }
        }

        if (bestMatchKey) {
            this.repoSnapshotAliases.set(input.repoIdentityKey, bestMatchKey);
        }

        return bestMatchKey;
    }

    private isSameOrNestedPath(path: string, candidateAncestor: string): boolean {
        const normalizedPath = normalizeFileSystemPath(path);
        const normalizedAncestor = normalizeFileSystemPath(candidateAncestor);
        if (!normalizedPath || !normalizedAncestor) return false;
        if (normalizedPath === normalizedAncestor) return true;
        if (normalizedAncestor === '/') return normalizedPath.startsWith('/');
        return normalizedPath.startsWith(`${normalizedAncestor}/`);
    }

    private isPotentialSameRepoRequest(a: RepoSnapshotRequestContext, b: RepoSnapshotRequestContext): boolean {
        if (a.machineId !== b.machineId || a.includeWorktreeStatus !== b.includeWorktreeStatus) {
            return false;
        }
        if (
            this.isSameOrNestedPath(a.resolvedPath, b.resolvedPath)
            || this.isSameOrNestedPath(b.resolvedPath, a.resolvedPath)
        ) {
            return true;
        }

        // Before the first snapshot resolves, sibling package/workspace paths under one
        // repository are not yet aliasable by repo root. Wait for one nearby in-flight
        // request to resolve, then reuse it only if its returned repo root covers this path.
        return countSharedLeadingPathSegments(a.resolvedPath, b.resolvedPath) >= 4;
    }

    private findPotentialSameRepoRequest(
        context: RepoSnapshotRequestContext,
    ): Readonly<{ key: string; promise: Promise<UiScmWorkingSnapshot | null> }> | null {
        for (const [key, promise] of this.repoSnapshotRequests.entries()) {
            const candidate = this.repoSnapshotRequestContexts.get(key);
            if (!candidate) continue;
            if (!this.isPotentialSameRepoRequest(context, candidate)) continue;
            return { key, promise };
        }
        return null;
    }

    private canReuseSnapshotForMachinePath(
        snapshot: UiScmWorkingSnapshot | null,
        context: RepoSnapshotRequestContext,
    ): boolean {
        if (!snapshot?.repo.isRepo) {
            return false;
        }
        const repoRoot = normalizeFileSystemPath(snapshot.repo.rootPath);
        if (!repoRoot) {
            return false;
        }
        return this.isSameOrNestedPath(context.resolvedPath, repoRoot);
    }

    private cacheAliasedSnapshot(
        repoIdentityKey: string,
        snapshot: UiScmWorkingSnapshot | null,
        options?: Readonly<{
            canonicalIdentityKeyOverride?: (snapshot: UiScmWorkingSnapshot | null) => string;
        }>,
    ): void {
        const canonicalIdentityKey = options?.canonicalIdentityKeyOverride
            ? options.canonicalIdentityKeyOverride(snapshot)
            : (snapshot?.projectKey ? snapshot.projectKey : repoIdentityKey);

        this.repoSnapshotCache.set(canonicalIdentityKey, snapshot);
        if (canonicalIdentityKey !== repoIdentityKey) {
            this.repoSnapshotCache.delete(repoIdentityKey);
            this.repoSnapshotAliases.set(repoIdentityKey, canonicalIdentityKey);
        }
    }

    private async fetchSnapshotForRepoIdentity(
        repoIdentityKey: string,
        loader: () => Promise<UiScmWorkingSnapshot | null>,
        options?: Readonly<{
            canonicalIdentityKeyOverride?: (snapshot: UiScmWorkingSnapshot | null) => string;
            requestContext?: RepoSnapshotRequestContext;
        }>,
    ): Promise<UiScmWorkingSnapshot | null> {
        const existingRequest = this.repoSnapshotRequests.get(repoIdentityKey);
        if (existingRequest) {
            return await existingRequest;
        }

        if (options?.requestContext) {
            const compatibleRequest = this.findPotentialSameRepoRequest(options.requestContext);
            if (compatibleRequest) {
                syncPerformanceTelemetry.count('sync.scm.snapshot.inFlightAwait', { hit: 1 });
                const snapshot = await compatibleRequest.promise;
                if (this.canReuseSnapshotForMachinePath(snapshot, options.requestContext)) {
                    syncPerformanceTelemetry.count('sync.scm.snapshot.inFlightReuse', { hit: 1 });
                    this.cacheAliasedSnapshot(repoIdentityKey, snapshot, options);
                    return snapshot;
                }
                syncPerformanceTelemetry.count('sync.scm.snapshot.inFlightReuse', { miss: 1 });
            }
        }

        const requestPromise = (async () => {
            const snapshot = await loader();
            this.cacheAliasedSnapshot(repoIdentityKey, snapshot, options);
            return snapshot;
        })();

        this.repoSnapshotRequests.set(repoIdentityKey, requestPromise);
        if (options?.requestContext) {
            this.repoSnapshotRequestContexts.set(repoIdentityKey, options.requestContext);
        }
        try {
            return await requestPromise;
        } finally {
            if (this.repoSnapshotRequests.get(repoIdentityKey) === requestPromise) {
                this.repoSnapshotRequests.delete(repoIdentityKey);
            }
            const context = this.repoSnapshotRequestContexts.get(repoIdentityKey);
            if (context === options?.requestContext) {
                this.repoSnapshotRequestContexts.delete(repoIdentityKey);
            }
        }
    }

    async fetchSnapshotForSession(sessionId: string, options?: ScmSnapshotFetchOptions): Promise<UiScmWorkingSnapshot | null> {
        const request = resolveRepoScmSessionRequest({ sessionId });
        if (!request) {
            return null;
        }

        const requestFields = buildScmStatusRequestFields(options);
        const cacheSuffix = scmStatusRequestCacheNamespaceSuffix(options);
        return await this.fetchSnapshotForRepoIdentity(`${request.repoIdentityKey}${cacheSuffix}`, async () => {
            const fetchedAt = Date.now();

            // Session SCM RPC runs within the session working directory already. Passing an absolute
            // `cwd` is both redundant and brittle (tilde paths, symlink differences, etc.) because
            // the CLI security layer resolves `cwd` relative to the working directory.
            const response = await sessionScmStatusSnapshot(sessionId, requestFields);
            const projectKey = resolveCanonicalScmProjectKey({
                fallbackProjectKey: request.repoIdentityKey,
                machineId: request.machineId,
                snapshot: readSuccessfulSnapshot(response) ?? null,
            });
            return normalizeScmSnapshotResponseOrThrow({
                response,
                projectKey,
                fetchedAt,
                emptyRootPath: null,
            });
        }, {
            // Entry-carrying fetches are response-shape artifacts of THIS request;
            // keep them under the request-shape key and never alias or canonicalize
            // them onto the bare projectKey slot summary readers read.
            ...(cacheSuffix
                ? { canonicalIdentityKeyOverride: () => `${request.repoIdentityKey}${cacheSuffix}` }
                : {}),
            requestContext: request.machineId
                ? {
                    machineId: request.machineId,
                    resolvedPath: request.resolvedPath,
                    includeWorktreeStatus: false,
                }
                : undefined,
        });
    }

    async fetchSnapshotForMachinePath(
        input: Readonly<{
            machineId: string;
            path: string;
            includeWorktreeStatus?: boolean;
        }>,
        options?: ScmSnapshotFetchOptions
    ): Promise<UiScmWorkingSnapshot | null> {
        const request = resolveRepoScmMachinePathRequest(input);
        if (!request) {
            return null;
        }
        const includeWorktreeStatus = input.includeWorktreeStatus === true;
        const requestFields = {
            cwd: request.resolvedPath,
            ...(includeWorktreeStatus ? { includeWorktreeStatus: true } : {}),
            ...buildScmStatusRequestFields(options),
        };
        const cacheSuffix = scmStatusRequestCacheNamespaceSuffix(options);
        const baseCacheKey = this.applyStatusCacheNamespace(request.repoIdentityKey, includeWorktreeStatus);
        const cacheKey = `${baseCacheKey}${cacheSuffix}`;
        return await this.fetchSnapshotForRepoIdentity(cacheKey, async () => {
            const fetchedAt = Date.now();
            const response = await machineScmStatusSnapshot(request.machineId, requestFields);
            const projectKey = resolveCanonicalScmProjectKey({
                fallbackProjectKey: request.repoIdentityKey,
                machineId: request.machineId,
                snapshot: readSuccessfulSnapshot(response) ?? null,
            });
            return normalizeScmSnapshotResponseOrThrow({
                response,
                projectKey,
                fetchedAt,
                emptyRootPath: request.resolvedPath,
            });
        }, {
            canonicalIdentityKeyOverride: (snapshot) => {
                if (cacheSuffix) {
                    return `${baseCacheKey}${cacheSuffix}`;
                }
                return includeWorktreeStatus
                    ? this.applyStatusCacheNamespace(snapshot?.projectKey || request.repoIdentityKey, true)
                    : (snapshot?.projectKey || request.repoIdentityKey);
            },
            requestContext: {
                machineId: request.machineId,
                resolvedPath: request.resolvedPath,
                includeWorktreeStatus,
            },
        });
    }

    readCachedSnapshotForMachinePath(input: Readonly<{
        machineId: string;
        path: string;
        includeWorktreeStatus?: boolean;
    }>): UiScmWorkingSnapshot | null {
        const request = resolveRepoScmMachinePathRequest(input);
        if (!request) {
            return null;
        }

        const includeWorktreeStatus = input.includeWorktreeStatus === true;
        if (includeWorktreeStatus) {
            const enrichedKey = this.applyStatusCacheNamespace(request.repoIdentityKey, true);
            const direct = this.repoSnapshotCache.get(enrichedKey);
            if (direct) return direct;
            // Also try canonical-projectKey-based enriched key by prefix-matching against the lightweight alias resolver.
            const aliasedLightweightKey =
                this.resolveCachedRepoIdentityKeyForMachinePath({
                    machineId: request.machineId,
                    resolvedPath: request.resolvedPath,
                    repoIdentityKey: request.repoIdentityKey,
                });
            if (aliasedLightweightKey) {
                const enrichedFromAliased = this.applyStatusCacheNamespace(aliasedLightweightKey, true);
                return this.repoSnapshotCache.get(enrichedFromAliased) ?? null;
            }
            return null;
        }

        const resolvedCacheKey =
            this.resolveCachedRepoIdentityKeyForMachinePath({
                machineId: request.machineId,
                resolvedPath: request.resolvedPath,
                repoIdentityKey: request.repoIdentityKey,
            })
            ?? request.repoIdentityKey;

        return this.repoSnapshotCache.get(resolvedCacheKey) ?? null;
    }

    private static readonly STATUS_ENRICHED_SUFFIX = '::status=enriched';

    private applyStatusCacheNamespace(identityKey: string, includeWorktreeStatus: boolean): string {
        if (!includeWorktreeStatus) return identityKey;
        // Suffix only the enriched namespace so legacy lightweight callers continue to use the bare identity key.
        // Idempotent: if the key already carries the enriched suffix (e.g. it was resolved via aliasing
        // through the lightweight prefix-scan, which currently returns the suffixed candidate key when
        // the canonical projectKey isn't separately present in the cache), do not double-suffix it.
        if (identityKey.endsWith(ScmRepositoryService.STATUS_ENRICHED_SUFFIX)) {
            return identityKey;
        }
        return `${identityKey}${ScmRepositoryService.STATUS_ENRICHED_SUFFIX}`;
    }

    private static readonly WORKTREES_ENRICHMENT_SUFFIX = '::worktrees-enrichment';
    private static readonly WORKTREE_ENRICHMENT_REQUEST_KEY_SEPARATOR = '\0';

    private applyWorktreesEnrichmentNamespace(identityKey: string): string {
        if (identityKey.endsWith(ScmRepositoryService.WORKTREES_ENRICHMENT_SUFFIX)) {
            return identityKey;
        }
        return `${identityKey}${ScmRepositoryService.WORKTREES_ENRICHMENT_SUFFIX}`;
    }

    private stripStatusCacheNamespace(identityKey: string): string {
        return identityKey.endsWith(ScmRepositoryService.STATUS_ENRICHED_SUFFIX)
            ? identityKey.slice(0, -ScmRepositoryService.STATUS_ENRICHED_SUFFIX.length)
            : identityKey;
    }

    private resolveWorktreesEnrichmentCacheKey(request: Readonly<{
        machineId: string;
        resolvedPath: string;
        repoIdentityKey: string;
    }>): string {
        const resolvedSnapshotKey =
            this.resolveCachedRepoIdentityKeyForMachinePath({
                machineId: request.machineId,
                resolvedPath: request.resolvedPath,
                repoIdentityKey: request.repoIdentityKey,
            })
            ?? request.repoIdentityKey;
        return this.applyWorktreesEnrichmentNamespace(
            this.stripStatusCacheNamespace(resolvedSnapshotKey),
        );
    }

    /**
     * Build a stable, deterministic projection of the requested path set. Used to
     * key the in-flight request map so identical concurrent requests dedupe but
     * different subsets can run in parallel.
     *
     * Uses a NUL character separator (cannot appear in a filesystem path) so different
     * path sets cannot collide. The separator is spelled with the `\0` escape sequence
     * via WORKTREE_ENRICHMENT_REQUEST_KEY_SEPARATOR rather than being embedded as a
     * literal NUL byte; this keeps the file ASCII-clean for tools like `file`, `rg`,
     * and editors while preserving identical runtime behavior.
     */
    private buildWorktreesEnrichmentRequestKey(
        repoIdentityKey: string,
        worktreePaths: ReadonlyArray<string>,
    ): string {
        const sorted = [...worktreePaths].sort();
        const sep = ScmRepositoryService.WORKTREE_ENRICHMENT_REQUEST_KEY_SEPARATOR;
        return `${repoIdentityKey}${sep}${sorted.join(sep)}`;
    }

    async fetchWorktreesEnrichment(input: Readonly<{
        machineId: string;
        path: string;
        worktreePaths: ReadonlyArray<string>;
    }>): Promise<ScmWorktreeEnrichmentEntry[] | null> {
        const request = resolveRepoScmMachinePathRequest({
            machineId: input.machineId,
            path: input.path,
        });
        if (!request) return null;

        const cacheKey = this.resolveWorktreesEnrichmentCacheKey(request);
        const inFlightKey = this.buildWorktreesEnrichmentRequestKey(cacheKey, input.worktreePaths);
        const existing = this.worktreesEnrichmentRequests.get(inFlightKey);
        if (existing) return await existing;

        const requestPromise = (async () => {
            try {
                const entries: ScmWorktreeEnrichmentEntry[] = [];
                for (const worktreePaths of chunkWorktreePathsForEnrichment(input.worktreePaths)) {
                    const response = await machineScmWorktreesEnrichment(request.machineId, {
                        cwd: request.resolvedPath,
                        worktreePaths: [...worktreePaths],
                    });
                    if (!response || response.success !== true || !response.worktrees) {
                        return null;
                    }
                    entries.push(...response.worktrees.map((entry) => ({ ...entry })));
                }
                // Merge per-path entries into the per-repo cache. Each entry refreshes
                // ONLY its own path; entries previously cached for other paths are
                // preserved (monotonic update semantic — F6).
                //
                // FR4-13: both caches are LruMap-bounded. Reading + re-setting on the outer
                // cache refreshes its recency so the active repo isn't evicted under load.
                let perRepoMap = this.worktreesEnrichmentCache.get(cacheKey);
                if (!perRepoMap) {
                    perRepoMap = new LruMap<string, ScmWorktreeEnrichmentEntry>({
                        maxEntries: this.maxPerRepoEnrichmentEntries,
                    });
                }
                for (const entry of entries) {
                    perRepoMap.set(entry.path, entry);
                }
                // Re-set on the outer LRU to mark this repo as MRU.
                this.worktreesEnrichmentCache.set(cacheKey, perRepoMap);
                return entries;
            } catch {
                return null;
            }
        })();

        this.worktreesEnrichmentRequests.set(inFlightKey, requestPromise);
        try {
            return await requestPromise;
        } finally {
            if (this.worktreesEnrichmentRequests.get(inFlightKey) === requestPromise) {
                this.worktreesEnrichmentRequests.delete(inFlightKey);
            }
        }
    }

    readCachedWorktreesEnrichment(input: Readonly<{
        machineId: string;
        path: string;
    }>): ScmWorktreeEnrichmentEntry[] | null {
        const request = resolveRepoScmMachinePathRequest(input);
        if (!request) return null;
        const cacheKey = this.resolveWorktreesEnrichmentCacheKey(request);
        const perRepoMap = this.worktreesEnrichmentCache.get(cacheKey);
        if (!perRepoMap || perRepoMap.size === 0) return null;
        // Return a fresh array snapshot so callers can't mutate the per-path map.
        return Array.from(perRepoMap.values()).map((entry) => ({ ...entry }));
    }

    /**
     * FR4-13 helper for tests: total number of repos currently cached. The
     * production API does not need this — eviction is bounded by the LruMap cap.
     */
    getWorktreesEnrichmentCacheSize(): number {
        return this.worktreesEnrichmentCache.size;
    }

    readCachedSnapshotForSession(sessionId: string): UiScmWorkingSnapshot | null {
        const request = resolveRepoScmSessionRequest({ sessionId });
        if (!request) {
            return null;
        }

        const resolvedCacheKey =
            request.machineId
                ? this.resolveCachedRepoIdentityKeyForMachinePath({
                    machineId: request.machineId,
                    resolvedPath: request.resolvedPath,
                    repoIdentityKey: request.repoIdentityKey,
                })
                : null;

        return this.repoSnapshotCache.get(resolvedCacheKey ?? request.repoIdentityKey) ?? null;
    }
}

export const scmRepositoryService = new ScmRepositoryService();
