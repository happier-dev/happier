/**
 * Git status synchronization module
 * Provides canonical git repository status tracking using GitRepositoryService
 */

import { AppState, type AppStateStatus } from 'react-native';

import { InvalidateSync } from '@/utils/sessions/sync';
import { gitRepositoryService, snapshotToGitStatus } from './gitRepositoryService';
import { ATTRIBUTION_INVALIDATION_WINDOW_MS, shouldAttributeChangedPaths } from './sync/attribution';
import { isSessionPathWithinRepoRoot } from './sync/paths';
import { collectChangedPaths } from './sync/snapshotDiff';
import { storage } from '../domains/state/storage';
import type { GitWorkingSnapshot } from '../domains/state/storageTypes';

type InvalidationSource = 'unknown' | 'mutation';
export { ATTRIBUTION_INVALIDATION_WINDOW_MS, shouldAttributeChangedPaths } from './sync/attribution';
export { isSessionPathWithinRepoRoot } from './sync/paths';
export { collectChangedPaths } from './sync/snapshotDiff';

export class GitStatusSync {
    private static readonly FAST_POLL_MS = 2_000;
    private static readonly IDLE_POLL_MS = 8_000;
    private static readonly FAST_POLL_WINDOW_MS = ATTRIBUTION_INVALIDATION_WINDOW_MS;

    // Map project keys to sync instances
    private projectSyncMap = new Map<string, InvalidateSync>();
    // Map session IDs to project keys for cleanup
    private sessionToProjectKey = new Map<string, string>();
    // Poll timers per project
    private projectPollTimers = new Map<string, ReturnType<typeof setTimeout>>();
    // Fast poll window per project
    private projectFastPollUntil = new Map<string, number>();
    // Snapshot signatures per project to detect file tree changes
    private projectSnapshotSignature = new Map<string, string>();
    // Last snapshot per project to compute changed path attribution
    private projectLastSnapshot = new Map<string, GitWorkingSnapshot | null>();
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

