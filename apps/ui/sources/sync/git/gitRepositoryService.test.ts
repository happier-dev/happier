import { afterEach, describe, expect, it, vi } from 'vitest';

import { sessionGitStatusSnapshot } from '../ops';
import { storage } from '../domains/state/storage';
import type { GitWorkingSnapshot } from '../domains/state/storageTypes';
import { GitRepositoryService, snapshotToGitStatus } from './gitRepositoryService';

vi.mock('../ops', () => ({
    sessionGitStatusSnapshot: vi.fn(),
}));

afterEach(() => {
    vi.restoreAllMocks();
});

function makeSnapshot(partial?: Partial<GitWorkingSnapshot>): GitWorkingSnapshot {
    return {
        projectKey: 'machine:/repo',
        fetchedAt: 123,
        repo: { isGitRepo: true, rootPath: '/repo' },
        branch: { head: 'main', upstream: 'origin/main', ahead: 2, behind: 1, detached: false },
        stashCount: 3,
        hasConflicts: false,
        entries: [
            {
                path: 'src/app.ts',
                previousPath: null,
                kind: 'modified',
                indexStatus: 'M',
                worktreeStatus: 'M',
                hasStagedDelta: true,
                hasUnstagedDelta: true,
                stats: {
                    stagedAdded: 2,
                    stagedRemoved: 1,
                    unstagedAdded: 4,
                    unstagedRemoved: 0,
                    isBinary: false,
                },
            },
            {
                path: 'new.ts',
                previousPath: null,
                kind: 'untracked',
                indexStatus: '?',
                worktreeStatus: '?',
                hasStagedDelta: false,
                hasUnstagedDelta: true,
                stats: {
                    stagedAdded: 0,
                    stagedRemoved: 0,
                    unstagedAdded: 0,
                    unstagedRemoved: 0,
                    isBinary: false,
                },
            },
        ],
        totals: {
            stagedFiles: 1,
            unstagedFiles: 2,
            untrackedFiles: 1,
            stagedAdded: 2,
            stagedRemoved: 1,
            unstagedAdded: 4,
            unstagedRemoved: 0,
        },
        ...partial,
    };
}

describe('snapshotToGitStatus', () => {
    it('derives aggregate status counters from the canonical snapshot', () => {
        const status = snapshotToGitStatus(makeSnapshot());
        expect(status.branch).toBe('main');
        expect(status.isDirty).toBe(true);
        expect(status.modifiedCount).toBe(1);
        expect(status.untrackedCount).toBe(1);
        expect(status.stagedCount).toBe(1);
        expect(status.stagedLinesAdded).toBe(2);
        expect(status.stagedLinesRemoved).toBe(1);
        expect(status.unstagedLinesAdded).toBe(4);
        expect(status.unstagedLinesRemoved).toBe(0);
        expect(status.linesAdded).toBe(6);
        expect(status.linesRemoved).toBe(1);
        expect(status.linesChanged).toBe(7);
        expect(status.upstreamBranch).toBe('origin/main');
        expect(status.aheadCount).toBe(2);
        expect(status.behindCount).toBe(1);
        expect(status.stashCount).toBe(3);
    });
});

describe('GitRepositoryService.fetchSnapshotForSession', () => {
    it('returns null when session metadata path is unavailable', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            sessions: {
                session_1: {
                    id: 'session_1',
                    metadata: {},
                },
            },
        } as any);
        const service = new GitRepositoryService();
        const result = await service.fetchSnapshotForSession('session_1');
        expect(result).toBeNull();
        expect(sessionGitStatusSnapshot).not.toHaveBeenCalled();
    });

    it('returns a safe empty snapshot when rpc snapshot fetch fails', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        vi.spyOn(storage, 'getState').mockReturnValue({
            sessions: {
                session_1: {
                    id: 'session_1',
                    metadata: {
                        machineId: 'machine-a',
                        path: '/repo',
                    },
                },
            },
        } as any);
        vi.mocked(sessionGitStatusSnapshot).mockResolvedValue({
            success: false,
            error: 'command failed',
            errorCode: 'COMMAND_FAILED',
        } as any);

        const service = new GitRepositoryService();
        const result = await service.fetchSnapshotForSession('session_1');

        expect(result).toMatchObject({
            projectKey: 'machine-a:/repo',
            fetchedAt: 1_700_000_000_000,
            repo: { isGitRepo: false, rootPath: null },
            entries: [],
            hasConflicts: false,
        });
    });

    it('returns a safe empty snapshot when rpc invocation throws unexpectedly', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_001);
        vi.spyOn(storage, 'getState').mockReturnValue({
            sessions: {
                session_1: {
                    id: 'session_1',
                    metadata: {
                        machineId: 'machine-a',
                        path: '/repo',
                    },
                },
            },
        } as any);
        vi.mocked(sessionGitStatusSnapshot).mockRejectedValue(new Error('network glitch'));

        const service = new GitRepositoryService();
        const result = await service.fetchSnapshotForSession('session_1');

        expect(result).toMatchObject({
            projectKey: 'machine-a:/repo',
            fetchedAt: 1_700_000_000_001,
            repo: { isGitRepo: false, rootPath: null },
            entries: [],
            hasConflicts: false,
        });
    });

    it('uses a deterministic fallback project key when rpc snapshot key is empty', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            sessions: {
                session_1: {
                    id: 'session_1',
                    metadata: {
                        machineId: 'machine-a',
                        path: '/repo',
                    },
                },
            },
        } as any);
        vi.mocked(sessionGitStatusSnapshot).mockResolvedValue({
            success: true,
            snapshot: {
                ...makeSnapshot({
                    projectKey: '',
                }),
            },
        } as any);

        const service = new GitRepositoryService();
        const result = await service.fetchSnapshotForSession('session_1');

        expect(result?.projectKey).toBe('machine-a:/repo');
    });
});
