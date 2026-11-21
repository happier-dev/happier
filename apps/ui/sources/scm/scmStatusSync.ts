/**
 * Source-control status synchronization module.
 * Provides canonical repository status tracking using ScmRepositoryService.
 */

import { storage } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { InvalidateSync } from '@/utils/sessions/sync';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { scmFallbackError } from '@/sync/ops/scm/scmRpcFailure';

import { scmRepositoryService, snapshotToScmStatus } from './scmRepositoryService';
import {
    buildSnapshotSignature,
    clearSearchCacheForProject,
    collectStaleProjectKeysAfterReassign,
    getRepoScopeSessionIds,
    moveProjectStateKey,
    readScmSessionContext,
    recordProjectInvalidationSource,
    type InvalidationSource,
    type ScmStatusSyncStateMaps,
} from './statusSync/projectState';
import { reportScmStatusSyncError } from './statusSync/errorReporting';
import { isSessionPathWithinRepoRoot } from './sync/paths';
import { areScmWorkingSnapshotsEquivalentIgnoringFetchedAt, isUnchangedCountsOfHeldList } from './sync/snapshotDiff';
import { projectManager, resolveProjectMachineScopeId, type ProjectScmSnapshotError } from '@/sync/runtime/orchestration/projectManager';
import { readSessionWorkspaceContext } from '@/sync/domains/session/readSessionWorkspaceContext';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveWorkspaceTargetForSessionFromState } from '@/sync/domains/session/resolveWorkspaceTargetForSessionFromState';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { watchMachineScmWorkspaceChanges } from '@/sync/ops/scm/machineScmWorkspaceWatch';
import type { PresentedAutoRefreshReadSource } from '@/utils/runtime/presentedAutoRefresh';
import { subscribeMachineRpcRecovery } from '@/sync/runtime/orchestration/serverScopedRpc/subscribeMachineRpcRecovery';
import { getActiveServerAccountScope, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { readCurrentServerCredentialAccountScopeLifetime } from '@/sync/domains/scope/serverCredentialAccountScope';
import type { ScmWorkspaceWatchUnavailable, ScmStatusSnapshotRequest } from '@happier-dev/protocol/scm';
import { ScmAutoRefresh, type ScmAutoRefreshDemand, type ScmAutoRefreshWatchCallbacks } from './refresh/scmAutoRefresh';
import {
    hasScmEntriesDemand,
    isSameScmEntriesDemandSlot,
    retainScmEntriesDemand,
    subscribeScmEntriesDemandAdmissions,
    subscribeScmEntriesDemandReleases,
    notifyScmEntriesUnheld,
    retainScmEntriesHold,
    readScmSnapshotCounts,
    readScmEntriesPageSize,
    type ScmEntriesDemandSlot,
} from './refresh/scmEntriesDemand';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeMachineUpdates } from '@/sync/store/domains/machines';
import { resolveSessionScmScopeFromState } from '@/sync/store/domains/managedSessionScmScope';

const DEFAULT_SCM_AUTO_REFRESH_PROJECT_MIN_INTERVAL_MS = 30_000;
const MAX_SCM_AUTO_REFRESH_PROJECT_MIN_INTERVAL_MS = 300_000;

function readScmAutoRefreshProjectMinIntervalMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SCM_AUTO_REFRESH_PROJECT_MIN_INTERVAL_MS ?? '').trim();
    if (raw === '0') return 0;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return DEFAULT_SCM_AUTO_REFRESH_PROJECT_MIN_INTERVAL_MS;
    }
    return Math.min(MAX_SCM_AUTO_REFRESH_PROJECT_MIN_INTERVAL_MS, parsed);
}

export class ScmStatusSync {
    private autoRefresh = new ScmAutoRefresh((demand) => {
        if ('sessionId' in demand) this.getSync(demand.sessionId, demand.serverId);
        const state = storage.getState();
        const scope = 'scope' in demand ? demand.scope : resolveWorkspaceTargetForSessionFromState(state, demand.serverId
            ? { sessionId: demand.sessionId, serverId: demand.serverId } : demand.sessionId);
        const snapshot = 'scope' in demand ? state.getWorkspaceScmSnapshot(demand.scope)
            : state.getSessionProjectScmSnapshot(demand.sessionId, demand.serverId);
        const workspace = scope ? { ...scope, rootPath: snapshot?.repo.rootPath ?? scope.rootPath } : null;
        const managedWorkspace = workspace?.workspace;
        const projectKey = workspace ? tryBuildWorkspaceCacheKey(workspace)
            : 'sessionId' in demand ? this.getProjectKeyForSession(demand.sessionId, demand.serverId) : null;
        if (!projectKey) return null;
        return { key: projectKey, read: async (trigger?: PresentedAutoRefreshReadSource) => {
            const workspaceRecovered = trigger === 'reconnected' || trigger === 'watch_ready' && workspace?.workspace != null;
            const source = workspaceRecovered ? 'workspace_recovery' : trigger ? 'filesystem' : undefined;
            if (workspaceRecovered || !this.projectAutoRefreshSuspended.has(projectKey)) {
                if (source) recordProjectInvalidationSource(this.projectLastInvalidationSource, projectKey, source);
                const sync = 'sessionId' in demand ? this.getSync(demand.sessionId, demand.serverId)
                    : this.getWorkspaceSync(demand.scope);
                sync.invalidateCoalesced({ rerunIfStarted: source !== undefined });
                await sync.awaitQueue();
            }
            return 'scope' in demand ? storage.getState().getWorkspaceScmSnapshot(demand.scope)
                : storage.getState().getSessionProjectScmSnapshot(demand.sessionId, demand.serverId);
        }, ...(workspace && managedWorkspace ? {
            subscribeRecovery: (recover: () => void) => {
                const readAccount = () => selectActiveServerAccountScopeForServer(getActiveServerAccountScope(), workspace.serverId)
                    ?? readCurrentServerCredentialAccountScopeLifetime(workspace.serverId)?.scope;
                const account = readAccount();
                const readRunningRuntime = () => {
                    const row = resolveServerScopedMachine(storage.getState(), workspace.serverId, workspace.machineId);
                    return row?.installationId === managedWorkspace.controller.installationId && row.daemonState?.status === 'running'
                        ? row.daemonState.runtimeId : undefined;
                };
                let runningRuntime = readRunningRuntime();
                const stopReconnect = subscribeMachineRpcRecovery({ machineId: workspace.machineId, serverId: workspace.serverId,
                    expectedAccountId: account?.accountId }, recover);
                // Presence can reconnect before the replacement controller registers its RPCs.
                // Its ready daemon-state publication can resume a watch left pending or refused on that edge.
                const stopReady = subscribeMachineUpdates((serverId, machineIds) => {
                    if (!machineIds.includes(workspace.machineId) || !areServerProfileIdentifiersEquivalent(workspace.serverId, serverId)
                        || !account || readAccount()?.accountId !== account.accountId) return;
                    const nextRuntime = readRunningRuntime();
                    if (!nextRuntime || nextRuntime === runningRuntime) return;
                    runningRuntime = nextRuntime;
                    const key = this.workspaceProjectKey(scope ?? workspace);
                    if (key && !this.autoRefresh.hasReadyWatch(key)) recover();
                });
                return () => { stopReconnect(); stopReady(); };
            },
        } : {}), ...(workspace && snapshot?.repo.isRepo && snapshot.repo.rootPath ? {
            watch: (callbacks: ScmAutoRefreshWatchCallbacks) => {
                const watch = watchMachineScmWorkspaceChanges(workspace.machineId, {
                    serverId: workspace.serverId, directory: workspace.workspace?.rootPath ?? workspace.rootPath,
                    workspace: workspace.workspace, ...callbacks,
                });
                return () => watch.dispose();
            },
            onUnavailable: (reason: ScmWorkspaceWatchUnavailable) => this.publishWorkspaceWatchFailure(workspace, projectKey, reason),
        } : {}) };
    });

