import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ScmWorkingSnapshot as ProtocolScmWorkingSnapshot } from '@happier-dev/protocol';
import { sessionScmStatusSnapshot } from '@/sync/ops';
import { storage } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot as UiScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { ScmRepositoryService, snapshotToScmStatus } from './scmRepositoryService';

vi.mock('@/sync/ops', () => ({
    sessionScmStatusSnapshot: vi.fn(),
}));

afterEach(() => {
    vi.restoreAllMocks();
});

function makeSnapshot(partial?: Partial<UiScmWorkingSnapshot>): UiScmWorkingSnapshot {
    return {
        projectKey: 'machine:/repo',
        fetchedAt: 123,
        repo: { isRepo: true, rootPath: '/repo' },
        branch: { head: 'main', upstream: 'origin/main', ahead: 2, behind: 1, detached: false },
        stashCount: 3,
        hasConflicts: false,
        entries: [
            {
                path: 'src/app.ts',
                previousPath: null,
                kind: 'modified',
                includeStatus: 'M',
                pendingStatus: 'M',
                hasIncludedDelta: true,
                hasPendingDelta: true,
                stats: {
                    includedAdded: 2,
                    includedRemoved: 1,
                    pendingAdded: 4,
                    pendingRemoved: 0,
                    isBinary: false,
                },
            },
            {
                path: 'new.ts',
                previousPath: null,
                kind: 'untracked',
                includeStatus: '?',
                pendingStatus: '?',
                hasIncludedDelta: false,
                hasPendingDelta: true,
                stats: {
                    includedAdded: 0,
                    includedRemoved: 0,
                    pendingAdded: 0,
                    pendingRemoved: 0,
                    isBinary: false,
                },
            },
        ],
        totals: {
            includedFiles: 1,
            pendingFiles: 2,
            untrackedFiles: 1,
            includedAdded: 2,
            includedRemoved: 1,
            pendingAdded: 4,
            pendingRemoved: 0,
        },
        ...partial,
    };
}

function makeScmSnapshot(partial?: Partial<ProtocolScmWorkingSnapshot>): ProtocolScmWorkingSnapshot {
    return {
        projectKey: 'machine:/repo',
        fetchedAt: 123,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        capabilities: {
            readStatus: true,
            readDiffFile: true,
            readDiffCommit: true,
            readLog: true,
            writeInclude: true,
            writeExclude: true,
            writeCommit: true,
            writeCommitPathSelection: true,
            writeCommitLineSelection: true,
            writeBackout: true,
            writeRemoteFetch: true,
            writeRemotePull: true,
            writeRemotePush: true,
            workspaceWorktreeCreate: true,
            changeSetModel: 'index',
            supportedDiffAreas: ['included', 'pending', 'both'],
            operationLabels: { commit: 'Commit staged' },
        },
        branch: { head: 'main', upstream: 'origin/main', ahead: 2, behind: 1, detached: false },
        stashCount: 3,
        hasConflicts: false,
        entries: [
            {
                path: 'src/app.ts',
                previousPath: null,
                kind: 'modified',
                includeStatus: 'M',
                pendingStatus: 'M',
                hasIncludedDelta: true,
                hasPendingDelta: true,
                stats: {
                    includedAdded: 2,
                    includedRemoved: 1,
                    pendingAdded: 4,
                    pendingRemoved: 0,
                    isBinary: false,
                },
            },
        ],
        totals: {
            includedFiles: 1,
            pendingFiles: 1,
            untrackedFiles: 0,
            includedAdded: 2,
            includedRemoved: 1,
            pendingAdded: 4,
            pendingRemoved: 0,
        },
        ...partial,
    };
}

describe('snapshotToScmStatus', () => {
    it('derives aggregate status counters from the canonical snapshot', () => {
        const status = snapshotToScmStatus(makeSnapshot());
        expect(status.branch).toBe('main');
        expect(status.isDirty).toBe(true);
        expect(status.modifiedCount).toBe(1);
        expect(status.untrackedCount).toBe(1);
        expect(status.includedCount).toBe(1);
        expect(status.includedLinesAdded).toBe(2);
        expect(status.includedLinesRemoved).toBe(1);
        expect(status.pendingLinesAdded).toBe(4);
        expect(status.pendingLinesRemoved).toBe(0);
        expect(status.linesAdded).toBe(6);
        expect(status.linesRemoved).toBe(1);
        expect(status.linesChanged).toBe(7);
        expect(status.upstreamBranch).toBe('origin/main');
        expect(status.aheadCount).toBe(2);
        expect(status.behindCount).toBe(1);
        expect(status.stashCount).toBe(3);
    });
});

