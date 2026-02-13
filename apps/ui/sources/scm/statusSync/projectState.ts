import type { InvalidateSync } from '@/utils/sessions/sync';
import { storage } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { resolveProjectMachineScopeId } from '@/sync/runtime/orchestration/projectManager';

import { isSessionPathWithinRepoRoot } from '../sync/paths';

export type ScmStatusSyncStateMaps = {
    projectSyncMap: Map<string, InvalidateSync>;
    projectPollTimers: Map<string, ReturnType<typeof setTimeout>>;
    projectFastPollUntil: Map<string, number>;
    projectSnapshotSignature: Map<string, string>;
    projectLastSnapshot: Map<string, ScmWorkingSnapshot | null>;
    projectLastInvalidatedBySession: Map<string, string>;
    projectLastInvalidationSource: Map<string, 'unknown' | 'mutation'>;
    projectLastInvalidatedBySessionAt: Map<string, number>;
};

export function buildSnapshotSignature(snapshot: ScmWorkingSnapshot): string {
    if (!snapshot.repo.isRepo) {
        return 'not-scm-repo';
    }

    const filesSig = snapshot.entries
        .map((entry) => [
            entry.path,
            entry.previousPath ?? '',
            entry.includeStatus,
            entry.pendingStatus,
            String(entry.hasIncludedDelta),
            String(entry.hasPendingDelta),
            String(entry.stats.includedAdded),
            String(entry.stats.includedRemoved),
            String(entry.stats.pendingAdded),
            String(entry.stats.pendingRemoved),
            String(entry.stats.isBinary),
        ].join('|'))
        .join('\n');

    return [
        snapshot.repo.rootPath ?? '',
        snapshot.branch.head ?? '',
        snapshot.branch.upstream ?? '',
        String(snapshot.branch.ahead),
        String(snapshot.branch.behind),
        String(snapshot.branch.detached),
        String(snapshot.stashCount ?? 0),
        String(snapshot.hasConflicts),
        filesSig,
    ].join('\n');
}

export async function clearSearchCacheForProject(
    sessionToProjectKey: Map<string, string>,
    projectKey: string
): Promise<void> {
    const { fileSearchCache } = await import('@/sync/domains/input/suggestionFile');
    for (const [sessionId, key] of sessionToProjectKey.entries()) {
        if (key === projectKey) {
            fileSearchCache.clearCache(sessionId);
        }
    }
}

export function getRepoScopeSessionIds(referenceSessionId: string, repoRoot: string): string[] {
    const state = storage.getState();
    const reference = state.sessions[referenceSessionId];
    const scopeId = resolveProjectMachineScopeId(reference?.metadata ?? {});
    if (!scopeId || scopeId === 'unknown') return [referenceSessionId];

    const inScope = new Set<string>();
    for (const session of Object.values(state.sessions)) {
        const sessionPath = session.metadata?.path;
        if (!sessionPath) continue;
        const sessionScopeId = resolveProjectMachineScopeId(session.metadata ?? {});
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