    retainAutoRefresh(demand: ScmAutoRefreshDemand): () => void {
        const managed = 'scope' in demand && demand.scope.workspace;
        // Apply the incumbent repository work budget once, when visible polling demand is admitted.
        const intervalMs = managed ? 0 : demand.intervalMs > 0
            ? Math.max(demand.intervalMs, readScmAutoRefreshProjectMinIntervalMs()) : demand.intervalMs;
        const release = this.autoRefresh.retain({ ...demand, intervalMs });
        return () => {
            release();
            if ('scope' in demand) {
                const key = this.workspaceProjectKey(demand.scope);
                if (key && this.getProjectSessions(key).length === 0) this.cleanupProjectState(key);
            }
        };
    }

    // Map project keys to sync instances
    private projectSyncMap = new Map<string, InvalidateSync>();
    // Map session IDs to project keys for cleanup
    private sessionToProjectKey = new Map<string, string>();
    // Projects that should skip automatic refresh attempts until a user-initiated refresh occurs.
    private projectAutoRefreshSuspended = new Set<string>();
    // Last automatic refresh lease per project. Prevents multiple mounted views from hammering full snapshots.
    private projectLastAutoRefreshAt = new Map<string, number>();
    // Snapshot signatures per project to detect file tree changes
    private projectSnapshotSignature = new Map<string, string>();
    // Last snapshot per project to compute changed path attribution
    private projectLastSnapshot = new Map<string, ScmWorkingSnapshot | null>();
    // Source of the most recent project invalidation (a mutation refreshes even while suspended)
    private projectLastInvalidationSource = new Map<string, InvalidationSource>();
    // Page requests join the repository's existing refresh queue, including native invalidations.
    private projectEntriesRequests = new Map<string, NonNullable<ScmStatusSnapshotRequest['entriesPage']>>();

    async loadWorkspaceEntries(scope: WorkspaceScopeBase, limit: number, path?: string): Promise<void> {
        const projectKey = this.workspaceProjectKey(scope);
        const snapshot = storage.getState().getWorkspaceScmSnapshot(scope);
        if (!projectKey || !snapshot?.entriesPage || (path ? snapshot.entries.some(entry => entry.path === path)
            : snapshot.entriesPage.nextCursor === null)) return;
        const sync = this.getWorkspaceSync(scope);
        // Simultaneous scrolling consumers share the pending page, rather than reading it twice.
        if (this.projectEntriesRequests.has(projectKey)) {
            await sync.awaitQueue();
            if (path) await this.loadWorkspaceEntries(scope, limit, path);
            return;
        }
        this.projectEntriesRequests.set(projectKey, { limit, ...(path ? { path } : { cursor: snapshot.entriesPage.nextCursor! }) });
        sync.invalidateCoalesced({ rerunIfStarted: true });
        await sync.awaitQueue();
    }

    private projectEntriesPageSize(scope: WorkspaceScopeBase, projectKey: string): number | undefined {
        const slots: ScmEntriesDemandSlot[] = [{ kind: 'workspace', scope },
            ...this.getProjectSessions(projectKey).map(ref => this.readEntriesDemandSlot(ref.sessionId, ref.serverId))];
        let pageSize: number | undefined;
        for (const slot of slots) {
            if (!hasScmEntriesDemand(slot)) continue;
            const size = readScmEntriesPageSize(slot);
            if (size === undefined) return undefined;
            pageSize = Math.max(pageSize ?? 0, size);
        }
        return pageSize;
    }


    private get stateMaps(): ScmStatusSyncStateMaps {
        return {
            projectSyncMap: this.projectSyncMap,
            projectPollingSuspended: this.projectAutoRefreshSuspended,
            projectSnapshotSignature: this.projectSnapshotSignature,
            projectLastSnapshot: this.projectLastSnapshot,
            projectLastInvalidationSource: this.projectLastInvalidationSource,
        };
    }

    private getProjectKeyForSync(sync: InvalidateSync): string | null {
        for (const [projectKey, candidate] of this.projectSyncMap.entries()) {
            if (candidate === sync) return projectKey;
        }
        return null;
    }

