import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ScmWorkingSnapshot as ProtocolScmWorkingSnapshot } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { sessionScmStatusSnapshot } from '@/sync/ops';
import { machineScmStatusSnapshot } from '@/sync/ops/scm/machineScm';
import { storage } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot as UiScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { ScmRepositoryService, snapshotToScmStatus } from './scmRepositoryService';

vi.mock('@/sync/ops', () => ({
    sessionScmStatusSnapshot: vi.fn(),
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmStatusSnapshot: vi.fn(),
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
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', worktrees: [] },
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
            worktreeCreate: true,
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

    it('uses project key path when session metadata path is unavailable', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            sessions: {
                session_1: {
                    id: 'session_1',
                    metadata: {
                        machineId: 'machine-a',
                    },
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 'session_1'
                    ? {
                        key: {
                            machineId: 'machine-a',
                            path: '/repo-from-project',
                        },
                    }
                    : null,
        } as any);

        vi.mocked(sessionScmStatusSnapshot).mockResolvedValue({
            success: true,
            snapshot: makeScmSnapshot({
                projectKey: 'machine-a:/repo-from-project',
                repo: {
                    isRepo: true,
                    rootPath: '/repo-from-project',
                    backendId: 'git',
                    mode: '.git',
                    worktrees: [],
                },
            }),
        } as any);

        const service = new ScmRepositoryService();
        const result = await service.fetchSnapshotForSession('session_1');

        expect(result).not.toBeNull();
        expect(result?.projectKey).toBe('machine-a:/repo-from-project');
        expect(sessionScmStatusSnapshot).toHaveBeenCalledWith('session_1', {});
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
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
        } as any);

        const service = new ScmRepositoryService();
        let thrown: unknown = null;
        try {
            await service.fetchSnapshotForSession('session_1');
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe('command failed');
        expect(
            typeof thrown === 'object' && thrown !== null && 'scmErrorCode' in thrown
                ? (thrown as { scmErrorCode?: unknown }).scmErrorCode
                : undefined
        ).toBe(SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
    });

    it('throws a descriptive error when rpc snapshot payload is null', async () => {
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
        vi.mocked(sessionScmStatusSnapshot).mockResolvedValue(null as any);

        const service = new ScmRepositoryService();
        await expect(service.fetchSnapshotForSession('session_1')).rejects.toThrow(
            'Invalid source-control status snapshot response'
        );
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
                repo: { isRepo: true, rootPath: '/repo', backendId: 'sapling', mode: '.sl', worktrees: [] },
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

    it('preserves protocol repo worktrees in the ui snapshot shape', async () => {
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
                repo: {
                    isRepo: true,
                    rootPath: '/repo',
                    backendId: 'git',
                    mode: '.git',
                    worktrees: [
                        { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
                        { path: '/repo', branch: 'main', isCurrent: true },
                    ],
                },
            }),
        } as any);

        const service = new ScmRepositoryService();
        const result = await service.fetchSnapshotForSession('session_1');

        expect(result?.repo.worktrees).toEqual([
            { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
            { path: '/repo', branch: 'main', isCurrent: true },
        ]);
    });

    it('does not pass tilde session paths to scm rpc (relies on session working directory)', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
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
                repo: { isRepo: true, rootPath: '/Users/tester/repo', backendId: 'git', mode: '.git', worktrees: [] },
            }),
        } as any);

        const service = new ScmRepositoryService();
        await service.fetchSnapshotForSession('session_1');

        expect(sessionScmStatusSnapshot).toHaveBeenCalledWith('session_1', {});
    });

    it('hydrates the shared machine/path cache when a session snapshot resolves a repo identity', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
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
                repo: {
                    isRepo: true,
                    rootPath: '/Users/tester/repo',
                    backendId: 'git',
                    mode: '.git',
                    worktrees: [{ path: '/Users/tester/repo', branch: 'main', isCurrent: true }],
                },
            }),
        } as any);

        const service = new ScmRepositoryService();
        const result = await service.fetchSnapshotForSession('session_1');

        expect(service.readCachedSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        })).toEqual(result);
    });

    it('stores session snapshots under the canonical repo root identity key when the session path is a subdirectory', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
            sessions: {
                session_1: {
                    id: 'session_1',
                    metadata: {
                        machineId: 'machine-a',
                        path: '~/repo/subdir',
                    },
                },
            },
        } as any);
        vi.mocked(sessionScmStatusSnapshot).mockResolvedValue({
            success: true,
            snapshot: makeScmSnapshot({
                projectKey: '',
                repo: {
                    isRepo: true,
                    rootPath: '/Users/tester/repo',
                    backendId: 'git',
                    mode: '.git',
                    worktrees: [{ path: '/Users/tester/repo', branch: 'main', isCurrent: true }],
                },
            }),
        } as any);

        const service = new ScmRepositoryService();
        const result = await service.fetchSnapshotForSession('session_1');

        expect(result?.projectKey).toBe('machine-a:/Users/tester/repo');
        expect(service.readCachedSnapshotForSession('session_1')).toEqual(result);
        expect(service.readCachedSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        })).toEqual(result);
        expect(service.readCachedSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo/subdir',
        })).toEqual(result);
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
                    repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', worktrees: [] },
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
            writeRemotePublish: false,
            readBranches: false,
            writeBranchCreate: false,
            writeBranchCheckout: false,
            readStash: false,
            writeStash: false,
            worktreeCreate: false,
            changeSetModel: 'working-copy',
            supportedDiffAreas: ['pending', 'both'],
        });
    });
});

