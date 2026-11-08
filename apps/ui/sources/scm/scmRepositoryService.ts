import type {
    ScmWorktreeEnrichmentEntry,
    ScmWorktreesEnrichmentRequest,
    ScmWorktreesEnrichmentResponse,
} from '@happier-dev/protocol/scm';
import type { ScmSnapshotDetail } from '@happier-dev/protocol/scm';
import type {
    ScmStatusSnapshotTransportResponse as ScmStatusSnapshotResponse,
    ScmStatusSnapshotRequest,
    ScmWorkingSnapshotInput as ProtocolScmWorkingSnapshot,
} from '@happier-dev/protocol/scm';
import { SCM_WORKTREES_ENRICHMENT_MAX_PATHS } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { ScmCapabilities, ScmStatus, ScmWorkingSnapshot as UiScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { sessionScmStatusSnapshot } from '@/sync/ops/sessionScm';
import { machineScmStatusSnapshot, runMachineScmRpc } from '@/sync/ops/scm/machineScm';
import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { resolveRepoScmMachinePathRequest } from '@/scm/repository/resolveRepoScmMachinePathRequest';
import { resolveRepoScmSessionRequest } from '@/scm/repository/resolveRepoScmSessionRequest';
import { LruMap } from '@/utils/cache/lruMap';
import { selectScmChangedFileCount, selectScmSnapshotLineTotals } from '@/scm/scmStatusFiles';
import {
    EMPTY_SCM_CAPABILITIES,
    mapProtocolSnapshotToUiSnapshot,
    mergeScmCapabilities,
} from '@/scm/core/snapshotMappers';
import { resolveCanonicalScmProjectKey } from '@/scm/core/resolveCanonicalScmProjectKey';
import { storage } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readMachineControlTargetForSession, type SessionMachineControlTarget } from '@/sync/ops/sessionMachineTarget';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { isSessionAccessOwner } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { applyObservedSessionBranch } from '@/sync/domains/session/metadata/sessionBranchObservation';
import { normalizeLocalPathForComparison } from '@/utils/path/resolvePathRelativeToRoot';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { sync } from '@/sync/sync';
import { log } from '@/log';
import { readScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import { readCurrentProjectAccountRows } from '@/sync/domains/workspaces/projectAccountRows';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { isSessionPathWithinRepoRoot } from '@/scm/sync/paths';

const DEFAULT_MAX_REPO_ENRICHMENT_CACHE_ENTRIES = 32;
const DEFAULT_MAX_PER_REPO_ENRICHMENT_ENTRIES = 64;

type RepoSnapshotRequestContext = Readonly<{
    repoIdentityPrefix: string;
    machineId: string;
    resolvedPath: string;
    includeWorktreeStatus: boolean;
    /** Delivery level; a richer read answers a poorer one, never the reverse. */
    detail: ScmSnapshotDetail | null;
}>;

/** facts ⊂ summary ⊂ full (the changed-file list). */
function scmSnapshotDetailRank(detail: ScmSnapshotDetail | null | undefined): number {
    return detail === 'facts' ? 0 : detail === 'summary' ? 1 : 2;
}

/** Retain facts only after a real demanded SCM read, on an already accepted exact checkout. */
async function retainObservedWorkspaceRepositoryIdentity(input: Readonly<{
    lifetime: ActiveServerAccountScopeLifetime | null;
    scope: WorkspaceScopeBase;
    snapshot: UiScmWorkingSnapshot;
}>): Promise<void> {
    const { lifetime, scope, snapshot } = input;
    if (!lifetime?.isCurrent() || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, scope.serverId)) return;
    if (!snapshot.repo.isRepo || !snapshot.repo.rootPath || !isSessionPathWithinRepoRoot(scope.rootPath, snapshot.repo.rootPath)) return;
    const state = storage.getState();
    const rows = readCurrentProjectAccountRows(state);
    if (!rows || !areServerAccountScopesEqual(state.settingsScope, lifetime.scope) || !areServerAccountScopesEqual(rows.scope, lifetime.scope)) return;
    const resolved = resolveWorkspaceRefByScope(rows.workspaceRefs, scope);
    if (resolved.kind !== 'resolved' || resolved.ref.repositoryIdentity) return;
    const identity = readScmHostingRepositoryIdentity(snapshot.hostingProvider);
    if (!identity) return;
    try {
        if (!lifetime.isCurrent()) return;
        await sync.recordObservedWorkspaceRepositoryIdentity(workspaceAddressFromRefV1(resolved.ref), identity, lifetime.scope);
    } catch {
        // The observed snapshot remains usable. A later ordinary SCM demand may
        // retry this optional projection; no navigation write or background retry.
        log.log('SCM repository observation could not enrich the accepted checkout');
    }
}

