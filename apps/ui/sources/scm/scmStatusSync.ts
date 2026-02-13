/**
 * Source-control status synchronization module.
 * Provides canonical repository status tracking using ScmRepositoryService.
 */

import { AppState, type AppStateStatus } from 'react-native';

import { storage } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { InvalidateSync } from '@/utils/sessions/sync';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { scmRepositoryService, snapshotToScmStatus } from './scmRepositoryService';
import {
    buildSnapshotSignature,
    clearSearchCacheForProject,
    collectStaleProjectKeysAfterReassign,
    getRepoScopeSessionIds,
    moveProjectStateKey,
    type ScmStatusSyncStateMaps,
} from './statusSync/projectState';
import { reportScmStatusSyncError } from './statusSync/errorReporting';
import { ATTRIBUTION_INVALIDATION_WINDOW_MS, shouldAttributeChangedPaths } from './sync/attribution';
import { isSessionPathWithinRepoRoot } from './sync/paths';
import { collectChangedPaths } from './sync/snapshotDiff';
import { resolveProjectMachineScopeId } from '@/sync/runtime/orchestration/projectManager';

type InvalidationSource = 'unknown' | 'mutation';

export { ATTRIBUTION_INVALIDATION_WINDOW_MS, shouldAttributeChangedPaths } from './sync/attribution';
export { isSessionPathWithinRepoRoot } from './sync/paths';
export { collectChangedPaths } from './sync/snapshotDiff';

export class ScmStatusSync {
    private static readonly FAST_POLL_MS = 2_000;
    private static readonly IDLE_POLL_MS = 8_000;
    private static readonly FAST_POLL_WINDOW_MS = ATTRIBUTION_INVALIDATION_WINDOW_MS;

    // Map project keys to sync instances
    private projectSyncMap = new Map<string, InvalidateSync>();
    // Map session IDs to project keys for cleanup
    private sessionToProjectKey = new Map<string, string>();
	    // Poll timers per project
	    private projectPollTimers = new Map<string, ReturnType<typeof setTimeout>>();
        // Projects that should not schedule background polls (for example: daemon capability missing)
        private projectPollingSuspended = new Set<string>();
    // Fast poll window per project
    private projectFastPollUntil = new Map<string, number>();
    // Snapshot signatures per project to detect file tree changes
    private projectSnapshotSignature = new Map<string, string>();
    // Last snapshot per project to compute changed path attribution
    private projectLastSnapshot = new Map<string, ScmWorkingSnapshot | null>();
    // Session that most recently invalidated a project (best-effort attribution source)
    private projectLastInvalidatedBySession = new Map<string, string>();
    // Source for the most recent project invalidation actor
    private projectLastInvalidationSource = new Map<string, InvalidationSource>();
    // Timestamp for last invalidation actor record to prevent stale attribution
    private projectLastInvalidatedBySessionAt = new Map<string, number>();
    // Current app state used to pause polling when app is not visible
    private appState: AppStateStatus = AppState.currentState;

    constructor() {
        AppState.addEventListener('change', this.handleAppStateChange);
    }

	    private get stateMaps(): ScmStatusSyncStateMaps {
	        return {
	            projectSyncMap: this.projectSyncMap,
	            projectPollTimers: this.projectPollTimers,
                projectPollingSuspended: this.projectPollingSuspended,
	            projectFastPollUntil: this.projectFastPollUntil,
	            projectSnapshotSignature: this.projectSnapshotSignature,
	            projectLastSnapshot: this.projectLastSnapshot,
	            projectLastInvalidatedBySession: this.projectLastInvalidatedBySession,
	            projectLastInvalidationSource: this.projectLastInvalidationSource,
	            projectLastInvalidatedBySessionAt: this.projectLastInvalidatedBySessionAt,
	        };
	    }

    /**
     * Get project key string for a session
     */
    private getProjectKeyForSession(sessionId: string): string | null {
        const mapped = this.sessionToProjectKey.get(sessionId);
        if (mapped) {
            return mapped;
        }
        const session = storage.getState().sessions[sessionId];
        if (!session?.metadata?.path) {
            return null;
        }
        return `${resolveProjectMachineScopeId(session.metadata)}:${session.metadata.path}`;
    }

    private handleAppStateChange = (nextState: AppStateStatus) => {
        const wasActive = this.appState === 'active';
        this.appState = nextState;

        if (nextState !== 'active') {
            for (const timer of this.projectPollTimers.values()) {
                clearTimeout(timer);
            }
            this.projectPollTimers.clear();
            return;
        }

        if (!wasActive) {
            const now = Date.now();
            for (const projectKey of this.projectSyncMap.keys()) {
                this.projectFastPollUntil.set(projectKey, now + ScmStatusSync.FAST_POLL_WINDOW_MS);
                this.invalidateProject(projectKey);
            }
        }
    };