    private shouldSkipAutoRefreshForProject(projectKey: string): boolean {
        if (this.autoRefresh.hasReadyWatch(projectKey)) return true;
        const minIntervalMs = readScmAutoRefreshProjectMinIntervalMs();
        if (minIntervalMs <= 0) return false;
        const lastAutoRefreshAt = this.projectLastAutoRefreshAt.get(projectKey);
        if (typeof lastAutoRefreshAt !== 'number') return false;
        return Date.now() - lastAutoRefreshAt < minIntervalMs;
    }

    private markAutoRefreshForProject(projectKey: string): void {
        this.projectLastAutoRefreshAt.set(projectKey, Date.now());
    }

    private workspaceProjectKey(scope: WorkspaceScopeBase): string | null {
        const snapshot = storage.getState().getWorkspaceScmSnapshot(scope);
        return tryBuildWorkspaceCacheKey({ ...scope, rootPath: snapshot?.repo.rootPath ?? scope.rootPath });
    }

    private publishWorkspaceWatchFailure(scope: WorkspaceScopeBase, projectKey: string, reason: ScmWorkspaceWatchUnavailable): void {
        // An older daemon lacks observation, not SCM reads. Keep its ordinary Git refresh path.
        if (isRpcMethodNotFoundResult({ errorCode: reason.code })) return;
        this.publishWorkspaceFailure(scope, projectKey, reason);
    }

    private readWorkspaceWatchFailure(scope: WorkspaceScopeBase, projectKey: string): ProjectScmSnapshotError | null {
        const reason = this.autoRefresh.getUnavailable(projectKey);
        if (!reason || isRpcMethodNotFoundResult({ errorCode: reason.code })) return null;
        return this.projectWorkspaceFailure(scope, reason);
    }

    private projectWorkspaceFailure(scope: WorkspaceScopeBase, reason: ScmWorkspaceWatchUnavailable,
        actionErrorCode = reason.code): ProjectScmSnapshotError {
        const stopped = scope.workspace !== undefined && actionErrorCode === 'managed_power_required';
        return {
            message: reason.message, at: Date.now(),
            errorCode: stopped ? actionErrorCode : reason.code,
            ...(stopped ? { nextAction: { kind: 'start_workspace' } } : {}),
        };
    }

    private publishWorkspaceFailure(scope: WorkspaceScopeBase, projectKey: string, reason: ScmWorkspaceWatchUnavailable,
        actionErrorCode?: string): void {
        const state = storage.getState();
        const error = this.projectWorkspaceFailure(scope, reason, actionErrorCode);
        state.updateWorkspaceScmSnapshotError(scope, error);
        for (const { sessionId, serverId } of this.getProjectSessions(projectKey)) {
            state.updateSessionProjectScmSnapshotError(sessionId, error, serverId);
        }
    }

    /** Session and Project refreshes join this same workspace queue. */
    getWorkspaceSync(scope: WorkspaceScopeBase): InvalidateSync {
        const projectKey = this.workspaceProjectKey(scope);
        if (!projectKey) return new InvalidateSync(async () => {});
        let sync = this.projectSyncMap.get(projectKey);
        if (!sync) {
            let created!: InvalidateSync;
            created = new InvalidateSync(() => {
                const key = this.getProjectKeyForSync(created) ?? projectKey;
                return this.refreshWorkspace(scope, this.projectLastInvalidationSource.get(key) ?? 'unknown', key);
            });
            sync = created;
            this.projectSyncMap.set(projectKey, sync);
        }
        return sync;
    }