describe('ScmRepositoryService.fetchSnapshotForMachinePath', () => {
    it('fetches and normalizes a repo snapshot through machine/path SCM without requiring a session', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
        } as any);
        vi.mocked(machineScmStatusSnapshot).mockResolvedValue({
            success: true,
            snapshot: makeScmSnapshot({
                projectKey: '',
                repo: {
                    isRepo: true,
                    rootPath: '/Users/tester/repo',
                    backendId: 'git',
                    mode: '.git',
                    worktrees: [
                        { path: '/Users/tester/repo', branch: 'main', isCurrent: true },
                        { path: '/Users/tester/repo-feature-auth', branch: 'feature/auth', isCurrent: false },
                    ],
                },
            }),
        } as any);

        const service = new ScmRepositoryService();
        const result = await service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        });

        expect(machineScmStatusSnapshot).toHaveBeenCalledWith('machine-a', {
            cwd: '/Users/tester/repo',
        });
        expect(result).not.toBeNull();
        expect(result?.projectKey).toBe('machine-a:/Users/tester/repo');
        expect(result?.repo.rootPath).toBe('/Users/tester/repo');
        expect(result?.repo.worktrees).toEqual([
            { path: '/Users/tester/repo', branch: 'main', isCurrent: true },
            { path: '/Users/tester/repo-feature-auth', branch: 'feature/auth', isCurrent: false },
        ]);
    });

    it('normalizes projectKey to the repo root when the request path is a subdirectory and the backend omits projectKey', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
        } as any);
        vi.mocked(machineScmStatusSnapshot).mockResolvedValue({
            success: true,
            snapshot: makeScmSnapshot({
                projectKey: '',
                repo: {
                    isRepo: true,
                    rootPath: '/Users/tester/repo',
                    backendId: 'git',
                    mode: '.git',
                    worktrees: [{ path: '/Users/tester/repo', branch: 'main', isCurrent: true }],
                },
            }),
        } as any);

        const service = new ScmRepositoryService();
        const result = await service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo/subdir',
        });

        expect(machineScmStatusSnapshot).toHaveBeenCalledWith('machine-a', {
            cwd: '/Users/tester/repo/subdir',
        });
        expect(result?.projectKey).toBe('machine-a:/Users/tester/repo');
        expect(result?.repo.rootPath).toBe('/Users/tester/repo');
    });

    it('normalizes repo root paths before building the canonical projectKey', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
        } as any);
        vi.mocked(machineScmStatusSnapshot).mockResolvedValue({
            success: true,
            snapshot: makeScmSnapshot({
                projectKey: '',
                repo: {
                    isRepo: true,
                    rootPath: '/Users/tester/repo/',
                    backendId: 'git',
                    mode: '.git',
                    worktrees: [{ path: '/Users/tester/repo', branch: 'main', isCurrent: true }],
                },
            }),
        } as any);

        const service = new ScmRepositoryService();
        const result = await service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo/subdir',
        });

        expect(result?.projectKey).toBe('machine-a:/Users/tester/repo');
    });

    it('deduplicates concurrent machine/path snapshot requests for the same repo identity', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
        } as any);

        const deferredSnapshot = {
            resolve: (_value: any): void => {},
        };
        const snapshotPromise = new Promise<any>((resolve) => {
            deferredSnapshot.resolve = resolve;
        });
        vi.mocked(machineScmStatusSnapshot).mockReturnValue(snapshotPromise as any);

        const service = new ScmRepositoryService();
        const firstPromise = service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        });
        const secondPromise = service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        });

        expect(machineScmStatusSnapshot).toHaveBeenCalledTimes(1);

        deferredSnapshot.resolve({
            success: true,
            snapshot: makeScmSnapshot({
                repo: {
                    isRepo: true,
                    rootPath: '/Users/tester/repo',
                    backendId: 'git',
                    mode: '.git',
                    worktrees: [{ path: '/Users/tester/repo', branch: 'main', isCurrent: true }],
                },
            }),
        });

        const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
        expect(firstResult).toEqual(secondResult);
        expect(machineScmStatusSnapshot).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent session and machine/path snapshot requests for the same repo identity', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
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

        const deferredSnapshot = {
            resolve: (_value: any): void => {},
        };
        const snapshotPromise = new Promise<any>((resolve) => {
            deferredSnapshot.resolve = resolve;
        });
        vi.mocked(sessionScmStatusSnapshot).mockReturnValue(snapshotPromise as any);

        const service = new ScmRepositoryService();
        const firstPromise = service.fetchSnapshotForSession('session_1');
        const secondPromise = service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        });

        expect(sessionScmStatusSnapshot).toHaveBeenCalledTimes(1);
        expect(machineScmStatusSnapshot).not.toHaveBeenCalled();

        deferredSnapshot.resolve({
            success: true,
            snapshot: makeScmSnapshot({
                projectKey: 'machine-a:/Users/tester/repo',
                repo: {
                    isRepo: true,
                    rootPath: '/Users/tester/repo',
                    backendId: 'git',
                    mode: '.git',
                    worktrees: [{ path: '/Users/tester/repo', branch: 'main', isCurrent: true }],
                },
            }),
        });

        await expect(Promise.all([firstPromise, secondPromise])).resolves.toEqual([
            expect.objectContaining({
                projectKey: 'machine-a:/Users/tester/repo',
            }),
            expect.objectContaining({
                projectKey: 'machine-a:/Users/tester/repo',
            }),
        ]);
        expect(machineScmStatusSnapshot).not.toHaveBeenCalled();
    });

    it('caches the last normalized machine/path snapshot by repo identity', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
        } as any);
        vi.mocked(machineScmStatusSnapshot).mockResolvedValue({
            success: true,
            snapshot: makeScmSnapshot({
                repo: {
                    isRepo: true,
                    rootPath: '/Users/tester/repo',
                    backendId: 'git',
                    mode: '.git',
                    worktrees: [{ path: '/Users/tester/repo', branch: 'main', isCurrent: true }],
                },
            }),
        } as any);

        const service = new ScmRepositoryService();
        const result = await service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        });

        expect(service.readCachedSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        })).toEqual(result);
    });

    it('returns a cached repo snapshot when reading from a subdirectory path within the same repo', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
        } as any);
        vi.mocked(machineScmStatusSnapshot).mockResolvedValue({
            success: true,
            snapshot: makeScmSnapshot({
                projectKey: '',
                repo: {
                    isRepo: true,
                    rootPath: '/Users/tester/repo',
                    backendId: 'git',
                    mode: '.git',
                    worktrees: [{ path: '/Users/tester/repo', branch: 'main', isCurrent: true }],
                },
            }),
        } as any);

        const service = new ScmRepositoryService();
        const result = await service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        });

        expect(service.readCachedSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo/subdir',
        })).toEqual(result);
    });

    it('stores machine/path snapshots under the canonical repo root identity key when the request is a subdirectory', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
        } as any);
        vi.mocked(machineScmStatusSnapshot).mockResolvedValue({
            success: true,
            snapshot: makeScmSnapshot({
                projectKey: '',
                repo: {
                    isRepo: true,
                    rootPath: '/Users/tester/repo',
                    backendId: 'git',
                    mode: '.git',
                    worktrees: [{ path: '/Users/tester/repo', branch: 'main', isCurrent: true }],
                },
            }),
        } as any);

        const service = new ScmRepositoryService();
        const result = await service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo/subdir',
        });

        expect(result?.projectKey).toBe('machine-a:/Users/tester/repo');
        expect(service.readCachedSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        })).toEqual(result);
    });

    it('does not rely on aliased cache entries surviving forever (alias eviction falls back to prefix-scan)', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
        } as any);
        vi.mocked(machineScmStatusSnapshot).mockResolvedValue({
            success: true,
            snapshot: makeScmSnapshot({
                projectKey: '',
                repo: {
                    isRepo: true,
                    rootPath: '/Users/tester/repo',
                    backendId: 'git',
                    mode: '.git',
                    worktrees: [{ path: '/Users/tester/repo', branch: 'main', isCurrent: true }],
                },
            }),
        } as any);

        const service = new ScmRepositoryService({ maxAliasEntries: 1 });
        const result = await service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        });

        expect(service.readCachedSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo/subdir-a',
        })).toEqual(result);
        expect(service.readCachedSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo/subdir-b',
        })).toEqual(result);
        // subdir-a alias may have been evicted, but read should still resolve via prefix scan.
        expect(service.readCachedSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo/subdir-a',
        })).toEqual(result);
    });
});
