import type {
    ScmStatusSnapshotResponse,
    ScmWorkingSnapshot as ProtocolScmWorkingSnapshot,
    ScmWorktreeEnrichmentEntry,
    ScmWorktreesEnrichmentRequest,
    ScmWorktreesEnrichmentResponse,
} from '@happier-dev/protocol';
import { SCM_WORKTREES_ENRICHMENT_MAX_PATHS } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { ScmCapabilities, ScmStatus, ScmWorkingSnapshot as UiScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { sessionScmStatusSnapshot } from '@/sync/ops';
import { machineScmStatusSnapshot, runMachineScmRpc } from '@/sync/ops/scm/machineScm';
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

const DEFAULT_MAX_REPO_ENRICHMENT_CACHE_ENTRIES = 32;
const DEFAULT_MAX_PER_REPO_ENRICHMENT_ENTRIES = 64;

type RepoSnapshotRequestContext = Readonly<{
    machineId: string;
    resolvedPath: string;
    includeWorktreeStatus: boolean;
}>;

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
            pullRequestStatus: snapshot.pullRequestStatus ?? null,
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
        repo: { isRepo: false, rootPath: input.rootPath ?? null, backendId: null, mode: null, worktrees: [], remotes: [] },
        capabilities: EMPTY_SCM_CAPABILITIES,
        branch: { head: null, upstream: null, ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hostingProvider: null,
        pullRequestStatus: null,
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
    const modifiedCount = snapshot.entries.filter((entry) => entry.kind !== 'untracked').length;
    const untrackedCount = snapshot.entries.filter((entry) => entry.kind === 'untracked').length;
    const includedCount = snapshot.totals.includedFiles;
    const includedLinesAdded = snapshot.totals.includedAdded;
    const includedLinesRemoved = snapshot.totals.includedRemoved;
    const pendingLinesAdded = snapshot.totals.pendingAdded;
    const pendingLinesRemoved = snapshot.totals.pendingRemoved;
    const linesAdded = includedLinesAdded + pendingLinesAdded;
    const linesRemoved = includedLinesRemoved + pendingLinesRemoved;

    return {
        branch: snapshot.branch.head,
        isDirty: snapshot.entries.length > 0,
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
        upstreamBranch: snapshot.branch.upstream,
        aheadCount: snapshot.branch.ahead,
        behindCount: snapshot.branch.behind,
        stashCount: snapshot.stashCount,
    };
}

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
    private worktreesEnrichmentCache: LruMap<string, LruMap<string, ScmWorktreeEnrichmentEntry>>;
    private worktreesEnrichmentCacheKeys = new Set<string>();
    private worktreesEnrichmentEntryKeys = new Map<string, Set<string>>();
    private readonly maxPerRepoEnrichmentEntries: number;
    private worktreesEnrichmentRequests = new Map<string, Promise<ScmWorktreeEnrichmentEntry[] | null>>();

    constructor(options?: Readonly<{
        maxAliasEntries?: number;
        maxRepoEnrichmentCacheEntries?: number;
        maxPerRepoEnrichmentEntries?: number;
    }>) {
        this.repoSnapshotAliases = new LruMap<string, string>({
            maxEntries: this.normalizeMaxAliasEntries(options?.maxAliasEntries),
        });
        this.worktreesEnrichmentCache = new LruMap<string, LruMap<string, ScmWorktreeEnrichmentEntry>>({
            maxEntries: this.normalizePositiveCount(
                options?.maxRepoEnrichmentCacheEntries,
                DEFAULT_MAX_REPO_ENRICHMENT_CACHE_ENTRIES,
            ),
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

    async fetchSnapshotForSession(sessionId: string): Promise<UiScmWorkingSnapshot | null> {
        const request = resolveRepoScmSessionRequest({ sessionId });
        if (!request) {
            return null;
        }

        return await this.fetchSnapshotForRepoIdentity(request.repoIdentityKey, async () => {
            const fetchedAt = Date.now();

            // Session SCM RPC runs within the session working directory already. Passing an absolute
            // `cwd` is both redundant and brittle (tilde paths, symlink differences, etc.) because
            // the CLI security layer resolves `cwd` relative to the working directory.
            const response = await sessionScmStatusSnapshot(sessionId, {});
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
            requestContext: request.machineId
                ? {
                    machineId: request.machineId,
                    resolvedPath: request.resolvedPath,
                    includeWorktreeStatus: false,
                }
                : undefined,
        });
    }

    async fetchSnapshotForMachinePath(input: Readonly<{
        serverId?: string | null;
        machineId: string;
        path: string;
        includeWorktreeStatus?: boolean;
    }>): Promise<UiScmWorkingSnapshot | null> {
        const request = resolveRepoScmMachinePathRequest(input);
        if (!request) {
            return null;
        }
        const includeWorktreeStatus = input.includeWorktreeStatus === true;
        const cacheNamespaceKey = this.applyStatusCacheNamespace(request.repoIdentityKey, includeWorktreeStatus);
        return await this.fetchSnapshotForRepoIdentity(cacheNamespaceKey, async () => {
            const fetchedAt = Date.now();
            const snapshotRequest = {
                cwd: request.resolvedPath,
                ...(includeWorktreeStatus ? { includeWorktreeStatus: true } : {}),
            };
            const response = input.serverId
                ? await machineScmStatusSnapshot(request.machineId, snapshotRequest, { serverId: input.serverId })
                : await machineScmStatusSnapshot(request.machineId, snapshotRequest);
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
            canonicalIdentityKeyOverride: includeWorktreeStatus
                ? (snapshot) => this.applyStatusCacheNamespace(snapshot?.projectKey ?? request.repoIdentityKey, true)
                : undefined,
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
            const aliasedLightweightKey =
                this.resolveCachedRepoIdentityKeyForMachinePath({
                    machineId: request.machineId,
                    resolvedPath: request.resolvedPath,
                    repoIdentityKey: request.repoIdentityKey,
                });
            if (aliasedLightweightKey) {
                return this.repoSnapshotCache.get(this.applyStatusCacheNamespace(aliasedLightweightKey, true)) ?? null;
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
        if (!identityKey.endsWith(ScmRepositoryService.STATUS_ENRICHED_SUFFIX)) {
            return identityKey;
        }
        return identityKey.slice(0, -ScmRepositoryService.STATUS_ENRICHED_SUFFIX.length);
    }

    private stripWorktreesEnrichmentNamespace(identityKey: string): string {
        if (!identityKey.endsWith(ScmRepositoryService.WORKTREES_ENRICHMENT_SUFFIX)) {
            return identityKey;
        }
        return identityKey.slice(0, -ScmRepositoryService.WORKTREES_ENRICHMENT_SUFFIX.length);
    }

    private resolveWorktreesEnrichmentCacheKey(input: Readonly<{
        machineId: string;
        resolvedPath: string;
        repoIdentityKey: string;
    }>): string {
        const snapshotIdentityKey =
            this.resolveCachedRepoIdentityKeyForMachinePath(input)
            ?? input.repoIdentityKey;
        return this.applyWorktreesEnrichmentNamespace(
            this.stripStatusCacheNamespace(snapshotIdentityKey),
        );
    }

    private resolveCachedWorktreesEnrichmentKeyForMachinePath(input: Readonly<{
        machineId: string;
        resolvedPath: string;
        repoIdentityKey: string;
    }>): string | null {
        const directKey = this.applyWorktreesEnrichmentNamespace(input.repoIdentityKey);
        if (this.worktreesEnrichmentCache.has(directKey)) {
            return directKey;
        }

        const normalizedResolvedPath = normalizeFileSystemPath(input.resolvedPath);
        if (!normalizedResolvedPath) {
            return null;
        }

        const machinePrefix = `${input.machineId}:`;
        let bestMatchKey: string | null = null;
        let bestMatchRootLen = -1;
        for (const candidateKey of Array.from(this.worktreesEnrichmentCacheKeys)) {
            if (!this.worktreesEnrichmentCache.has(candidateKey)) {
                this.worktreesEnrichmentCacheKeys.delete(candidateKey);
                continue;
            }
            const bareIdentityKey = this.stripWorktreesEnrichmentNamespace(candidateKey);
            if (!bareIdentityKey.startsWith(machinePrefix)) {
                continue;
            }
            const normalizedRootPath = normalizeFileSystemPath(bareIdentityKey.slice(machinePrefix.length));
            if (!normalizedRootPath) {
                continue;
            }
            const isMatch =
                normalizedResolvedPath === normalizedRootPath
                || normalizedResolvedPath.startsWith(`${normalizedRootPath}/`);
            if (isMatch && normalizedRootPath.length > bestMatchRootLen) {
                bestMatchRootLen = normalizedRootPath.length;
                bestMatchKey = candidateKey;
            }
        }

        return bestMatchKey;
    }

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
                    const response = await runMachineScmRpc<
                        ScmWorktreesEnrichmentResponse,
                        ScmWorktreesEnrichmentRequest
                    >(
                        request.machineId,
                        RPC_METHODS.SCM_WORKTREES_ENRICHMENT,
                        {
                            cwd: request.resolvedPath,
                            worktreePaths: [...worktreePaths],
                        },
                    );
                    if (!response || response.success !== true || !response.worktrees) {
                        return null;
                    }
                    entries.push(...response.worktrees.map((entry) => ({ ...entry })));
                }

                let perRepoMap = this.worktreesEnrichmentCache.get(cacheKey);
                if (!perRepoMap) {
                    perRepoMap = new LruMap<string, ScmWorktreeEnrichmentEntry>({
                        maxEntries: this.maxPerRepoEnrichmentEntries,
                    });
                }
                for (const entry of entries) {
                    perRepoMap.set(entry.path, entry);
                }
                this.worktreesEnrichmentCache.set(cacheKey, perRepoMap);
                this.worktreesEnrichmentCacheKeys.add(cacheKey);
                const entryKeys = this.worktreesEnrichmentEntryKeys.get(cacheKey) ?? new Set<string>();
                for (const entry of entries) {
                    entryKeys.add(entry.path);
                }
                this.worktreesEnrichmentEntryKeys.set(cacheKey, entryKeys);
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
        worktreePaths?: ReadonlyArray<string>;
    }>): ScmWorktreeEnrichmentEntry[] | null {
        const request = resolveRepoScmMachinePathRequest(input);
        if (!request) return null;
        const cacheKey = this.resolveCachedWorktreesEnrichmentKeyForMachinePath({
            machineId: request.machineId,
            resolvedPath: request.resolvedPath,
            repoIdentityKey: request.repoIdentityKey,
        }) ?? this.applyWorktreesEnrichmentNamespace(request.repoIdentityKey);
        const perRepoMap = this.worktreesEnrichmentCache.get(cacheKey);
        if (!perRepoMap || perRepoMap.size === 0) return null;

        const paths = input.worktreePaths;
        if (paths && paths.length > 0) {
            const entries = paths
                .map((path) => perRepoMap.get(path))
                .filter((entry): entry is ScmWorktreeEnrichmentEntry => entry !== undefined)
                .map((entry) => ({ ...entry }));
            return entries.length > 0 ? entries : null;
        }

        const entryKeys = this.worktreesEnrichmentEntryKeys.get(cacheKey);
        if (!entryKeys || entryKeys.size === 0) return null;
        const entries = Array.from(entryKeys)
            .map((path) => perRepoMap.get(path))
            .filter((entry): entry is ScmWorktreeEnrichmentEntry => entry !== undefined)
            .map((entry) => ({ ...entry }));
        return entries.length > 0 ? entries : null;
    }

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
