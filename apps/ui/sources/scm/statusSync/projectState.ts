import type { InvalidateSync } from '@/utils/sessions/sync';
import { storage } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { resolveProjectMachineScopeId } from '@/sync/runtime/orchestration/projectManager';
import { readSessionWorkspaceContext } from '@/sync/domains/session/readSessionWorkspaceContext';
import { clearSuggestionFileSearchCache } from '@/sync/domains/input/suggestionFileCacheInvalidation';
import { clearCachedRepositoryDirectoryEntries } from '@/sync/domains/input/repositoryDirectory';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveWorkspaceTargetForSessionFromState } from '@/sync/domains/session/resolveWorkspaceTargetForSessionFromState';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { clearCachedWorkspaceRepositoryDirectoryEntries } from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';

import { isSessionPathWithinRepoRoot } from '../sync/paths';

export type ScmStatusSyncStateMaps = {
    projectSyncMap: Map<string, InvalidateSync>;
    projectPollingSuspended: Set<string>;
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
    const remotesSig = [...(snapshot.repo.remotes ?? [])]
        .map((remote) => [
            remote.name,
            remote.fetchUrl ?? '',
            remote.pushUrl ?? '',
        ].join('|'))
        .sort()
        .join('\n');

    return [
        snapshot.repo.rootPath ?? '',
        snapshot.repo.defaultBranch ?? '',
        remotesSig,
        snapshot.branch.head ?? '',
        snapshot.branch.headOid ?? '',
        snapshot.branch.upstream ?? '',
        snapshot.branch.upstreamOid ?? '',
        String(snapshot.branch.ahead),
        String(snapshot.branch.behind),
        String(snapshot.branch.detached),
        String(snapshot.stashCount ?? 0),
        String(snapshot.hasConflicts),
        snapshot.operationState?.kind ?? '',
        snapshot.operationState?.sourceRef ?? '',
        String(snapshot.operationState?.canContinue === true),
        String(snapshot.operationState?.canAbort === true),
        filesSig,
    ].join('\n');
}

/** Clears the file-search caches of a project's Sessions; an exact-Home Session clears its workspace cache. */
export async function clearSearchCacheForProject(
    sessions: ReadonlyArray<Readonly<{ sessionId: string; serverId: string | null }>>,
): Promise<void> {
    for (const { sessionId, serverId } of sessions) {
        if (serverId) {
            const target = resolveWorkspaceTargetForSessionFromState(storage.getState(), { sessionId, serverId });
            if (target) clearCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey: target.workspaceCacheKey });
        } else {
            clearSuggestionFileSearchCache(sessionId);
            clearCachedRepositoryDirectoryEntries({ sessionId });
        }
    }
}

export function readScmSessionContext(sessionId: string, serverId?: string | null) {
    const state = storage.getState();
    if (serverId) {
        const target = resolveWorkspaceTargetForSessionFromState(state, { sessionId, serverId });
        const row = readSessionListRowsForServerId(state.sessionListRowsByServerId, serverId)?.[sessionId];
        const directSession = state.sessions[sessionId];
        const metadata = row?.metadata ?? (directSession?.serverId === serverId ? readSessionOwnerMetadataView(directSession) : null);
        const machine = state.machineListByServerId?.[serverId]?.find((candidate) => candidate.id === target?.machineId);
        return {
            workspacePath: target?.rootPath ?? null,
            machineId: target?.machineId ?? null,
            homeDir: metadata?.homeDir ?? machine?.metadata?.homeDir,
        };
    }
    const context = readSessionWorkspaceContext(state, sessionId);
    const session = state.sessions[sessionId];
    const metadata = session ? readSessionOwnerMetadataView(session) : null;
    const machineId = context.projectMachineId ?? resolveProjectMachineScopeId(metadata ?? {});
    return {
        workspacePath: context.workspacePath,
        machineId,
        homeDir: metadata?.homeDir ?? state.machines?.[machineId]?.metadata?.homeDir,
    };
}

export function getRepoScopeSessionIds(referenceSessionId: string, repoRoot: string, serverId?: string | null): string[] {
    const state = storage.getState();
    const reference = readScmSessionContext(referenceSessionId, serverId);
    if (!reference.machineId || reference.machineId === 'unknown') return [referenceSessionId];
    const sessionIds = serverId
        ? new Set([
            ...Object.keys(readSessionListRowsForServerId(state.sessionListRowsByServerId, serverId) ?? {}),
            ...Object.values(state.sessions).filter((session) => session.serverId === serverId).map((session) => session.id),
        ])
        : new Set(Object.keys(state.sessions));
    const inScope = new Set<string>();
    for (const sessionId of sessionIds) {
        const context = readScmSessionContext(sessionId, serverId);
        if (!context.workspacePath || context.machineId !== reference.machineId) continue;
        if (!isSessionPathWithinRepoRoot(context.workspacePath, repoRoot, context.homeDir)) continue;
        inScope.add(sessionId);
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

    if (stateMaps.projectPollingSuspended.has(fromKey) && !stateMaps.projectPollingSuspended.has(toKey)) {
        stateMaps.projectPollingSuspended.add(toKey);
    }
    stateMaps.projectPollingSuspended.delete(fromKey);

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
