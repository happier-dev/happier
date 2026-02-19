/**
 * Source-control status synchronization module.
 * Provides canonical repository status tracking using ScmRepositoryService.
 */

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
    // Map project keys to sync instances
    private projectSyncMap = new Map<string, InvalidateSync>();
    // Map session IDs to project keys for cleanup
    private sessionToProjectKey = new Map<string, string>();
    // Legacy/compat state maps for project key reassignment helpers.
    // These are intentionally kept even though SCM polling is now driven by screen-level intervals.
    private projectPollTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private projectFastPollUntil = new Map<string, number>();
    // Projects that should skip automatic refresh attempts until a user-initiated refresh occurs.
    private projectAutoRefreshSuspended = new Set<string>();
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

	    private get stateMaps(): ScmStatusSyncStateMaps {
	        return {
	            projectSyncMap: this.projectSyncMap,
	            projectPollTimers: this.projectPollTimers,
                projectPollingSuspended: this.projectAutoRefreshSuspended,
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

        return sync;
    }

    /**
     * Invalidate source-control status for a session (triggers refresh for the entire project)
     */
    invalidate(sessionId: string): void {
        this.invalidateFromAutoRefresh(sessionId);
    }

    invalidateFromAutoRefresh(sessionId: string): void {
        const projectKey = this.getProjectKeyForSession(sessionId);
        if (!projectKey) return;
        if (this.projectAutoRefreshSuspended.has(projectKey)) {
            return;
        }
        this.invalidateWithSource(sessionId, 'unknown');
    }

    async invalidateFromAutoRefreshAndAwait(sessionId: string): Promise<void> {
        const projectKey = this.getProjectKeyForSession(sessionId);
        if (!projectKey) return;
        if (this.projectAutoRefreshSuspended.has(projectKey)) {
            return;
        }
        const sync = this.getSync(sessionId);
        await sync.invalidateAndAwait();
    }

    invalidateFromUser(sessionId: string): void {
        const projectKey = this.getProjectKeyForSession(sessionId);
        if (!projectKey) return;
        this.projectAutoRefreshSuspended.delete(projectKey);
        this.invalidateWithSource(sessionId, 'unknown');
    }

    async invalidateFromUserAndAwait(sessionId: string): Promise<void> {
        const projectKey = this.getProjectKeyForSession(sessionId);
        if (!projectKey) return;
        this.projectAutoRefreshSuspended.delete(projectKey);
        const sync = this.getSync(sessionId);
        await sync.invalidateAndAwait();
    }

    invalidateFromMutation(sessionId: string): void {
        this.invalidateWithSource(sessionId, 'mutation');
    }

    async invalidateFromMutationAndAwait(sessionId: string): Promise<void> {
        const projectKey = this.getProjectKeyForSession(sessionId);
        if (!projectKey) return;

        this.projectAutoRefreshSuspended.delete(projectKey);
        this.projectLastInvalidatedBySession.set(projectKey, sessionId);
        this.projectLastInvalidationSource.set(projectKey, 'mutation');
        const now = Date.now();
        this.projectLastInvalidatedBySessionAt.set(projectKey, now);
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

            this.projectPollTimers.delete(projectKey);
            this.projectFastPollUntil.delete(projectKey);
            this.projectAutoRefreshSuspended.delete(projectKey);
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

            const signature = buildSnapshotSignature(snapshot);
            const previousSignature = this.projectSnapshotSignature.get(activeProjectKey);
            const signatureChanged = signature !== previousSignature;

            if (signatureChanged) {
                this.projectSnapshotSignature.set(activeProjectKey, signature);
                for (const scopedSessionId of scopeSessionIds) {
                    state.updateSessionProjectScmSnapshot(scopedSessionId, snapshot);
                    if (
                        typeof (state as any).getSessionProjectScmSnapshotError === 'function'
                        && (state as any).getSessionProjectScmSnapshotError(scopedSessionId)
                    ) {
                        state.updateSessionProjectScmSnapshotError(scopedSessionId, null);
                    }

                    if (!snapshot.repo.isRepo) {
                        state.applyScmStatus(scopedSessionId, null);
                    } else {
                        state.applyScmStatus(scopedSessionId, snapshotToScmStatus(snapshot));
                    }

                    state.pruneSessionProjectScmTouchedPaths(scopedSessionId, activePaths);
                    state.pruneSessionProjectScmCommitSelectionPaths(scopedSessionId, activePaths);
                    state.pruneSessionProjectScmCommitSelectionPatches(scopedSessionId, activePaths);
                }
            } else {
                // No observable SCM changes; avoid churn. Still clear a previous error if present.
                if (typeof (state as any).getSessionProjectScmSnapshotError === 'function') {
                    for (const scopedSessionId of scopeSessionIds) {
                        if ((state as any).getSessionProjectScmSnapshotError(scopedSessionId)) {
                            state.updateSessionProjectScmSnapshotError(scopedSessionId, null);
                        }
                    }
                }
            }

            if (shouldAttributeChangedPaths({
                actorSessionId,
                actorSource,
                scopeSessionIds,
                changedPathCount: changedPaths.length,
                invalidatedAt: actorInvalidatedAt,
                now,
                freshnessWindowMs: ATTRIBUTION_INVALIDATION_WINDOW_MS,
            }) && actorSessionId) {
                state.markSessionProjectScmTouchedPaths(actorSessionId, changedPaths);
                this.projectLastInvalidatedBySession.delete(activeProjectKey);
                this.projectLastInvalidationSource.delete(activeProjectKey);
                this.projectLastInvalidatedBySessionAt.delete(activeProjectKey);
            } else if (
                actorInvalidatedAt !== null &&
                now - actorInvalidatedAt > ATTRIBUTION_INVALIDATION_WINDOW_MS
            ) {
                this.projectLastInvalidatedBySession.delete(activeProjectKey);
                this.projectLastInvalidationSource.delete(activeProjectKey);
                this.projectLastInvalidatedBySessionAt.delete(activeProjectKey);
            }

            if (signatureChanged) {
                this.projectLastSnapshot.set(activeProjectKey, snapshot);
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
                    this.projectAutoRefreshSuspended.add(scheduledProjectKey);
                }
	            reportScmStatusSyncError({ projectKey, error });
	        }
	    }

    private invalidateWithSource(sessionId: string, source: InvalidationSource): void {
        const projectKey = this.getProjectKeyForSession(sessionId);
        if (!projectKey) return;

        this.projectLastInvalidatedBySession.set(projectKey, sessionId);
        this.projectLastInvalidationSource.set(projectKey, source);
        const now = Date.now();
        this.projectLastInvalidatedBySessionAt.set(projectKey, now);
        this.invalidateProject(projectKey);
    }
}

// Global singleton instance
export const scmStatusSync = new ScmStatusSync();
