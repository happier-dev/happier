import type { ScmWorkingSnapshot as ProtocolScmWorkingSnapshot } from '@happier-dev/protocol';

import type { ScmCapabilities, ScmStatus, ScmWorkingSnapshot as UiScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { sessionScmStatusSnapshot } from '@/sync/ops';
import { machineScmStatusSnapshot } from '@/sync/ops/scm/machineScm';
import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';
import { resolveRepoScmMachinePathRequest } from '@/scm/repository/resolveRepoScmMachinePathRequest';
import { resolveRepoScmSessionRequest } from '@/scm/repository/resolveRepoScmSessionRequest';
import { LruMap } from '@/utils/cache/lruMap';
import {
    EMPTY_SCM_CAPABILITIES,
    mapProtocolSnapshotToUiSnapshot,
    mergeScmCapabilities,
} from '@/scm/core/snapshotMappers';
import { resolveCanonicalScmProjectKey } from '@/scm/core/resolveCanonicalScmProjectKey';

function isProtocolScmSnapshot(
    snapshot: UiScmWorkingSnapshot | ProtocolScmWorkingSnapshot
): snapshot is ProtocolScmWorkingSnapshot {
    const repo = (snapshot as ProtocolScmWorkingSnapshot).repo as ProtocolScmWorkingSnapshot['repo'] | undefined;
    return Boolean(repo && typeof repo === 'object' && 'isRepo' in repo);
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
            },
            capabilities,
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
    response: Awaited<ReturnType<typeof sessionScmStatusSnapshot>>;
    projectKey: string;
    fetchedAt: number;
    emptyRootPath?: string | null;
}): UiScmWorkingSnapshot {
    const { response, projectKey, fetchedAt, emptyRootPath } = input;
    if (
        !response
        || typeof response !== 'object'
        || typeof (response as { success?: unknown }).success !== 'boolean'
    ) {
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

export class ScmRepositoryService {
    private repoSnapshotRequests = new Map<string, Promise<UiScmWorkingSnapshot | null>>();
    private repoSnapshotCache = new Map<string, UiScmWorkingSnapshot | null>();
    private repoSnapshotAliases: LruMap<string, string>;

    constructor(options?: Readonly<{
        maxAliasEntries?: number;
    }>) {
        this.repoSnapshotAliases = new LruMap<string, string>({
            maxEntries: this.normalizeMaxAliasEntries(options?.maxAliasEntries),
        });
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

    private async fetchSnapshotForRepoIdentity(
        repoIdentityKey: string,
        loader: () => Promise<UiScmWorkingSnapshot | null>,
    ): Promise<UiScmWorkingSnapshot | null> {
        const existingRequest = this.repoSnapshotRequests.get(repoIdentityKey);
        if (existingRequest) {
            return await existingRequest;
        }

        const requestPromise = (async () => {
            const snapshot = await loader();
            const canonicalIdentityKey = snapshot?.projectKey ? snapshot.projectKey : repoIdentityKey;

            this.repoSnapshotCache.set(canonicalIdentityKey, snapshot);
            if (canonicalIdentityKey !== repoIdentityKey) {
                this.repoSnapshotCache.delete(repoIdentityKey);
                this.repoSnapshotAliases.set(repoIdentityKey, canonicalIdentityKey);
            }
            return snapshot;
        })();

        this.repoSnapshotRequests.set(repoIdentityKey, requestPromise);
        try {
            return await requestPromise;
        } finally {
            if (this.repoSnapshotRequests.get(repoIdentityKey) === requestPromise) {
                this.repoSnapshotRequests.delete(repoIdentityKey);
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
                snapshot:
                    response
                    && typeof response === 'object'
                    && (response as any).success === true
                        ? (response as any).snapshot
                        : null,
            });
            return normalizeScmSnapshotResponseOrThrow({
                response,
                projectKey,
                fetchedAt,
                emptyRootPath: null,
            });
        });
    }

    async fetchSnapshotForMachinePath(input: Readonly<{
        machineId: string;
        path: string;
    }>): Promise<UiScmWorkingSnapshot | null> {
        const request = resolveRepoScmMachinePathRequest(input);
        if (!request) {
            return null;
        }
        return await this.fetchSnapshotForRepoIdentity(request.repoIdentityKey, async () => {
            const fetchedAt = Date.now();
            const response = await machineScmStatusSnapshot(request.machineId, {
                cwd: request.resolvedPath,
            });
            const projectKey = resolveCanonicalScmProjectKey({
                fallbackProjectKey: request.repoIdentityKey,
                machineId: request.machineId,
                snapshot:
                    response
                    && typeof response === 'object'
                    && (response as any).success === true
                        ? (response as any).snapshot
                        : null,
            });
            return normalizeScmSnapshotResponseOrThrow({
                response,
                projectKey,
                fetchedAt,
                emptyRootPath: request.resolvedPath,
            });
        });
    }

    readCachedSnapshotForMachinePath(input: Readonly<{
        machineId: string;
        path: string;
    }>): UiScmWorkingSnapshot | null {
        const request = resolveRepoScmMachinePathRequest(input);
        if (!request) {
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