    /**
     * Get or create source-control status sync for a session (creates project-based sync)
     */
    getSync(sessionId: string): InvalidateSync {
        const projectKey = this.getProjectKeyForSession(sessionId);
        if (!projectKey) {
            // Return a no-op sync if no valid project
            return new InvalidateSync(async () => {});
        }

        // Map session to project key
        this.sessionToProjectKey.set(sessionId, projectKey);

        let sync = this.projectSyncMap.get(projectKey);
        if (!sync) {
            sync = new InvalidateSync(() => this.fetchScmStatusForProject(projectKey));
            this.projectSyncMap.set(projectKey, sync);
        }

        this.scheduleProjectPoll(projectKey);
        return sync;
    }

    /**
     * Invalidate source-control status for a session (triggers refresh for the entire project)
     */
    invalidate(sessionId: string): void {
        this.invalidateWithSource(sessionId, 'unknown');
    }

    invalidateFromMutation(sessionId: string): void {
        this.invalidateWithSource(sessionId, 'mutation');
    }

    async invalidateFromMutationAndAwait(sessionId: string): Promise<void> {
        const projectKey = this.getProjectKeyForSession(sessionId);
        if (!projectKey) return;

        this.projectLastInvalidatedBySession.set(projectKey, sessionId);
        this.projectLastInvalidationSource.set(projectKey, 'mutation');
        const now = Date.now();
        this.projectLastInvalidatedBySessionAt.set(projectKey, now);
        this.projectFastPollUntil.set(projectKey, now + ScmStatusSync.FAST_POLL_WINDOW_MS);
        const sync = this.getSync(sessionId);
        await sync.invalidateAndAwait();
    }

    /**
     * Stop source-control status sync for a session
     */
    stop(sessionId: string): void {
        const projectKey = this.sessionToProjectKey.get(sessionId);
        if (!projectKey) return;

        this.sessionToProjectKey.delete(sessionId);

        // Only stop the project sync if no other sessions are using it.
        const hasOtherSessions = Array.from(this.sessionToProjectKey.values()).includes(projectKey);
        if (hasOtherSessions) return;

        this.cleanupProjectState(projectKey);
    }

    /**
     * Clear source-control status for a session when it's deleted.
     * Similar to stop() but also clears any stored repository status.
     */
    clearForSession(sessionId: string): void {
        const state = storage.getState();
        this.stop(sessionId);
        state.applyScmStatus(sessionId, null);
        state.updateSessionProjectScmSnapshot(sessionId, null);
        state.updateSessionProjectScmSnapshotError(sessionId, null);
    }

	    private cleanupProjectState(projectKey: string): void {
        const sync = this.projectSyncMap.get(projectKey);
        if (sync) {
            sync.stop();
            this.projectSyncMap.delete(projectKey);
        }

	        this.clearProjectPollTimer(projectKey);
            this.projectPollingSuspended.delete(projectKey);
	        this.projectFastPollUntil.delete(projectKey);
	        this.projectSnapshotSignature.delete(projectKey);
	        this.projectLastSnapshot.delete(projectKey);
	        this.projectLastInvalidatedBySession.delete(projectKey);
	        this.projectLastInvalidationSource.delete(projectKey);
	        this.projectLastInvalidatedBySessionAt.delete(projectKey);
	    }

    private invalidateProject(projectKey: string): void {
        const sync = this.projectSyncMap.get(projectKey);
        if (!sync) return;
        sync.invalidate();
        this.scheduleProjectPoll(projectKey);
    }

    private clearProjectPollTimer(projectKey: string): void {
        const timer = this.projectPollTimers.get(projectKey);
        if (timer) {
            clearTimeout(timer);
            this.projectPollTimers.delete(projectKey);
        }
    }

	    private scheduleProjectPoll(projectKey: string): void {
	        this.clearProjectPollTimer(projectKey);

	        if (this.appState !== 'active') {
	            return;
	        }

            if (this.projectPollingSuspended.has(projectKey)) {
                return;
            }

	        const fastUntil = this.projectFastPollUntil.get(projectKey) ?? 0;
	        const delay = Date.now() < fastUntil ? ScmStatusSync.FAST_POLL_MS : ScmStatusSync.IDLE_POLL_MS;

        const timer = setTimeout(() => {
            if (!this.projectSyncMap.has(projectKey)) {
                this.clearProjectPollTimer(projectKey);
                return;
            }
            this.invalidateProject(projectKey);
        }, delay);

        this.projectPollTimers.set(projectKey, timer);
    }