    /**
     * Get project key string for a session
     */
    private getProjectKeyForSession(sessionId: string): string | null {
        const mapped = this.sessionToProjectKey.get(sessionId);
        if (mapped) {
            return mapped;
        }
        const session = storage.getState().sessions[sessionId];
        if (!session?.metadata?.machineId || !session?.metadata?.path) {
            return null;
        }
        return `${session.metadata.machineId}:${session.metadata.path}`;
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
                this.projectFastPollUntil.set(projectKey, now + GitStatusSync.FAST_POLL_WINDOW_MS);
                this.invalidateProject(projectKey);
            }
        }
    };

    /**
     * Get or create git status sync for a session (creates project-based sync)
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
            sync = new InvalidateSync(() => this.fetchGitStatusForProject(projectKey));
            this.projectSyncMap.set(projectKey, sync);
        }

        this.scheduleProjectPoll(projectKey);
        return sync;
    }

    /**
     * Invalidate git status for a session (triggers refresh for the entire project)
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
        this.projectFastPollUntil.set(projectKey, now + GitStatusSync.FAST_POLL_WINDOW_MS);
        const sync = this.getSync(sessionId);
        await sync.invalidateAndAwait();
    }

    /**
     * Stop git status sync for a session
     */
    stop(sessionId: string): void {
        const projectKey = this.sessionToProjectKey.get(sessionId);
        if (!projectKey) return;

        this.sessionToProjectKey.delete(sessionId);

        // Check if any other sessions are using this project
        const hasOtherSessions = Array.from(this.sessionToProjectKey.values()).includes(projectKey);

        // Only stop the project sync if no other sessions are using it
        if (hasOtherSessions) return;

        const sync = this.projectSyncMap.get(projectKey);
        if (sync) {
            sync.stop();
            this.projectSyncMap.delete(projectKey);
        }

        this.clearProjectPollTimer(projectKey);
        this.projectFastPollUntil.delete(projectKey);
        this.projectSnapshotSignature.delete(projectKey);
        this.projectLastSnapshot.delete(projectKey);
        this.projectLastInvalidatedBySession.delete(projectKey);
        this.projectLastInvalidationSource.delete(projectKey);
        this.projectLastInvalidatedBySessionAt.delete(projectKey);
    }

    /**
     * Clear git status for a session when it's deleted
     * Similar to stop() but also clears any stored git status
     */
    clearForSession(sessionId: string): void {
        const state = storage.getState();
        this.stop(sessionId);
        state.applyGitStatus(sessionId, null);
        state.updateSessionProjectGitSnapshot(sessionId, null);
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

        const fastUntil = this.projectFastPollUntil.get(projectKey) ?? 0;
        const delay = Date.now() < fastUntil ? GitStatusSync.FAST_POLL_MS : GitStatusSync.IDLE_POLL_MS;

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

    private buildSnapshotSignature(snapshot: NonNullable<Awaited<ReturnType<typeof gitRepositoryService.fetchSnapshotForSession>>>): string {
        if (!snapshot.repo.isGitRepo) {
            return 'not-git-repo';
        }

        const filesSig = snapshot.entries
            .map((entry) => [
                entry.path,
                entry.previousPath ?? '',
                entry.indexStatus,
                entry.worktreeStatus,
                String(entry.hasStagedDelta),
                String(entry.hasUnstagedDelta),
                String(entry.stats.stagedAdded),
                String(entry.stats.stagedRemoved),
                String(entry.stats.unstagedAdded),
                String(entry.stats.unstagedRemoved),
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
            String(snapshot.stashCount),
            String(snapshot.hasConflicts),
            filesSig,
        ].join('\n');
    }

    private async clearSearchCacheForProject(projectKey: string): Promise<void> {
        const { fileSearchCache } = await import('../domains/input/suggestionFile');
        for (const [sessionId, key] of this.sessionToProjectKey.entries()) {
            if (key === projectKey) {
                fileSearchCache.clearCache(sessionId);
            }
        }
    }

    private getRepoScopeSessionIds(referenceSessionId: string, repoRoot: string): string[] {
        const state = storage.getState();
        const reference = state.sessions[referenceSessionId];
        const machineId = reference?.metadata?.machineId;
        if (!machineId) return [referenceSessionId];

        const inScope = new Set<string>();
        for (const session of Object.values(state.sessions)) {
            const sessionMachineId = session.metadata?.machineId;
            const sessionPath = session.metadata?.path;
            if (!sessionMachineId || !sessionPath) continue;
            if (sessionMachineId !== machineId) continue;
            if (!isSessionPathWithinRepoRoot(sessionPath, repoRoot)) continue;
            inScope.add(session.id);
        }

        inScope.add(referenceSessionId);
        return Array.from(inScope);
    }

    private moveProjectStateKey(fromKey: string, toKey: string): void {
        if (fromKey === toKey) return;

        const fromSync = this.projectSyncMap.get(fromKey);
        if (fromSync && !this.projectSyncMap.has(toKey)) {
            this.projectSyncMap.set(toKey, fromSync);
        }
        this.projectSyncMap.delete(fromKey);

        const fromTimer = this.projectPollTimers.get(fromKey);
        if (fromTimer && !this.projectPollTimers.has(toKey)) {
            this.projectPollTimers.set(toKey, fromTimer);
        }
        this.projectPollTimers.delete(fromKey);

        const fastUntil = this.projectFastPollUntil.get(fromKey);
        if (typeof fastUntil === 'number' && !this.projectFastPollUntil.has(toKey)) {
            this.projectFastPollUntil.set(toKey, fastUntil);
        }
        this.projectFastPollUntil.delete(fromKey);

        const signature = this.projectSnapshotSignature.get(fromKey);
        if (signature && !this.projectSnapshotSignature.has(toKey)) {
            this.projectSnapshotSignature.set(toKey, signature);
        }
        this.projectSnapshotSignature.delete(fromKey);

        const snapshot = this.projectLastSnapshot.get(fromKey);
        if (snapshot && !this.projectLastSnapshot.has(toKey)) {
            this.projectLastSnapshot.set(toKey, snapshot);
        }
        this.projectLastSnapshot.delete(fromKey);

        const actor = this.projectLastInvalidatedBySession.get(fromKey);
        if (actor && !this.projectLastInvalidatedBySession.has(toKey)) {
            this.projectLastInvalidatedBySession.set(toKey, actor);
        }
        this.projectLastInvalidatedBySession.delete(fromKey);

        const actorSource = this.projectLastInvalidationSource.get(fromKey);
        if (actorSource && !this.projectLastInvalidationSource.has(toKey)) {
            this.projectLastInvalidationSource.set(toKey, actorSource);
        }
        this.projectLastInvalidationSource.delete(fromKey);

        const actorAt = this.projectLastInvalidatedBySessionAt.get(fromKey);
        if (typeof actorAt === 'number' && !this.projectLastInvalidatedBySessionAt.has(toKey)) {
            this.projectLastInvalidatedBySessionAt.set(toKey, actorAt);
        }
        this.projectLastInvalidatedBySessionAt.delete(fromKey);
    }

    private reassignSessionsToProjectKey(sessionIds: string[], targetProjectKey: string): void {
        for (const sessionId of sessionIds) {
            const previousKey = this.sessionToProjectKey.get(sessionId);
            this.sessionToProjectKey.set(sessionId, targetProjectKey);
            if (!previousKey || previousKey === targetProjectKey) continue;

            const hasConsumers = Array.from(this.sessionToProjectKey.values()).some((value) => value === previousKey);
            if (!hasConsumers) {
                const sync = this.projectSyncMap.get(previousKey);
                if (sync) {
                    sync.stop();
                    this.projectSyncMap.delete(previousKey);
                }
                this.clearProjectPollTimer(previousKey);
                this.projectFastPollUntil.delete(previousKey);
                this.projectSnapshotSignature.delete(previousKey);
                this.projectLastSnapshot.delete(previousKey);
                this.projectLastInvalidatedBySession.delete(previousKey);
                this.projectLastInvalidationSource.delete(previousKey);
                this.projectLastInvalidatedBySessionAt.delete(previousKey);
            }
        }
    }

    /**
     * Fetch git status for a project using any session in that project
     */
    private async fetchGitStatusForProject(projectKey: string): Promise<void> {
        const sessionId = this.getAnySessionForProject(projectKey);
        if (!sessionId) return;

        try {
            const state = storage.getState();
            const snapshot = await gitRepositoryService.fetchSnapshotForSession(sessionId);
            let activeProjectKey = projectKey;
            let scopeSessionIds = [sessionId];

            if (!snapshot) {
                state.applyGitStatus(sessionId, null);
                state.updateSessionProjectGitSnapshot(sessionId, null);
                return;
            }

            const machineId = state.sessions[sessionId]?.metadata?.machineId ?? null;
            const repoRoot = snapshot.repo.rootPath;
            if (snapshot.repo.isGitRepo && machineId && repoRoot) {
                activeProjectKey = `${machineId}:${repoRoot}`;
                scopeSessionIds = this.getRepoScopeSessionIds(sessionId, repoRoot);
                if (activeProjectKey !== projectKey) {
                    this.moveProjectStateKey(projectKey, activeProjectKey);
                }
                this.reassignSessionsToProjectKey(scopeSessionIds, activeProjectKey);
            }

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
                state.updateSessionProjectGitSnapshot(scopedSessionId, snapshot);

                if (!snapshot.repo.isGitRepo) {
                    state.applyGitStatus(scopedSessionId, null);
                } else {
                    state.applyGitStatus(scopedSessionId, snapshotToGitStatus(snapshot));
                }

                state.pruneSessionProjectGitTouchedPaths(scopedSessionId, activePaths);
            }

            if (shouldAttributeChangedPaths({
                actorSessionId,
                actorSource,
                scopeSessionIds,
                changedPathCount: changedPaths.length,
                invalidatedAt: actorInvalidatedAt,
                now,
                freshnessWindowMs: GitStatusSync.FAST_POLL_WINDOW_MS,
            }) && actorSessionId) {
                state.markSessionProjectGitTouchedPaths(actorSessionId, changedPaths);
                this.projectLastInvalidatedBySession.delete(activeProjectKey);
                this.projectLastInvalidationSource.delete(activeProjectKey);
                this.projectLastInvalidatedBySessionAt.delete(activeProjectKey);
            } else if (
                actorInvalidatedAt !== null &&
                now - actorInvalidatedAt > GitStatusSync.FAST_POLL_WINDOW_MS
            ) {
                this.projectLastInvalidatedBySession.delete(activeProjectKey);
                this.projectLastInvalidationSource.delete(activeProjectKey);
                this.projectLastInvalidatedBySessionAt.delete(activeProjectKey);
            }

            this.projectLastSnapshot.set(activeProjectKey, snapshot);

            const signature = this.buildSnapshotSignature(snapshot);
            const previousSignature = this.projectSnapshotSignature.get(activeProjectKey);
            if (signature !== previousSignature) {
                this.projectSnapshotSignature.set(activeProjectKey, signature);
                await this.clearSearchCacheForProject(activeProjectKey);
            }
        } catch (error) {
            console.error('Error fetching git status for project', projectKey, ':', error);
        } finally {
            this.scheduleProjectPoll(projectKey);
        }
    }

    private invalidateWithSource(sessionId: string, source: InvalidationSource): void {
        const projectKey = this.getProjectKeyForSession(sessionId);
        if (!projectKey) return;

        this.projectLastInvalidatedBySession.set(projectKey, sessionId);
        this.projectLastInvalidationSource.set(projectKey, source);
        const now = Date.now();
        this.projectLastInvalidatedBySessionAt.set(projectKey, now);
        this.projectFastPollUntil.set(projectKey, now + GitStatusSync.FAST_POLL_WINDOW_MS);
        this.invalidateProject(projectKey);
    }
}

// Global singleton instance
export const gitStatusSync = new GitStatusSync();