/** Publishes only a real observation made by this already-demanded Session request. */
async function publishObservedSessionBranch(input: Readonly<{
    sessionId: string;
    lifetime: ActiveServerAccountScopeLifetime | null;
    target: SessionMachineControlTarget | null;
    snapshot: UiScmWorkingSnapshot;
}>): Promise<void> {
    const { lifetime, target, snapshot, sessionId } = input;
    if (!lifetime || !target || !snapshot.repo.isRepo || !snapshot.repo.rootPath) return;
    const identity = { sessionId, serverId: lifetime.scope.serverId, accountId: lifetime.scope.accountId };
    const isCurrent = (): boolean => {
        if (!lifetime.isCurrent()) return false;
        const session = storage.getState().sessions[sessionId];
        if (!session || !isSessionAccessOwner(session.access, session.accessLevel)
            || (session.serverId && !areServerProfileIdentifiersEquivalent(session.serverId, identity.serverId))
            || !readSessionOwnerMetadataView(session)) return false;
        const currentTarget = readMachineControlTargetForSession(identity);
        return currentTarget !== null && currentTarget.machineId === target.machineId
            && normalizeLocalPathForComparison(currentTarget.basePath) === normalizeLocalPathForComparison(target.basePath);
    };
    if (!isCurrent()) return;
    const metadata = readSessionOwnerMetadataView(storage.getState().sessions[sessionId]!);
    if (!metadata) return;
    const observation = { machineId: target.machineId, path: resolveAbsolutePath(target.basePath, metadata.homeDir),
        rootPath: snapshot.repo.rootPath, branch: snapshot.branch };
    // Equal or unavailable observations do not enter the writer: no mutation read, write or retry.
    if (applyObservedSessionBranch(metadata, observation) === metadata) return;
    try {
        await sync.patchSessionMetadataWithRetry(sessionId,
            current => isCurrent() ? applyObservedSessionBranch(current, observation) : current,
            { serverId: identity.serverId, accountLifetime: lifetime, shouldContinue: isCurrent });
    } catch {
        // SCM remains usable if its optional last-observed projection cannot be committed.
        // The next ordinary demand can publish again; there is no background retry/poll.
        log.log('SCM branch observation could not update Session owner metadata');
    }
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
        const err = new Error(message) as Error & { scmErrorCode?: string; diagnosticDetail?: string };
        if (typeof (response as { errorCode?: unknown }).errorCode === 'string') {
            err.scmErrorCode = (response as { errorCode?: string }).errorCode;
        }
        // UI transport failures already logged their original exception at the failure point.
        const detail = (response as { diagnosticDetail?: unknown }).diagnosticDetail;
        if (typeof detail === 'string') err.diagnosticDetail = detail;
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
    const changedFileCount = selectScmChangedFileCount(snapshot);
    const includedCount = snapshot.totals.includedFiles;
    const totals = selectScmSnapshotLineTotals(snapshot);
    const includedLinesAdded = totals.includedAdded;
    const includedLinesRemoved = totals.includedRemoved;
    const pendingLinesAdded = totals.pendingAdded;
    const pendingLinesRemoved = totals.pendingRemoved;
    const linesAdded = includedLinesAdded + pendingLinesAdded;
    const linesRemoved = includedLinesRemoved + pendingLinesRemoved;

    return {
        branch: snapshot.branch.head,
        isDirty: changedFileCount > 0,
        changedFileCount,
        includedCount,
        lastUpdatedAt: snapshot.fetchedAt,
        includedLinesAdded,
        includedLinesRemoved,
        pendingLinesAdded,
        pendingLinesRemoved,
        linesAdded,
        linesRemoved,
        linesChanged: linesAdded + linesRemoved,
        ...(snapshot.totals.isComplete === undefined ? {} : { isComplete: snapshot.totals.isComplete }),
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

    /** No consumer holds this project's changed-file list: the next list reader reads it again. */
    releaseProjectEntries(projectKey: string): void {
        for (const [key, cached] of this.repoSnapshotCache) {
            if (cached?.projectKey === projectKey && !cached.detail) this.repoSnapshotCache.delete(key);
        }
    }
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
        repoIdentityPrefix: string;
        machineId: string;
        resolvedPath: string;
        repoIdentityKey: string;
        /** Resolve among reads of exactly this level (each level keeps its own namespace). */
        detail?: ScmSnapshotDetail | null;
    }>): string | null {
        const detail = input.detail ?? null;
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
        const repoIdentityPrefix = `${input.repoIdentityPrefix}:`;
        for (const [candidateKey, candidateSnapshot] of this.repoSnapshotCache) {
            if (!candidateKey.startsWith(repoIdentityPrefix)) {
                continue;
            }
            if (!candidateSnapshot?.repo?.isRepo) {
                continue;
            }
            // A poorer read never answers a reader of the changed files, and each level keeps its namespace.
            if ((candidateSnapshot.detail ?? null) !== detail) {
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
                    detail === null && candidateSnapshot.projectKey && this.repoSnapshotCache.has(candidateSnapshot.projectKey)
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
        if (
            a.repoIdentityPrefix !== b.repoIdentityPrefix
            || a.machineId !== b.machineId
            || a.includeWorktreeStatus !== b.includeWorktreeStatus
            || scmSnapshotDetailRank(b.detail) < scmSnapshotDetailRank(a.detail)
        ) {
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
            cache?: boolean;
            canonicalIdentityKeyOverride?: (snapshot: UiScmWorkingSnapshot | null) => string;
            requestContext?: RepoSnapshotRequestContext;
        }>,
    ): Promise<UiScmWorkingSnapshot | null> {
        // Page publication/append belongs to status sync. Pages neither satisfy a full-list
        // read nor accumulate in this repository cache or its in-flight identity namespace.
        if (options?.cache === false) return await loader();
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

    async fetchSnapshotForSession(
        sessionId: string,
        options?: Readonly<{ detail?: ScmSnapshotDetail; entriesPage?: ScmStatusSnapshotRequest['entriesPage'] }>,
    ): Promise<UiScmWorkingSnapshot | null> {
        const request = resolveRepoScmSessionRequest({ sessionId });
        if (!request) {
            return null;
        }
        const detail = options?.detail ?? null;

        return await this.fetchSnapshotForRepoIdentity(this.applyDetailCacheNamespace(request.repoIdentityKey, detail), async () => {
            const fetchedAt = Date.now();
            const lifetime = captureActiveServerAccountScopeLifetime();
            const heldSession = storage.getState().sessions[sessionId];
            const heldOwnerMetadata = heldSession && isSessionAccessOwner(heldSession.access, heldSession.accessLevel)
                ? readSessionOwnerMetadataView(heldSession) : null;
            const target = lifetime && heldOwnerMetadata ? readMachineControlTargetForSession({
                sessionId, serverId: lifetime.scope.serverId, accountId: lifetime.scope.accountId,
            }) : null;

            // Session SCM RPC runs within the session working directory already. Passing an absolute
            // `cwd` is both redundant and brittle (tilde paths, symlink differences, etc.) because
            // the CLI security layer resolves `cwd` relative to the working directory.
            const response = await sessionScmStatusSnapshot(sessionId, {
                ...(detail ? { detail } : {}),
                ...(options?.entriesPage ? { entriesPage: options.entriesPage } : {}),
            });
            const projectKey = resolveCanonicalScmProjectKey({
                fallbackProjectKey: request.repoIdentityKey,
                machineId: request.machineId,
                snapshot: readSuccessfulSnapshot(response) ?? null,
            });
            const snapshot = normalizeScmSnapshotResponseOrThrow({
                response,
                projectKey,
                fetchedAt,
                emptyRootPath: null,
            });
            await publishObservedSessionBranch({ sessionId, lifetime, target, snapshot });
            if (target && lifetime) await retainObservedWorkspaceRepositoryIdentity({ lifetime, snapshot,
                scope: { serverId: lifetime.scope.serverId, machineId: target.machineId, rootPath: request.resolvedPath } });
            return snapshot;
        }, {
            cache: !options?.entriesPage,
            // A poorer read keeps its own namespace under the canonical repo identity.
            ...(detail ? { canonicalIdentityKeyOverride: (snapshot: UiScmWorkingSnapshot | null) =>
                this.applyDetailCacheNamespace(snapshot?.projectKey || request.repoIdentityKey, detail) } : {}),
            requestContext: request.machineId
                ? {
                    repoIdentityPrefix: request.machineId,
                    machineId: request.machineId,
                    resolvedPath: request.resolvedPath,
                    includeWorktreeStatus: false,
                    detail,
                }
                : undefined,
        });
    }

    async fetchSnapshotForMachinePath(input: Readonly<{
        serverId?: string | null;
        machineId: string;
        path: string;
        homeDir?: string | null;
        includeWorktreeStatus?: boolean;
        /** Absent: the full changed-file list. 'summary': counts only. 'facts': root, branch, worktrees. */
        detail?: ScmSnapshotDetail;
        entriesPage?: ScmStatusSnapshotRequest['entriesPage'];
    }>): Promise<UiScmWorkingSnapshot | null> {
        const request = resolveRepoScmMachinePathRequest(input);
        if (!request) {
            return null;
        }
        const includeWorktreeStatus = input.includeWorktreeStatus === true;
        const detail = input.detail ?? null;
        const cacheNamespaceKey = this.applyDetailCacheNamespace(
            this.applyStatusCacheNamespace(request.repoIdentityKey, includeWorktreeStatus), detail);
        return await this.fetchSnapshotForRepoIdentity(cacheNamespaceKey, async () => {
            const fetchedAt = Date.now();
            const lifetime = captureActiveServerAccountScopeLifetime();
            const snapshotRequest = {
                cwd: request.resolvedPath,
                ...(includeWorktreeStatus ? { includeWorktreeStatus: true } : {}),
                ...(detail ? { detail } : {}),
                ...(input.entriesPage ? { entriesPage: input.entriesPage } : {}),
            };
            const serverId = typeof input.serverId === 'string' ? input.serverId.trim() : '';
            const response = serverId
                ? await machineScmStatusSnapshot(request.machineId, snapshotRequest, { serverId })
                : await machineScmStatusSnapshot(request.machineId, snapshotRequest);
            const projectKey = resolveCanonicalScmProjectKey({
                fallbackProjectKey: `${request.machineId}:${request.resolvedPath}`,
                machineId: request.machineId,
                snapshot: readSuccessfulSnapshot(response) ?? null,
            });
            const snapshot = normalizeScmSnapshotResponseOrThrow({
                response,
                projectKey,
                fetchedAt,
                emptyRootPath: request.resolvedPath,
            });
            if (lifetime) await retainObservedWorkspaceRepositoryIdentity({ lifetime, snapshot,
                scope: { serverId: serverId || lifetime.scope.serverId, machineId: request.machineId, rootPath: request.resolvedPath } });
            return snapshot;
        }, {
            cache: !input.entriesPage,
            canonicalIdentityKeyOverride: (snapshot) => {
                const snapshotRootPath = normalizeFileSystemPath(snapshot?.repo.rootPath);
                const scopedIdentityKey = snapshotRootPath
                    ? `${request.repoIdentityPrefix}:${snapshotRootPath}`
                    : request.repoIdentityKey;
                return this.applyDetailCacheNamespace(
                    this.applyStatusCacheNamespace(scopedIdentityKey, includeWorktreeStatus), detail);
            },
            requestContext: {
                repoIdentityPrefix: request.repoIdentityPrefix,
                machineId: request.machineId,
                resolvedPath: request.resolvedPath,
                includeWorktreeStatus,
                detail,
            },
        });
    }

    readCachedSnapshotForMachinePath(input: Readonly<{
        serverId?: string | null;
        machineId: string;
        path: string;
        homeDir?: string | null;
        includeWorktreeStatus?: boolean;
        /** A poorer reader ('summary', 'facts') is answered by the richest cached level first. */
        detail?: ScmSnapshotDetail;
    }>): UiScmWorkingSnapshot | null {
        const request = resolveRepoScmMachinePathRequest(input);
        if (!request) {
            return null;
        }
        if (input.detail) {
            const { detail: requested, ...fullInput } = input;
            const full = this.readCachedSnapshotForMachinePath(fullInput);
            if (full) return full;
            for (const level of (requested === 'facts' ? ['summary', 'facts'] : ['summary']) as ScmSnapshotDetail[]) {
                const levelKey = this.applyDetailCacheNamespace(
                    this.applyStatusCacheNamespace(request.repoIdentityKey, input.includeWorktreeStatus === true), level);
                const resolvedKey = this.resolveCachedRepoIdentityKeyForMachinePath({
                    repoIdentityPrefix: request.repoIdentityPrefix,
                    machineId: request.machineId,
                    resolvedPath: request.resolvedPath,
                    repoIdentityKey: levelKey,
                    detail: level,
                }) ?? levelKey;
                const cached = this.repoSnapshotCache.get(resolvedKey);
                if (cached) return cached;
            }
            return null;
        }

        const includeWorktreeStatus = input.includeWorktreeStatus === true;
        if (includeWorktreeStatus) {
            const enrichedKey = this.applyStatusCacheNamespace(request.repoIdentityKey, true);
            const direct = this.repoSnapshotCache.get(enrichedKey);
            if (direct) return direct;
            const aliasedLightweightKey =
                this.resolveCachedRepoIdentityKeyForMachinePath({
                    repoIdentityPrefix: request.repoIdentityPrefix,
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
                repoIdentityPrefix: request.repoIdentityPrefix,
                machineId: request.machineId,
                resolvedPath: request.resolvedPath,
                repoIdentityKey: request.repoIdentityKey,
            })
            ?? request.repoIdentityKey;

        return this.repoSnapshotCache.get(resolvedCacheKey) ?? null;
    }

    private static readonly STATUS_ENRICHED_SUFFIX = '::status=enriched';
    private static detailSuffix(detail: ScmSnapshotDetail): string {
        return `::detail=${detail}`;
    }

    private applyDetailCacheNamespace(identityKey: string, detail: ScmSnapshotDetail | null): string {
        if (!detail || identityKey.endsWith(ScmRepositoryService.detailSuffix(detail))) return identityKey;
        return `${identityKey}${ScmRepositoryService.detailSuffix(detail)}`;
    }

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
        repoIdentityPrefix: string;
        machineId: string;
        resolvedPath: string;
        repoIdentityKey: string;
    }>): string {
        // A summary or facts read resolves the same canonical repo root as a full one.
        const poorerIdentityKey = (['summary', 'facts'] as const).map((detail) => {
            const key = this.resolveCachedRepoIdentityKeyForMachinePath({
                ...input, repoIdentityKey: this.applyDetailCacheNamespace(input.repoIdentityKey, detail), detail,
            });
            return key ? key.slice(0, -ScmRepositoryService.detailSuffix(detail).length) : null;
        }).find((key) => key !== null) ?? null;
        const snapshotIdentityKey =
            this.resolveCachedRepoIdentityKeyForMachinePath(input)
            ?? poorerIdentityKey
            ?? input.repoIdentityKey;
        return this.applyWorktreesEnrichmentNamespace(
            this.stripStatusCacheNamespace(snapshotIdentityKey),
        );
    }

    private resolveCachedWorktreesEnrichmentKeyForMachinePath(input: Readonly<{
        repoIdentityPrefix: string;
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

        const machinePrefix = `${input.repoIdentityPrefix}:`;
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
        serverId?: string | null;
        machineId: string;
        path: string;
        homeDir?: string | null;
        worktreePaths: ReadonlyArray<string>;
    }>): Promise<ScmWorktreeEnrichmentEntry[] | null> {
        const request = resolveRepoScmMachinePathRequest(input);
        if (!request) return null;

        const cacheKey = this.resolveWorktreesEnrichmentCacheKey(request);
        const inFlightKey = this.buildWorktreesEnrichmentRequestKey(cacheKey, input.worktreePaths);
        const existing = this.worktreesEnrichmentRequests.get(inFlightKey);
        if (existing) return await existing;

        const requestPromise = (async () => {
            try {
                const entries: ScmWorktreeEnrichmentEntry[] = [];
                for (const worktreePaths of chunkWorktreePathsForEnrichment(input.worktreePaths)) {
                    const enrichmentRequest = {
                        cwd: request.resolvedPath,
                        worktreePaths: [...worktreePaths],
                    };
                    const serverId = typeof input.serverId === 'string' ? input.serverId.trim() : '';
                    const response = serverId
                        ? await runMachineScmRpc<
                            ScmWorktreesEnrichmentResponse,
                            ScmWorktreesEnrichmentRequest
                        >(
                            request.machineId,
                            RPC_METHODS.SCM_WORKTREES_ENRICHMENT,
                            enrichmentRequest,
                            { serverId },
                        )
                        : await runMachineScmRpc<
                            ScmWorktreesEnrichmentResponse,
                            ScmWorktreesEnrichmentRequest
                        >(
                            request.machineId,
                            RPC_METHODS.SCM_WORKTREES_ENRICHMENT,
                            enrichmentRequest,
                        );
                    if (!response || !('success' in response) || response.success !== true || !response.worktrees) {
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
        serverId?: string | null;
        machineId: string;
        path: string;
        homeDir?: string | null;
        worktreePaths?: ReadonlyArray<string>;
    }>): ScmWorktreeEnrichmentEntry[] | null {
        const request = resolveRepoScmMachinePathRequest(input);
        if (!request) return null;
        const cacheKey = this.resolveCachedWorktreesEnrichmentKeyForMachinePath({
            repoIdentityPrefix: request.repoIdentityPrefix,
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
                    repoIdentityPrefix: request.machineId,
                    machineId: request.machineId,
                    resolvedPath: request.resolvedPath,
                    repoIdentityKey: request.repoIdentityKey,
                })
                : null;

        return this.repoSnapshotCache.get(resolvedCacheKey ?? request.repoIdentityKey) ?? null;
    }
}

export const scmRepositoryService = new ScmRepositoryService();