    private getAnySessionForProject(projectKey: string): string | null {
        for (const [sessionId, key] of this.sessionToProjectKey.entries()) {
            if (key !== projectKey) continue;
            const session = storage.getState().sessions[sessionId];
            if (session?.metadata?.path) {
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
            let suspendAfterFetch = false;
	        try {
	            const state = storage.getState();
	            const snapshot = await scmRepositoryService.fetchSnapshotForSession(sessionId);
	            let activeProjectKey = projectKey;
	            let scopeSessionIds = [sessionId];

            if (!snapshot) {
                state.applyScmStatus(sessionId, null);
                state.updateSessionProjectScmSnapshot(sessionId, null);
                state.pruneSessionProjectScmCommitSelectionPaths(sessionId, new Set());
                return;
            }

            const scopeId = resolveProjectMachineScopeId(state.sessions[sessionId]?.metadata ?? {});
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
                this.projectPollingSuspended.delete(activeProjectKey);

            const previousSnapshot = this.projectLastSnapshot.get(activeProjectKey) ?? null;
            const changedPaths = collectChangedPaths(previousSnapshot, snapshot);
            const activePaths = new Set(snapshot.entries.map((entry) => entry.path));
            const actorSessionId =
                this.projectLastInvalidatedBySession.get(activeProjectKey) ??
                this.projectLastInvalidatedBySession.get(projectKey) ??
                null;
            const actorSource =
                this.projectLastInvalidationSource.get(activeProjectKey) ??
                this.projectLastInvalidationSource.get(projectKey) ??
                null;
            const actorInvalidatedAt =
                this.projectLastInvalidatedBySessionAt.get(activeProjectKey) ??
                this.projectLastInvalidatedBySessionAt.get(projectKey) ??
                null;
            const now = Date.now();

            for (const scopedSessionId of scopeSessionIds) {
                state.updateSessionProjectScmSnapshot(scopedSessionId, snapshot);
                state.updateSessionProjectScmSnapshotError(scopedSessionId, null);

                if (!snapshot.repo.isRepo) {
                    state.applyScmStatus(scopedSessionId, null);
                } else {
                    state.applyScmStatus(scopedSessionId, snapshotToScmStatus(snapshot));
                }

                state.pruneSessionProjectScmTouchedPaths(scopedSessionId, activePaths);
                state.pruneSessionProjectScmCommitSelectionPaths(scopedSessionId, activePaths);
                state.pruneSessionProjectScmCommitSelectionPatches(scopedSessionId, activePaths);
            }

            if (shouldAttributeChangedPaths({
                actorSessionId,
                actorSource,
                scopeSessionIds,
                changedPathCount: changedPaths.length,
                invalidatedAt: actorInvalidatedAt,
                now,
                freshnessWindowMs: ScmStatusSync.FAST_POLL_WINDOW_MS,
            }) && actorSessionId) {
                state.markSessionProjectScmTouchedPaths(actorSessionId, changedPaths);
                this.projectLastInvalidatedBySession.delete(activeProjectKey);
                this.projectLastInvalidationSource.delete(activeProjectKey);
                this.projectLastInvalidatedBySessionAt.delete(activeProjectKey);
            } else if (
                actorInvalidatedAt !== null &&
                now - actorInvalidatedAt > ScmStatusSync.FAST_POLL_WINDOW_MS
            ) {
                this.projectLastInvalidatedBySession.delete(activeProjectKey);
                this.projectLastInvalidationSource.delete(activeProjectKey);
                this.projectLastInvalidatedBySessionAt.delete(activeProjectKey);
            }

            this.projectLastSnapshot.set(activeProjectKey, snapshot);

            const signature = buildSnapshotSignature(snapshot);
            const previousSignature = this.projectSnapshotSignature.get(activeProjectKey);
            if (signature !== previousSignature) {
                this.projectSnapshotSignature.set(activeProjectKey, signature);
                await clearSearchCacheForProject(this.sessionToProjectKey, activeProjectKey);
            }
	        } catch (error) {
	            const message = error instanceof Error ? error.message : String(error ?? 'Unknown source-control status error');
                const scmErrorCode =
                    typeof error === 'object' && error !== null && 'scmErrorCode' in error && typeof (error as { scmErrorCode?: unknown }).scmErrorCode === 'string'
                        ? (error as { scmErrorCode: string }).scmErrorCode
                        : undefined;
	            const now = Date.now();
	            storage.getState().updateSessionProjectScmSnapshotError(sessionId, {
	                message,
	                at: now,
                    ...(scmErrorCode ? { errorCode: scmErrorCode } : {}),
	            });
                if (scmErrorCode === SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED) {
                    this.projectPollingSuspended.add(scheduledProjectKey);
                    suspendAfterFetch = true;
                }
	            reportScmStatusSyncError({ projectKey, error });
	        } finally {
                if (!suspendAfterFetch) {
	                this.scheduleProjectPoll(scheduledProjectKey);
                }
	        }
	    }

    private invalidateWithSource(sessionId: string, source: InvalidationSource): void {
        const projectKey = this.getProjectKeyForSession(sessionId);
        if (!projectKey) return;

        this.projectLastInvalidatedBySession.set(projectKey, sessionId);
        this.projectLastInvalidationSource.set(projectKey, source);
        const now = Date.now();
        this.projectLastInvalidatedBySessionAt.set(projectKey, now);
        this.projectFastPollUntil.set(projectKey, now + ScmStatusSync.FAST_POLL_WINDOW_MS);
        this.invalidateProject(projectKey);
    }
}

// Global singleton instance
export const scmStatusSync = new ScmStatusSync();