    private async refreshWorkspace(scope: WorkspaceScopeBase, source: InvalidationSource, projectKey: string): Promise<void> {
        this.projectLastInvalidationSource.delete(projectKey);
        const state = storage.getState();
        if (source === 'unknown' && this.projectAutoRefreshSuspended.has(projectKey)) return;
        let activeKey = projectKey;
        // The queue can originate in a nested Session directory before discovering its repo root.
        const demandScope = { ...scope, rootPath: state.getWorkspaceScmSnapshot(scope)?.repo.rootPath ?? scope.rootPath };
        const requestedList = hasScmEntriesDemand({ kind: 'workspace', scope: demandScope }) || this.projectNeedsEntries(projectKey);
        const pageSize = this.projectEntriesPageSize(demandScope, projectKey);
        const previousPage = state.getWorkspaceScmSnapshot(scope);
        const pendingPage = this.projectEntriesRequests.get(projectKey);
        const requestedPage: ScmStatusSnapshotRequest['entriesPage'] = requestedList && pageSize !== undefined
            ? source === 'unknown' && pendingPage && previousPage?.entriesPage && (pendingPage.path || pendingPage.cursor === previousPage.entriesPage.nextCursor)
                ? pendingPage : { limit: Math.max(pageSize, previousPage?.entriesPage
                    ? previousPage.entriesPage.nextCursor ?? previousPage.entriesPage.totalFiles : 0) }
            : undefined;
        const requestOptions = requestedList ? requestedPage ? { entriesPage: requestedPage } : undefined : { detail: 'summary' as const };
        const recovering = source === 'workspace_recovery';
        if (recovering) projectManager.setWorkspaceScmRecoveryInFlight(scope, true);
        try {
            // A managed watch can become ready after Files' initial read was refused. Republish
            // directory demand on that edge as well as on reconnect, independent of Git's result.
            if (recovering) await clearSearchCacheForProject(this.getProjectSessions(projectKey), scope, 'recovery');
            // Legacy unscoped Sessions retain their existing Session/Machine routing and branch observation.
            // Exact-Home Sessions and Project use the incumbent addressed Machine read.
            const legacy = this.getProjectSessions(projectKey).find(ref => ref.serverId === null);
            const response = legacy
                ? await scmRepositoryService.fetchSnapshotForSession(legacy.sessionId, requestOptions)
                : await scmRepositoryService.fetchSnapshotForMachinePath({
                    serverId: scope.serverId, machineId: scope.machineId, path: scope.rootPath,
                    ...(scope.workspace ? { workspace: scope.workspace } : {}),
                    ...requestOptions,
                });
            const append = requestedPage && (requestedPage.path || requestedPage.cursor !== undefined);
            const snapshot = response?.entriesPage && append && previousPage?.entriesPage
                ? { ...response, entries: [...new Map([...previousPage.entries, ...response.entries].map(entry => [entry.path, entry])).values()],
                    entriesPage: { ...response.entriesPage, nextCursor: requestedPage.path
                        ? previousPage.entriesPage.nextCursor : response.entriesPage.nextCursor } }
                : response;
            const canonicalScope = snapshot?.repo.isRepo && snapshot.repo.rootPath
                ? { ...scope, rootPath: snapshot.repo.rootPath } : scope;
            activeKey = tryBuildWorkspaceCacheKey(canonicalScope) ?? projectKey;
            if (activeKey !== projectKey) {
                moveProjectStateKey({ fromKey: projectKey, toKey: activeKey, stateMaps: this.stateMaps });
                const lastAutoRefreshAt = this.projectLastAutoRefreshAt.get(projectKey);
                if (lastAutoRefreshAt !== undefined && !this.projectLastAutoRefreshAt.has(activeKey)) this.projectLastAutoRefreshAt.set(activeKey, lastAutoRefreshAt);
                this.projectLastAutoRefreshAt.delete(projectKey);
                for (const [sessionKey, key] of this.sessionToProjectKey) {
                    if (key === projectKey) this.sessionToProjectKey.set(sessionKey, activeKey);
                }
            }
            if (!snapshot) {
                state.updateWorkspaceScmStatus(scope, null);
                state.updateWorkspaceScmSnapshot(scope, null);
                state.pruneWorkspaceScmCommitSelectionPaths(scope, new Set());
                return;
            }
            const previousSnapshot = this.projectLastSnapshot.get(activeKey) ?? state.getWorkspaceScmSnapshot(scope);
            const settledError = this.readWorkspaceWatchFailure(scope, activeKey);
            const publication = recovering || source === 'filesystem'
                ? { contentChanged: true, recovered: recovering && settledError === null } : undefined;
            const unchangedHeldList = isUnchangedCountsOfHeldList(previousSnapshot, snapshot);
            const snapshotChanged = publication !== undefined || !unchangedHeldList
                && !areScmWorkingSnapshotsEquivalentIgnoringFetchedAt(previousSnapshot, snapshot);
            const refs = new Map(this.getProjectSessions(activeKey).map(ref => [this.getSessionSyncKey(ref.sessionId, ref.serverId), ref]));
            if (snapshot.repo.isRepo && snapshot.repo.rootPath) {
                for (const ref of [...refs.values()]) {
                    for (const sessionId of getRepoScopeSessionIds(ref.sessionId, snapshot.repo.rootPath, ref.serverId ?? undefined)) {
                        const key = this.getSessionSyncKey(sessionId, ref.serverId);
                        refs.set(key, { sessionId, serverId: ref.serverId });
                        this.sessionToProjectKey.set(key, activeKey);
                    }
                }
            }
            // A successful read settles the error to the watch's unavailability, if any, in one publication.
            const status = snapshot.repo.isRepo ? snapshotToScmStatus(snapshot) : null;
            const publications = [...refs.values()]
                .filter(ref => snapshotChanged || !state.getSessionProjectScmSnapshot(ref.sessionId, ref.serverId))
                .map(ref => ({ ...ref, snapshot, status, options: publication }));
            if (publications.length > 0) state.publishSessionProjectScmSnapshots(publications);
            for (const target of canonicalScope.rootPath === scope.rootPath ? [scope] : [scope, canonicalScope]) {
                if (snapshotChanged || !state.getWorkspaceScmSnapshot(target)) {
                    state.updateWorkspaceScmSnapshot(target, snapshot, publication);
                    state.updateWorkspaceScmStatus(target, status);
                    if (!snapshot.detail && (!snapshot.entriesPage || snapshot.entriesPage.nextCursor === null)) {
                        const paths = new Set(snapshot.entries.map(entry => entry.path));
                        state.pruneWorkspaceScmCommitSelectionPaths(target, paths);
                        state.pruneWorkspaceScmCommitSelectionPatches(target, paths);
                    }
                }
                state.updateWorkspaceScmSnapshotError(target, settledError);
            }
            for (const ref of refs.values()) state.updateSessionProjectScmSnapshotError(ref.sessionId, settledError, ref.serverId);
            const previousSignature = this.projectSnapshotSignature.get(activeKey)
                ?? (previousSnapshot ? buildSnapshotSignature(previousSnapshot) : undefined);
            const signature = unchangedHeldList && previousSignature !== undefined
                ? previousSignature : buildSnapshotSignature(snapshot);
            // The first observed checkout is a baseline; only a changed checkout invalidates its file listing.
            const signatureChanged = previousSignature !== undefined && signature !== previousSignature;
            if (snapshotChanged) this.projectLastSnapshot.set(activeKey, snapshot);
            this.projectSnapshotSignature.set(activeKey, signature);
            if (requestedList) {
                notifyScmEntriesUnheld({ kind: 'workspace', scope });
                for (const ref of refs.values()) notifyScmEntriesUnheld(this.readEntriesDemandSlot(ref.sessionId, ref.serverId));
                const currentPageSize = this.projectEntriesPageSize(canonicalScope, activeKey);
                if (snapshot.entriesPage?.nextCursor != null && (currentPageSize === undefined
                    || snapshot.entries.length < currentPageSize)) {
                    // A full or larger reader can arrive while this page is in flight.
                    this.getWorkspaceSync(canonicalScope).invalidateCoalesced({ rerunIfStarted: true });
                }
            } else if (hasScmEntriesDemand({ kind: 'workspace', scope: canonicalScope }) || this.projectNeedsEntries(activeKey)) {
                // A list can mount while this summary is in flight, before admission
                // has a published snapshot to upgrade. Finish through the same queue.
                this.getWorkspaceSync(canonicalScope).invalidateCoalesced({ rerunIfStarted: true });
            }
            if (signatureChanged && source !== 'workspace_recovery') await clearSearchCacheForProject([...refs.values()], canonicalScope);
        } catch (error) {
            const failure = scmFallbackError(error, { method: RPC_METHODS.SCM_STATUS_SNAPSHOT, request: {} });
            this.publishWorkspaceFailure(scope, activeKey, { code: failure.errorCode, message: failure.error }, failure.actionErrorCode);
            if (failure.errorCode === SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED) this.projectAutoRefreshSuspended.add(activeKey);
            reportScmStatusSyncError({ projectKey: activeKey, error });
        } finally {
            if (recovering) projectManager.setWorkspaceScmRecoveryInFlight(scope, false);
            if (pendingPage && this.projectEntriesRequests.get(projectKey) === pendingPage) this.projectEntriesRequests.delete(projectKey);
            this.autoRefresh.reconcile(projectKey);
            if (activeKey !== projectKey) this.autoRefresh.reconcile(activeKey);
        }
    }

