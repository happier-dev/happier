import type { InvalidateSync } from '@/utils/sessions/sync';
import { storage } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { resolveProjectMachineScopeId } from '@/sync/runtime/orchestration/projectKeyIdentity';
import { readSessionWorkspaceContext } from '@/sync/domains/session/readSessionWorkspaceContext';
import { clearSuggestionFileSearchCache } from '@/sync/domains/input/suggestionFileCacheInvalidation';
import { resolveSessionFileSuggestionScope } from '@/sync/ops/resolveSessionFileSuggestionScope';

import { isSessionPathWithinRepoRoot } from '../sync/paths';

export type ScmStatusSyncStateMaps = {
    projectSyncMap: Map<string, InvalidateSync>;
    projectPollTimers: Map<string, ReturnType<typeof setTimeout>>;
    projectPollingSuspended: Set<string>;
    projectFastPollUntil: Map<string, number>;
    projectSnapshotSignature: Map<string, string>;
    projectLastSnapshot: Map<string, ScmWorkingSnapshot | null>;
    projectLastInvalidatedBySession: Map<string, string>;
    projectLastInvalidationSource: Map<string, 'unknown' | 'mutation'>;
    projectLastInvalidatedBySessionAt: Map<string, number>;
};

function stableSerialize(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'undefined';
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
    }

    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
        .join(',')}}`;
}

export function buildSnapshotSignature(snapshot: ScmWorkingSnapshot): string {
    if (!snapshot.repo.isRepo) {
        return 'not-scm-repo';
    }

    const entries = [...snapshot.entries]
        .sort((left, right) => {
            const pathOrder = left.path.localeCompare(right.path);
            if (pathOrder !== 0) return pathOrder;
            return (left.previousPath ?? '').localeCompare(right.previousPath ?? '');
        })
        .map((entry) => ({
            path: entry.path,
            previousPath: entry.previousPath,
            kind: entry.kind,
            includeStatus: entry.includeStatus,
            pendingStatus: entry.pendingStatus,
            hasIncludedDelta: entry.hasIncludedDelta,
            hasPendingDelta: entry.hasPendingDelta,
            stats: entry.stats,
        }));

    const remotes = [...(snapshot.repo.remotes ?? [])]
        .sort((left, right) => left.name.localeCompare(right.name));
    const worktrees = [...(snapshot.repo.worktrees ?? [])]
        .sort((left, right) => {
            const pathOrder = left.path.localeCompare(right.path);
            if (pathOrder !== 0) return pathOrder;
            return (left.branch ?? '').localeCompare(right.branch ?? '');
        });

    return stableSerialize({
        repo: {
            isRepo: snapshot.repo.isRepo,
            rootPath: snapshot.repo.rootPath,
            backendId: snapshot.repo.backendId ?? null,
            mode: snapshot.repo.mode ?? null,
            defaultBranch: snapshot.repo.defaultBranch ?? null,
            remotes,
            worktrees,
        },
        capabilities: snapshot.capabilities ?? null,
        branch: snapshot.branch,
        stashCount: snapshot.stashCount ?? 0,
        operationState: snapshot.operationState ?? null,
        hostingProvider: snapshot.hostingProvider ?? null,
        pullRequest: snapshot.pullRequest ?? null,
        hasConflicts: snapshot.hasConflicts,
        totals: snapshot.totals,
        entries,
    });
}

export async function clearSearchCacheForProject(
    sessionToProjectKey: Map<string, string>,
    projectKey: string
): Promise<void> {
    for (const [sessionId, key] of sessionToProjectKey.entries()) {
        if (key !== projectKey) continue;
        // The file index is keyed by machine + folder, so invalidate the FOLDER this session
        // sits in. Sessions sharing that folder share one index and are all refreshed by this
        // single clear; a session whose machine target cannot be resolved addresses no index
        // and must clear nothing rather than fall back to wiping every workspace's cache.
        const scope = resolveSessionFileSuggestionScope(sessionId);
        if (!scope) continue;
        clearSuggestionFileSearchCache(scope);
    }
}

export function getRepoScopeSessionIds(referenceSessionId: string, repoRoot: string): string[] {
    const state = storage.getState();
    const reference = state.sessions[referenceSessionId];
    const referenceWorkspaceContext = readSessionWorkspaceContext(state, referenceSessionId);
    const scopeId =
        referenceWorkspaceContext.projectMachineId
        ?? resolveProjectMachineScopeId(reference?.metadata ?? {});
    if (!scopeId || scopeId === 'unknown') return [referenceSessionId];

    const inScope = new Set<string>();
    for (const session of Object.values(state.sessions)) {
        const sessionWorkspaceContext = readSessionWorkspaceContext(state, session.id);
        const sessionPath = sessionWorkspaceContext.workspacePath;
        if (!sessionPath) continue;
        const sessionScopeId =
            sessionWorkspaceContext.projectMachineId
            ?? resolveProjectMachineScopeId(session.metadata ?? {});
        if (sessionScopeId !== scopeId) continue;
        if (!isSessionPathWithinRepoRoot(sessionPath, repoRoot)) continue;
        inScope.add(session.id);
    }

    inScope.add(referenceSessionId);
    return Array.from(inScope);
}

export function moveProjectStateKey(input: {
    fromKey: string;
    toKey: string;
    stateMaps: ScmStatusSyncStateMaps;
}): void {
    const { fromKey, toKey, stateMaps } = input;
    if (fromKey === toKey) return;

    const fromSync = stateMaps.projectSyncMap.get(fromKey);
    if (fromSync && !stateMaps.projectSyncMap.has(toKey)) {
        stateMaps.projectSyncMap.set(toKey, fromSync);
    }
    stateMaps.projectSyncMap.delete(fromKey);

    const fromTimer = stateMaps.projectPollTimers.get(fromKey);
    if (fromTimer && !stateMaps.projectPollTimers.has(toKey)) {
        stateMaps.projectPollTimers.set(toKey, fromTimer);
    }
    stateMaps.projectPollTimers.delete(fromKey);

    if (stateMaps.projectPollingSuspended.has(fromKey) && !stateMaps.projectPollingSuspended.has(toKey)) {
        stateMaps.projectPollingSuspended.add(toKey);
    }
    stateMaps.projectPollingSuspended.delete(fromKey);

    const fastUntil = stateMaps.projectFastPollUntil.get(fromKey);
    if (typeof fastUntil === 'number' && !stateMaps.projectFastPollUntil.has(toKey)) {
        stateMaps.projectFastPollUntil.set(toKey, fastUntil);
    }
    stateMaps.projectFastPollUntil.delete(fromKey);

    const signature = stateMaps.projectSnapshotSignature.get(fromKey);
    if (signature && !stateMaps.projectSnapshotSignature.has(toKey)) {
        stateMaps.projectSnapshotSignature.set(toKey, signature);
    }
    stateMaps.projectSnapshotSignature.delete(fromKey);

    const snapshot = stateMaps.projectLastSnapshot.get(fromKey);
    if (snapshot && !stateMaps.projectLastSnapshot.has(toKey)) {
        stateMaps.projectLastSnapshot.set(toKey, snapshot);
    }
    stateMaps.projectLastSnapshot.delete(fromKey);

    const actor = stateMaps.projectLastInvalidatedBySession.get(fromKey);
    if (actor && !stateMaps.projectLastInvalidatedBySession.has(toKey)) {
        stateMaps.projectLastInvalidatedBySession.set(toKey, actor);
    }
    stateMaps.projectLastInvalidatedBySession.delete(fromKey);

    const actorSource = stateMaps.projectLastInvalidationSource.get(fromKey);
    if (actorSource && !stateMaps.projectLastInvalidationSource.has(toKey)) {
        stateMaps.projectLastInvalidationSource.set(toKey, actorSource);
    }
    stateMaps.projectLastInvalidationSource.delete(fromKey);

    const actorAt = stateMaps.projectLastInvalidatedBySessionAt.get(fromKey);
    if (typeof actorAt === 'number' && !stateMaps.projectLastInvalidatedBySessionAt.has(toKey)) {
        stateMaps.projectLastInvalidatedBySessionAt.set(toKey, actorAt);
    }
    stateMaps.projectLastInvalidatedBySessionAt.delete(fromKey);
}

export function collectStaleProjectKeysAfterReassign(input: {
    sessionIds: string[];
    targetProjectKey: string;
    sessionToProjectKey: Map<string, string>;
}): string[] {
    const staleProjectKeys = new Set<string>();
    for (const sessionId of input.sessionIds) {
        const previousKey = input.sessionToProjectKey.get(sessionId);
        input.sessionToProjectKey.set(sessionId, input.targetProjectKey);
        if (!previousKey || previousKey === input.targetProjectKey) continue;

        const hasConsumers = Array.from(input.sessionToProjectKey.values()).some((value) => value === previousKey);
        if (!hasConsumers) {
            staleProjectKeys.add(previousKey);
        }
    }
    return Array.from(staleProjectKeys);
}
