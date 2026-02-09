import { sessionGitStatusSnapshot } from '../ops';
import { createProjectKey } from '../projectManager';
import { storage } from '../storage';
import type { GitStatus, GitWorkingSnapshot } from '../storageTypes';

function createEmptyGitSnapshot(input: {
    projectKey: string;
    fetchedAt?: number;
    rootPath?: string | null;
}): GitWorkingSnapshot {
    return {
        projectKey: input.projectKey,
        fetchedAt: input.fetchedAt ?? Date.now(),
        repo: { isGitRepo: false, rootPath: input.rootPath ?? null },
        branch: { head: null, upstream: null, ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: false,
        entries: [],
        totals: {
            stagedFiles: 0,
            unstagedFiles: 0,
            untrackedFiles: 0,
            stagedAdded: 0,
            stagedRemoved: 0,
            unstagedAdded: 0,
            unstagedRemoved: 0,
        },
    };
}

export function snapshotToGitStatus(snapshot: GitWorkingSnapshot): GitStatus {
    const modifiedCount = snapshot.entries.filter((entry) => entry.kind !== 'untracked').length;
    const untrackedCount = snapshot.entries.filter((entry) => entry.kind === 'untracked').length;
    const stagedCount = snapshot.totals.stagedFiles;
    const stagedLinesAdded = snapshot.totals.stagedAdded;
    const stagedLinesRemoved = snapshot.totals.stagedRemoved;
    const unstagedLinesAdded = snapshot.totals.unstagedAdded;
    const unstagedLinesRemoved = snapshot.totals.unstagedRemoved;
    const linesAdded = stagedLinesAdded + unstagedLinesAdded;
    const linesRemoved = stagedLinesRemoved + unstagedLinesRemoved;

    return {
        branch: snapshot.branch.head,
        isDirty: snapshot.entries.length > 0,
        modifiedCount,
        untrackedCount,
        stagedCount,
        lastUpdatedAt: snapshot.fetchedAt,
        stagedLinesAdded,
        stagedLinesRemoved,
        unstagedLinesAdded,
        unstagedLinesRemoved,
        linesAdded,
        linesRemoved,
        linesChanged: linesAdded + linesRemoved,
        upstreamBranch: snapshot.branch.upstream,
        aheadCount: snapshot.branch.ahead,
        behindCount: snapshot.branch.behind,
        stashCount: snapshot.stashCount,
    };
}

export class GitRepositoryService {
    async fetchSnapshotForSession(sessionId: string): Promise<GitWorkingSnapshot | null> {
        const session = storage.getState().sessions[sessionId];
        if (!session?.metadata?.path) return null;

        const projectKey = createProjectKey(
            session.metadata.machineId || 'unknown',
            session.metadata.path
        );
        const projectKeyString = `${projectKey.machineId}:${projectKey.path}`;
        const cwd = session.metadata.path;
        const fetchedAt = Date.now();

        try {
            const response = await sessionGitStatusSnapshot(sessionId, { cwd });
            if (!response.success || !response.snapshot) {
                return createEmptyGitSnapshot({
                    projectKey: projectKeyString,
                    fetchedAt,
                    rootPath: null,
                });
            }

            return {
                ...response.snapshot,
                projectKey: response.snapshot.projectKey || projectKeyString,
            };
        } catch {
            return createEmptyGitSnapshot({
                projectKey: projectKeyString,
                fetchedAt,
                rootPath: null,
            });
        }
    }
}

export const gitRepositoryService = new GitRepositoryService();