    private getCachedSnapshotForSessionProject(
        sessionId: string,
        projectKey: string,
        serverId?: string | null,
    ): { projectKey: string; snapshot: ScmWorkingSnapshot } | null {
        const directSnapshot = this.projectLastSnapshot.get(projectKey);
        if (directSnapshot) {
            return { projectKey, snapshot: directSnapshot };
        }

        const context = readScmSessionContext(sessionId, serverId);
        const sessionPath = context.workspacePath;
        const scopeId = context.machineId;
        if (!sessionPath || !scopeId || scopeId === 'unknown') {
            return null;
        }
        const homeDir = context.homeDir;
        const prefix = serverId ? `${serverId}:${scopeId}:` : `${scopeId}:`;

        for (const [candidateProjectKey, candidateSnapshot] of this.projectLastSnapshot.entries()) {
            if (!candidateSnapshot?.repo.isRepo) continue;
            const repoRoot = candidateSnapshot.repo.rootPath;
            if (!repoRoot) continue;
            if (!candidateProjectKey.startsWith(prefix)) continue;
            if (!isSessionPathWithinRepoRoot(sessionPath, repoRoot, homeDir)) continue;
            return { projectKey: candidateProjectKey, snapshot: candidateSnapshot };
        }

        return null;
    }

    private publishSnapshotToSession(
        state: ReturnType<typeof storage.getState>,
        sessionId: string,
        snapshot: ScmWorkingSnapshot,
        serverId?: string | null,
    ): void {
        this.publishSnapshotToSessions(state, [sessionId], snapshot, serverId);
    }

    private publishSnapshotToSessions(
        state: ReturnType<typeof storage.getState>,
        sessionIds: readonly string[],
        snapshot: ScmWorkingSnapshot,
        serverId?: string | null,
    ): void {
        if (sessionIds.length === 0) return;
        const status = snapshot.repo.isRepo ? snapshotToScmStatus(snapshot) : null;
        state.publishSessionProjectScmSnapshots(sessionIds.map((sessionId) => ({
            sessionId,
            ...(serverId ? { serverId } : {}),
            snapshot,
            status,
        })));
    }

    private hydrateSessionFromCachedProjectSnapshot(
        sessionId: string,
        snapshot: ScmWorkingSnapshot,
        serverId?: string | null,
    ): void {
        const state = storage.getState();
        if (state.getSessionProjectScmSnapshot(sessionId, serverId)) return;
        this.publishSnapshotToSession(state, sessionId, snapshot, serverId);
    }

    /**
     * Get project key string for a session
     */
    private getSessionSyncKey(sessionId: string, serverId?: string | null): string {
        const exactServerId = serverId?.trim();
        return exactServerId ? `${exactServerId}\u0000${sessionId}` : sessionId;
    }

    /** Every mapped Session, decoded from its sync key (see getSessionSyncKey). */
    private getMappedSessions(): Array<{ sessionId: string; serverId: string | null }> {
        return Array.from(this.sessionToProjectKey.keys(), (sessionSyncKey) => {
            const separator = sessionSyncKey.indexOf('\u0000');
            return separator < 0
                ? { sessionId: sessionSyncKey, serverId: null }
                : { sessionId: sessionSyncKey.slice(separator + 1), serverId: sessionSyncKey.slice(0, separator) };
        });
    }

    /** The Sessions mapped to a project, decoded from their sync keys (see getSessionSyncKey). */
    private getProjectSessions(projectKey: string): Array<{ sessionId: string; serverId: string | null }> {
        const sessions: Array<{ sessionId: string; serverId: string | null }> = [];
        for (const [sessionSyncKey, key] of this.sessionToProjectKey.entries()) {
            if (key !== projectKey) continue;
            const separator = sessionSyncKey.indexOf('\u0000');
            sessions.push(separator < 0
                ? { sessionId: sessionSyncKey, serverId: null }
                : { sessionId: sessionSyncKey.slice(separator + 1), serverId: sessionSyncKey.slice(0, separator) });
        }
        return sessions;
    }

    private getProjectKeyForSession(sessionId: string, serverId?: string | null): string | null {
        const sessionSyncKey = this.getSessionSyncKey(sessionId, serverId);
        const mapped = this.sessionToProjectKey.get(sessionSyncKey);
        if (mapped) {
            return mapped;
        }
        const state = storage.getState();
        const exactServerId = serverId?.trim();
        const scope = resolveWorkspaceTargetForSessionFromState(state, exactServerId ? { sessionId, serverId: exactServerId } : sessionId);
        if (scope) return this.workspaceProjectKey(scope);
        if (exactServerId) return null;
        const session = state.sessions[sessionId];
        if (!session) {
            return null;
        }
        const workspaceContext = readSessionWorkspaceContext(state, sessionId);
        if (!workspaceContext.workspacePath) {
            return null;
        }
        const machineScopeId = workspaceContext.projectMachineId
            ?? resolveProjectMachineScopeId(readSessionOwnerMetadataView(session) ?? {});
        return `${machineScopeId}:${workspaceContext.workspacePath}`;
    }