describe('ScmRepositoryService.fetchSnapshotForSession', () => {
    it('returns null when session metadata path is unavailable', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            sessions: {
                session_1: {
                    id: 'session_1',
                    metadata: {},
                },
            },
        } as any);
        const service = new ScmRepositoryService();
        const result = await service.fetchSnapshotForSession('session_1');
        expect(result).toBeNull();
        expect(sessionScmStatusSnapshot).not.toHaveBeenCalled();
    });

    it('throws when rpc snapshot fetch fails', async () => {
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
        vi.mocked(sessionScmStatusSnapshot).mockResolvedValue({
            success: false,
            error: 'command failed',
            errorCode: 'COMMAND_FAILED',
        } as any);

        const service = new ScmRepositoryService();
        await expect(service.fetchSnapshotForSession('session_1')).rejects.toThrow('command failed');
    });

    it('throws when rpc invocation throws unexpectedly', async () => {
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
        vi.mocked(sessionScmStatusSnapshot).mockRejectedValue(new Error('network glitch'));

        const service = new ScmRepositoryService();
        await expect(service.fetchSnapshotForSession('session_1')).rejects.toThrow('network glitch');
    });

    it('returns a safe empty snapshot when rpc success response omits snapshot payload', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_002);
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
        vi.mocked(sessionScmStatusSnapshot).mockResolvedValue({
            success: true,
            snapshot: null,
        } as any);

        const service = new ScmRepositoryService();
        const result = await service.fetchSnapshotForSession('session_1');

        expect(result).toMatchObject({
            projectKey: 'machine-a:/repo',
            fetchedAt: 1_700_000_000_002,
            repo: { isRepo: false, rootPath: null },
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
        vi.mocked(sessionScmStatusSnapshot).mockResolvedValue({
            success: true,
            snapshot: {
                ...makeSnapshot({
                    projectKey: '',
                }),
            },
        } as any);

        const service = new ScmRepositoryService();
        const result = await service.fetchSnapshotForSession('session_1');

        expect(result?.projectKey).toBe('machine-a:/repo');
    });

    it('normalizes scm snapshots into the ui working snapshot shape', async () => {
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
        vi.mocked(sessionScmStatusSnapshot).mockResolvedValue({
            success: true,
            snapshot: makeScmSnapshot({
                repo: { isRepo: true, rootPath: '/repo', backendId: 'sapling', mode: '.sl' },
                capabilities: {
                    ...makeScmSnapshot().capabilities,
                    writeInclude: false,
                    writeExclude: false,
                    changeSetModel: 'working-copy',
                    supportedDiffAreas: ['pending', 'both'],
                    operationLabels: { commit: 'Commit changes' },
                },
            }),
        } as any);

        const service = new ScmRepositoryService();
        const result = await service.fetchSnapshotForSession('session_1');

        expect(result?.repo.isRepo).toBe(true);
        expect(result?.repo.backendId).toBe('sapling');
        expect(result?.repo.mode).toBe('.sl');
        expect(result?.totals.includedFiles).toBe(1);
        expect(result?.totals.pendingFiles).toBe(1);
        expect(result?.entries[0]?.includeStatus).toBe('M');
        expect(result?.entries[0]?.pendingStatus).toBe('M');
        expect(result?.entries[0]?.hasIncludedDelta).toBe(true);
        expect(result?.entries[0]?.hasPendingDelta).toBe(true);
        expect(result?.entries[0]?.stats.includedAdded).toBe(2);
        expect(result?.entries[0]?.stats.pendingAdded).toBe(4);
        expect(result?.capabilities?.writeInclude).toBe(false);
        expect(result?.capabilities?.operationLabels?.commit).toBe('Commit changes');
    });

    it('does not pass tilde session paths to scm rpc (relies on session working directory)', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            sessions: {
                session_1: {
                    id: 'session_1',
                    metadata: {
                        machineId: 'machine-a',
                        path: '~/repo',
                    },
                },
            },
        } as any);
        vi.mocked(sessionScmStatusSnapshot).mockResolvedValue({
            success: true,
            snapshot: makeScmSnapshot({
                projectKey: 'machine-a:/Users/tester/repo',
                repo: { isRepo: true, rootPath: '/Users/tester/repo', backendId: 'git', mode: '.git' },
            }),
        } as any);

        const service = new ScmRepositoryService();
        await service.fetchSnapshotForSession('session_1');

        expect(sessionScmStatusSnapshot).toHaveBeenCalledWith('session_1', {});
    });

    it('defaults missing capabilities to fully disabled regardless of backend id', async () => {
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
        vi.mocked(sessionScmStatusSnapshot).mockResolvedValue({
            success: true,
            snapshot: {
                ...makeScmSnapshot({
                    repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
                }),
                capabilities: undefined,
            },
        } as any);

        const service = new ScmRepositoryService();
        const result = await service.fetchSnapshotForSession('session_1');

        expect(result?.capabilities).toEqual({
            readStatus: false,
            readDiffFile: false,
            readDiffCommit: false,
            readLog: false,
            writeInclude: false,
            writeExclude: false,
            writeCommit: false,
            writeCommitPathSelection: false,
            writeCommitLineSelection: false,
            writeBackout: false,
            writeRemoteFetch: false,
            writeRemotePull: false,
            writeRemotePush: false,
            workspaceWorktreeCreate: false,
            changeSetModel: 'working-copy',
            supportedDiffAreas: ['pending', 'both'],
        });
    });
});