    /**
     * Get or create source-control status sync for a session (creates project-based sync)
     */
    getSync(sessionId: string, serverId?: string | null): InvalidateSync {
        const exactServerId = serverId?.trim();
        const sessionSyncKey = this.getSessionSyncKey(sessionId, exactServerId);
        let projectKey = this.getProjectKeyForSession(sessionId, exactServerId);
        if (!projectKey) {
            // Return a no-op sync if no valid project
            return new InvalidateSync(async () => {});
        }

        const scope = resolveWorkspaceTargetForSessionFromState(storage.getState(), exactServerId ? { sessionId, serverId: exactServerId } : sessionId);
        const cachedProjectSnapshot = this.getCachedSnapshotForSessionProject(sessionId, projectKey, scope?.serverId ?? exactServerId);
        if (cachedProjectSnapshot) {
            projectKey = cachedProjectSnapshot.projectKey;
        }

        // Map session to project key
        const previousProjectKey = this.sessionToProjectKey.get(sessionSyncKey);
        this.sessionToProjectKey.set(sessionSyncKey, projectKey);
        if (previousProjectKey && previousProjectKey !== projectKey
            && !Array.from(this.sessionToProjectKey.values()).includes(previousProjectKey)) this.cleanupProjectState(previousProjectKey);
        if (cachedProjectSnapshot) {
            this.hydrateSessionFromCachedProjectSnapshot(sessionId, cachedProjectSnapshot.snapshot, exactServerId);
        }

        if (scope) return this.getWorkspaceSync({ ...scope, rootPath: cachedProjectSnapshot?.snapshot.repo.rootPath ?? scope.rootPath });

        let sync = this.projectSyncMap.get(projectKey);
        if (!sync) {
            let createdSync!: InvalidateSync;
            createdSync = new InvalidateSync(() => {
                const currentProjectKey = this.getProjectKeyForSync(createdSync) ?? projectKey;
                return this.fetchScmStatusForProject(currentProjectKey);
            });
            sync = createdSync;
            this.projectSyncMap.set(projectKey, sync);
        }

        return sync;
    }

    /**
     * A mounted list consumer (Git/Review pane, file lists) of this Session's repository. While any
     * is held the repository refreshes with its changed-file list; otherwise with the shared counts.
     * A summary already published is upgraded once, at admission.
     */
    retainEntriesDemand(sessionId: string, serverId?: string | null): () => void {
        return retainScmEntriesDemand(this.readEntriesDemandSlot(sessionId, serverId?.trim() || null));
    }

    /**
     * A mounted list consumer holds its slot through this owner, so the owner's admission and release
     * listeners exist before the consumer needs them, even where nothing else has loaded this module.
     */
    retainEntriesHold(slot: ScmEntriesDemandSlot): () => void {
        return retainScmEntriesHold(slot);
    }

    /** The store slot a Session's snapshot lives in: its workspace scope, or the legacy Session slot. */
    private readEntriesDemandSlot(sessionId: string, serverId: string | null): ScmEntriesDemandSlot {
        const scope = resolveSessionScmScopeFromState(storage.getState(), sessionId, serverId);
        return scope ? { kind: 'workspace', scope } : { kind: 'session', sessionId };
    }

    /**
     * A slot's first list consumer upgrades the summary already published there, once. The returned
     * unsubscribe ends this owner's listening (the app singleton never does; isolated test owners may).
     */
    readonly stopEntriesDemandAdmissions = subscribeScmEntriesDemandAdmissions((slot) => {
        if (slot.kind === 'workspace') {
            const snapshot = storage.getState().getWorkspaceScmSnapshot(slot.scope);
            const pageSize = readScmEntriesPageSize(slot);
            if (snapshot?.detail || snapshot?.entriesPage?.nextCursor != null
                && (pageSize === undefined || snapshot.entries.length < pageSize)) this.getWorkspaceSync(slot.scope).invalidateCoalesced();
            return;
        }
        for (const { sessionId, serverId } of this.getMappedSessions()) {
            if (!isSameScmEntriesDemandSlot(slot, this.readEntriesDemandSlot(sessionId, serverId))) continue;
            if (!storage.getState().getSessionProjectScmSnapshot(sessionId, serverId)?.detail) return;
            // Coalesces with a refresh the consumer's own mount already queued.
            this.getSync(sessionId, serverId).invalidateCoalesced();
            return;
        }
    });

    /**
     * The last consumer of a slot closed: the slot keeps its counts and drops its rows until a
     * consumer mounts again (the admission above, or the workspace controller, re-reads).
     */
    readonly stopEntriesDemandReleases = subscribeScmEntriesDemandReleases((slot) => {
        const state = storage.getState();
        const snapshot = slot.kind === 'workspace' ? state.getWorkspaceScmSnapshot(slot.scope)
            : state.getSessionProjectScmSnapshot(slot.sessionId);
        if (!snapshot) return;
        scmRepositoryService.releaseProjectEntries(snapshot.projectKey);
        for (const [projectKey, last] of this.projectLastSnapshot) {
            if (last?.projectKey === snapshot.projectKey && !last.detail) this.projectLastSnapshot.set(projectKey, readScmSnapshotCounts(last));
        }
        if (snapshot.detail || snapshot.entries.length === 0) return;
        const released = readScmSnapshotCounts(snapshot);
        if (slot.kind === 'workspace') state.updateWorkspaceScmSnapshot(slot.scope, released);
        else state.updateSessionProjectScmSnapshot(slot.sessionId, released);
    });

    /** The project's snapshot slot has a presented list consumer (see `scmEntriesDemand`). */
    private projectNeedsEntries(projectKey: string): boolean {
        return this.getProjectSessions(projectKey).some(({ sessionId, serverId }) =>
            hasScmEntriesDemand(this.readEntriesDemandSlot(sessionId, serverId)));
    }

    /**
     * Invalidate source-control status for a session (triggers refresh for the entire project)
     */
    invalidate(sessionId: string): void {
        this.invalidateFromAutoRefresh(sessionId);
    }

    invalidateFromAutoRefresh(sessionId: string, serverId?: string | null): void {
        const exactServerId = serverId?.trim();
        if (exactServerId) {
            const projectKey = this.getProjectKeyForSession(sessionId, exactServerId);
            if (!projectKey || this.projectAutoRefreshSuspended.has(projectKey)) return;
            if (this.shouldSkipAutoRefreshForProject(projectKey)) return;
            this.markAutoRefreshForProject(projectKey);
            this.getSync(sessionId, exactServerId).invalidate();
            return;
        }
        const projectKey = this.getProjectKeyForSession(sessionId);
        if (!projectKey) return;
        if (this.projectAutoRefreshSuspended.has(projectKey)) {
            return;
        }
        if (this.shouldSkipAutoRefreshForProject(projectKey)) {
            return;
        }
        this.markAutoRefreshForProject(projectKey);
        this.invalidateWithSource(sessionId, 'unknown');
    }

    async invalidateFromAutoRefreshAndAwait(sessionId: string, serverId?: string | null): Promise<void> {
        const exactServerId = serverId?.trim();
        if (exactServerId) {
            const projectKey = this.getProjectKeyForSession(sessionId, exactServerId);
            if (!projectKey || this.projectAutoRefreshSuspended.has(projectKey)) return;
            if (this.shouldSkipAutoRefreshForProject(projectKey)) return;
            this.markAutoRefreshForProject(projectKey);
            return await this.getSync(sessionId, exactServerId).invalidateAndAwait();
        }
        const projectKey = this.getProjectKeyForSession(sessionId);
        if (!projectKey) return;
        if (this.projectAutoRefreshSuspended.has(projectKey)) {
            return;
        }
        if (this.shouldSkipAutoRefreshForProject(projectKey)) {
            return;
        }
        this.markAutoRefreshForProject(projectKey);
        const sync = this.getSync(sessionId);
        await sync.invalidateAndAwait();
    }

    invalidateFromUser(sessionId: string, serverId?: string | null): void {
        const exactServerId = serverId?.trim();
        if (exactServerId) {
            const projectKey = this.getProjectKeyForSession(sessionId, exactServerId);
            if (!projectKey) return;
            this.projectAutoRefreshSuspended.delete(projectKey);
            this.getSync(sessionId, exactServerId).invalidate();
            return;
        }
        const projectKey = this.getProjectKeyForSession(sessionId);
        if (!projectKey) return;
        this.projectAutoRefreshSuspended.delete(projectKey);
        this.invalidateWithSource(sessionId, 'unknown');
    }

    async invalidateFromUserAndAwait(target: string | WorkspaceScopeBase, serverId?: string | null): Promise<void> {
        const projectKey = typeof target === 'string' ? this.getProjectKeyForSession(target, serverId) : this.workspaceProjectKey(target);
        if (!projectKey) return;
        this.projectAutoRefreshSuspended.delete(projectKey);
        const sync = typeof target === 'string' ? this.getSync(target, serverId) : this.getWorkspaceSync(target);
        if (typeof target === 'string') await sync.invalidateAndAwait();
        else {
            sync.invalidateCoalesced();
            await sync.awaitQueue();
        }
    }

    invalidateFromMutation(sessionId: string, serverId?: string | null): void {
        const exactServerId = serverId?.trim();
        if (exactServerId) {
            const projectKey = this.getProjectKeyForSession(sessionId, exactServerId);
            if (!projectKey || this.projectAutoRefreshSuspended.has(projectKey)) return;
            recordProjectInvalidationSource(this.projectLastInvalidationSource, projectKey, 'mutation');
            this.getSync(sessionId, exactServerId).invalidate();
            return;
        }
        const projectKey = this.getProjectKeyForSession(sessionId);
        if (!projectKey) return;
        if (this.projectAutoRefreshSuspended.has(projectKey)) {
            return;
        }
        this.invalidateWithSource(sessionId, 'mutation');
    }

    async invalidateFromMutationAndAwait(sessionId: string, serverId?: string | null): Promise<void> {
        const exactServerId = serverId?.trim();
        if (exactServerId) {
            const projectKey = this.getProjectKeyForSession(sessionId, exactServerId);
            if (!projectKey || this.projectAutoRefreshSuspended.has(projectKey)) return;
            recordProjectInvalidationSource(this.projectLastInvalidationSource, projectKey, 'mutation');
            return await this.getSync(sessionId, exactServerId).invalidateAndAwait();
        }
        const projectKey = this.getProjectKeyForSession(sessionId);
        if (!projectKey) return;
        if (this.projectAutoRefreshSuspended.has(projectKey)) {
            return;
        }

        recordProjectInvalidationSource(this.projectLastInvalidationSource, projectKey, 'mutation');
        const sync = this.getSync(sessionId);
        await sync.invalidateAndAwait();
    }

    /**
     * Stop source-control status sync for a session
     */
    stop(sessionId: string, serverId?: string | null): void {
        const sessionSyncKey = this.getSessionSyncKey(sessionId, serverId);
        const projectKey = this.sessionToProjectKey.get(sessionSyncKey);
        if (!projectKey) return;

        this.sessionToProjectKey.delete(sessionSyncKey);

        // Only stop the project sync if no other sessions are using it.
        const hasOtherSessions = Array.from(this.sessionToProjectKey.values()).includes(projectKey);
        if (hasOtherSessions) return;

        this.cleanupProjectState(projectKey);
    }

    /**
     * Clear source-control status for a session when it's deleted.
     * Similar to stop() but also clears any stored repository status.
     *
     * `serverId` is the deleted carrier's Home. Live registrations are mixed: most
     * callers pass the exact Home (`serverId\u0000sessionId`), a few still register
     * bare, so both keys are stopped. Omitting it clears only the bare key, which is
     * correct only when the caller genuinely has no Home in hand.
     */
    clearForSession(sessionId: string, serverId?: string | null): void {
        const state = storage.getState();
        const exactServerId = serverId?.trim();
        if (exactServerId) this.stop(sessionId, exactServerId);
        this.stop(sessionId);
        state.applyScmStatus(sessionId, null);
        state.updateSessionProjectScmSnapshot(sessionId, null);
        state.updateSessionProjectScmSnapshotError(sessionId, null);
    }

    private cleanupProjectState(projectKey: string): void {
        if (this.autoRefresh.hasDemand(projectKey)) return;
        const sync = this.projectSyncMap.get(projectKey);
        if (sync) {
            sync.stop();
            this.projectSyncMap.delete(projectKey);
        }

        this.projectAutoRefreshSuspended.delete(projectKey);
        this.projectLastAutoRefreshAt.delete(projectKey);
        this.projectSnapshotSignature.delete(projectKey);
        this.projectLastSnapshot.delete(projectKey);
        this.projectLastInvalidationSource.delete(projectKey);
        this.projectEntriesRequests.delete(projectKey);
    }

    private getAnySessionForProject(projectKey: string, serverId?: string): string | null {
        for (const { sessionId, serverId: home } of this.getProjectSessions(projectKey)) {
            if ((home ?? undefined) !== serverId) continue;
            if (readScmSessionContext(sessionId, serverId).workspacePath) {
                return sessionId;
            }
        }
        return null;
    }

    /**
     * Fetch source-control status for a project using any session in that project.
     */
    private async fetchScmStatusForProject(projectKey: string): Promise<void> {
        const sessionId = this.getAnySessionForProject(projectKey);
        if (!sessionId) return;

        let scheduledProjectKey = projectKey;
        try {
            const state = storage.getState();
            const requestedList = this.projectNeedsEntries(projectKey);
            const snapshot = await scmRepositoryService.fetchSnapshotForSession(sessionId,
                requestedList ? undefined : { detail: 'summary' });
            let activeProjectKey = projectKey;
            let scopeSessionIds = [sessionId];

            if (!snapshot) {
                state.applyScmStatus(sessionId, null);
                state.updateSessionProjectScmSnapshot(sessionId, null);
                state.pruneSessionProjectScmCommitSelectionPaths(sessionId, new Set());
                return;
            }

            const sessionWorkspaceContext = readSessionWorkspaceContext(state, sessionId);
            const session = state.sessions[sessionId];
            const scopeId =
                sessionWorkspaceContext.projectMachineId
                ?? resolveProjectMachineScopeId(
                    session ? readSessionOwnerMetadataView(session) ?? {} : {},
                );
            const repoRoot = snapshot.repo.rootPath;
            if (snapshot.repo.isRepo && scopeId !== 'unknown' && repoRoot) {
                activeProjectKey = `${scopeId}:${repoRoot}`;
                scopeSessionIds = getRepoScopeSessionIds(sessionId, repoRoot);
                if (activeProjectKey !== projectKey) {
                    moveProjectStateKey({
                        fromKey: projectKey,
                        toKey: activeProjectKey,
                        stateMaps: this.stateMaps,
                    });
                    const lastAutoRefreshAt = this.projectLastAutoRefreshAt.get(projectKey);
                    if (typeof lastAutoRefreshAt === 'number' && !this.projectLastAutoRefreshAt.has(activeProjectKey)) {
                        this.projectLastAutoRefreshAt.set(activeProjectKey, lastAutoRefreshAt);
                    }
                    this.projectLastAutoRefreshAt.delete(projectKey);
                }

                const staleProjectKeys = collectStaleProjectKeysAfterReassign({
                    sessionIds: scopeSessionIds,
                    targetProjectKey: activeProjectKey,
                    sessionToProjectKey: this.sessionToProjectKey,
                });
                for (const staleKey of staleProjectKeys) {
                    this.cleanupProjectState(staleKey);
                }
            }
            scheduledProjectKey = activeProjectKey;

            const previousSnapshot = this.projectLastSnapshot.get(activeProjectKey) ?? null;
            this.projectLastInvalidationSource.delete(activeProjectKey);
            this.projectLastInvalidationSource.delete(projectKey);

            const signature = buildSnapshotSignature(snapshot);
            const previousSignature = this.projectSnapshotSignature.get(activeProjectKey);
            const signatureChanged = signature !== previousSignature;
            const snapshotChanged = !isUnchangedCountsOfHeldList(previousSnapshot, snapshot)
                && !areScmWorkingSnapshotsEquivalentIgnoringFetchedAt(previousSnapshot, snapshot);
            const scopedSessionIdsMissingSnapshot = snapshotChanged
                ? []
                : scopeSessionIds.filter((scopedSessionId) => state.getSessionProjectScmSnapshot(scopedSessionId) == null);
            const publishSessionIds = snapshotChanged ? scopeSessionIds : scopedSessionIdsMissingSnapshot;

            if (signatureChanged) {
                this.projectSnapshotSignature.set(activeProjectKey, signature);
            }

            if (publishSessionIds.length > 0) {
                this.publishSnapshotToSessions(state, publishSessionIds, snapshot);
            } else {
                // No observable SCM changes; avoid churn. Still clear a previous error if present.
                for (const scopedSessionId of scopeSessionIds) {
                    if (state.getSessionProjectScmSnapshotError(scopedSessionId)) {
                        state.updateSessionProjectScmSnapshotError(scopedSessionId, null);
                    }
                }
            }

            if (snapshotChanged) this.projectLastSnapshot.set(activeProjectKey, snapshot);
            if (requestedList) notifyScmEntriesUnheld(this.readEntriesDemandSlot(sessionId, null));
            else if (this.projectNeedsEntries(activeProjectKey)) {
                this.getSync(sessionId).invalidateCoalesced({ rerunIfStarted: true });
            }
            if (signatureChanged) {
                await clearSearchCacheForProject(this.getProjectSessions(activeProjectKey));
            }
        } catch (error) {
            const failure = scmFallbackError(error, { method: RPC_METHODS.SCM_STATUS_SNAPSHOT, request: {} });
            const now = Date.now();
            storage.getState().updateSessionProjectScmSnapshotError(sessionId, {
                message: failure.error,
                at: now,
                errorCode: failure.errorCode,
            });
            if (failure.errorCode === SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED) {
                this.projectAutoRefreshSuspended.add(scheduledProjectKey);
            }
            reportScmStatusSyncError({ projectKey, error });
        }
    }

    private invalidateWithSource(sessionId: string, source: InvalidationSource): void {
        const projectKey = this.getProjectKeyForSession(sessionId);
        if (!projectKey) return;

        recordProjectInvalidationSource(this.projectLastInvalidationSource, projectKey, source);
        this.getSync(sessionId).invalidate();
    }
}

// Global singleton instance
export const scmStatusSync = new ScmStatusSync();
