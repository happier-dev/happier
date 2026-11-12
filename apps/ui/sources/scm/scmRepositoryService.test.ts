import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ScmWorkingSnapshot as ProtocolScmWorkingSnapshot } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { sessionScmStatusSnapshot } from '@/sync/ops';
import { machineScmStatusSnapshot, machineScmWorktreesEnrichment } from '@/sync/ops/scm/machineScm';
import { storage } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot as UiScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { EMPTY_SCM_CAPABILITIES } from './core/snapshotMappers';
import { ScmRepositoryService, snapshotToScmStatus } from './scmRepositoryService';

vi.mock('@/sync/ops', () => ({
    sessionScmStatusSnapshot: vi.fn(),
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmStatusSnapshot: vi.fn(),
    machineScmWorktreesEnrichment: vi.fn(),
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

type ProtocolScmSnapshotOverrides = Partial<
    Omit<ProtocolScmWorkingSnapshot, 'repo' | 'capabilities' | 'branch' | 'totals'>
> & {
    repo?: Partial<ProtocolScmWorkingSnapshot['repo']>;
    capabilities?: Partial<ProtocolScmWorkingSnapshot['capabilities']>;
    branch?: Partial<ProtocolScmWorkingSnapshot['branch']>;
    totals?: Partial<ProtocolScmWorkingSnapshot['totals']>;
};

function makeScmSnapshot(partial?: ProtocolScmSnapshotOverrides): ProtocolScmWorkingSnapshot {
    const base: ProtocolScmWorkingSnapshot = {
        projectKey: 'machine:/repo',
        fetchedAt: 123,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', worktrees: [], remotes: [] },
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
    };

    return {
        ...base,
        ...partial,
        repo: {
            ...base.repo,
            ...(partial?.repo ?? {}),
        },
        capabilities: {
            ...base.capabilities,
            ...(partial?.capabilities ?? {}),
        },
        branch: {
            ...base.branch,
            ...(partial?.branch ?? {}),
        },
        totals: {
            ...base.totals,
            ...(partial?.totals ?? {}),
        },
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
    it('preserves hosting provider and pull request projections from protocol snapshots', async () => {
        const normalized = await Promise.resolve(
            makeScmSnapshot({
                repo: {
                    defaultBranch: 'release/2026',
                },
                hostingProvider: {
                    kind: 'github',
                    name: 'GitHub',
                    baseUrl: 'https://github.com',
                    nameWithOwner: 'happier/dev',
                    remoteName: 'origin',
                },
                pullRequest: {
                    provider: {
                        kind: 'github',
                        name: 'GitHub',
                        baseUrl: 'https://github.com',
                        nameWithOwner: 'happier/dev',
                        remoteName: 'origin',
                    },
                    number: 42,
                    title: 'Add PR workflow',
                    url: 'https://github.com/happier/dev/pull/42',
                    baseBranch: 'main',
                    headBranch: 'feature/prs',
                    state: 'open',
                },
            })
        );

        const { normalizeWorkingSnapshotForUi } = await import('./scmRepositoryService');
        const result = normalizeWorkingSnapshotForUi(normalized, 'machine:/repo');

        expect(result.repo.defaultBranch).toBe('release/2026');
        expect((result as { hostingProvider?: unknown }).hostingProvider).toEqual({
            kind: 'github',
            name: 'GitHub',
            baseUrl: 'https://github.com',
            nameWithOwner: 'happier/dev',
            remoteName: 'origin',
        });
        expect((result as { pullRequest?: unknown }).pullRequest).toEqual({
            provider: {
                kind: 'github',
                name: 'GitHub',
                baseUrl: 'https://github.com',
                nameWithOwner: 'happier/dev',
                remoteName: 'origin',
            },
            number: 42,
            title: 'Add PR workflow',
            url: 'https://github.com/happier/dev/pull/42',
            baseBranch: 'main',
            headBranch: 'feature/prs',
            state: 'open',
        });
    });

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
        expect(sessionScmStatusSnapshot).toHaveBeenCalledWith('session_1', {
            includeEntries: false,
            untrackedFiles: 'normal',
        });
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

    it('preserves protocol repo metadata in the ui snapshot shape', async () => {
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
                    remotes: [
                        {
                            name: 'origin',
                            fetchUrl: 'git@example.com:repo.git',
                            pushUrl: 'git@example.com:repo.git',
                        },
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
        expect(result?.repo.remotes).toEqual([
            {
                name: 'origin',
                fetchUrl: 'git@example.com:repo.git',
                pushUrl: 'git@example.com:repo.git',
            },
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

        expect(sessionScmStatusSnapshot).toHaveBeenCalledWith('session_1', {
            includeEntries: false,
            untrackedFiles: 'normal',
        });
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

        expect(result?.capabilities).toEqual(EMPTY_SCM_CAPABILITIES);
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
            includeEntries: false,
            untrackedFiles: 'normal',
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
            includeEntries: false,
            untrackedFiles: 'normal',
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

    it('deduplicates concurrent machine/path snapshot requests before subdirectory aliases are known', async () => {
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
        const rootPromise = service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        });
        const childPromise = service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo/subdir',
        });

        expect(machineScmStatusSnapshot).toHaveBeenCalledTimes(1);

        deferredSnapshot.resolve({
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
        });

        const [rootResult, childResult] = await Promise.all([rootPromise, childPromise]);
        expect(rootResult).toEqual(childResult);
        expect(rootResult?.projectKey).toBe('machine-a:/Users/tester/repo');
        expect(machineScmStatusSnapshot).toHaveBeenCalledTimes(1);
    });

    it('waits for an in-flight sibling path snapshot before issuing another first snapshot', async () => {
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
        const packageAPromise = service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo/packages/package-a',
        });
        const packageBPromise = service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo/packages/package-b',
        });

        expect(machineScmStatusSnapshot).toHaveBeenCalledTimes(1);

        deferredSnapshot.resolve({
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
        });

        const [packageAResult, packageBResult] = await Promise.all([packageAPromise, packageBPromise]);
        expect(packageAResult).toEqual(packageBResult);
        expect(packageAResult?.projectKey).toBe('machine-a:/Users/tester/repo');
        expect(machineScmStatusSnapshot).toHaveBeenCalledTimes(1);
    });

    it('does not wait for sibling repository paths that only share a Windows home directory', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: 'C:\\Users\\tester',
                    },
                },
            },
        } as any);

        const snapshotPromise = new Promise<any>(() => {});
        vi.mocked(machineScmStatusSnapshot).mockReturnValue(snapshotPromise as any);

        const service = new ScmRepositoryService();
        void service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~\\repo-a',
        });
        void service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~\\repo-b',
        });

        expect(machineScmStatusSnapshot).toHaveBeenCalledTimes(2);
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

    it('forwards includeWorktreeStatus=true to the underlying machine SCM RPC', async () => {
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
        await service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
            includeWorktreeStatus: true,
        });

        expect(machineScmStatusSnapshot).toHaveBeenCalledWith('machine-a', {
            cwd: '/Users/tester/repo',
            includeWorktreeStatus: true,
            includeEntries: false,
            untrackedFiles: 'normal',
        });
    });

    it('isolates the cache so enriched and lightweight snapshots for the same repo do not collide', async () => {
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

        const lightweightSnapshot = makeScmSnapshot({
            repo: {
                isRepo: true,
                rootPath: '/Users/tester/repo',
                backendId: 'git',
                mode: '.git',
                worktrees: [{ path: '/Users/tester/repo', branch: 'main', isCurrent: true }],
            },
        });
        const enrichedSnapshot = makeScmSnapshot({
            repo: {
                isRepo: true,
                rootPath: '/Users/tester/repo',
                backendId: 'git',
                mode: '.git',
                worktrees: [
                    {
                        path: '/Users/tester/repo',
                        branch: 'main',
                        isCurrent: true,
                        changeCount: 4,
                        lastActivityAt: 1_700_000_000_000,
                    },
                ],
            },
        });

        vi.mocked(machineScmStatusSnapshot)
            .mockResolvedValueOnce({ success: true, snapshot: lightweightSnapshot } as any)
            .mockResolvedValueOnce({ success: true, snapshot: enrichedSnapshot } as any);

        const service = new ScmRepositoryService();
        const lightweight = await service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        });
        const enriched = await service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
            includeWorktreeStatus: true,
        });

        // Both calls must hit the network — the cache must NOT collide.
        expect(machineScmStatusSnapshot).toHaveBeenCalledTimes(2);
        // Each cache namespace must return its own snapshot.
        expect(service.readCachedSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        })).toEqual(lightweight);
        expect(service.readCachedSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
            includeWorktreeStatus: true,
        })).toEqual(enriched);
        expect(enriched?.repo.worktrees?.[0]?.changeCount).toBe(4);
        expect(lightweight?.repo.worktrees?.[0]?.changeCount).toBeUndefined();
    });

    it('returns the enriched cached snapshot for a subdirectory path (no double suffix collision)', async () => {
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

        const enrichedSnapshot = makeScmSnapshot({
            projectKey: '',
            repo: {
                isRepo: true,
                rootPath: '/Users/tester/repo',
                backendId: 'git',
                mode: '.git',
                worktrees: [
                    {
                        path: '/Users/tester/repo',
                        branch: 'main',
                        isCurrent: true,
                        changeCount: 7,
                        lastActivityAt: 1_700_000_000_000,
                    },
                ],
            },
        });

        vi.mocked(machineScmStatusSnapshot).mockResolvedValue({
            success: true,
            snapshot: enrichedSnapshot,
        } as any);

        const service = new ScmRepositoryService();
        const enriched = await service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
            includeWorktreeStatus: true,
        });
        expect(enriched).not.toBeNull();
        expect(enriched?.repo.worktrees?.[0]?.changeCount).toBe(7);

        // Reading the enriched snapshot via a child path must resolve via aliasing
        // back to the canonical enriched cache slot. It must NOT fail because the
        // resolved key already carries the enriched suffix and gets re-suffixed.
        const enrichedFromChild = service.readCachedSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo/some/nested/child',
            includeWorktreeStatus: true,
        });
        expect(enrichedFromChild).not.toBeNull();
        expect(enrichedFromChild).toEqual(enriched);
        expect(enrichedFromChild?.repo.worktrees?.[0]?.changeCount).toBe(7);
    });
});

describe('ScmRepositoryService.fetchWorktreesEnrichment', () => {
    it('returns null when machineId or path is empty', async () => {
        const service = new ScmRepositoryService();
        const empty = await service.fetchWorktreesEnrichment({
            machineId: '',
            path: '~/repo',
            worktreePaths: ['/Users/tester/repo'],
        });
        expect(empty).toBeNull();
    });

    it('calls the worktrees enrichment RPC with the resolved cwd + paths and returns merged entries', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: { homeDir: '/Users/tester' },
                },
            },
        } as any);
        vi.mocked(machineScmWorktreesEnrichment).mockResolvedValue({
            success: true,
            worktrees: [
                { path: '/Users/tester/repo', changeCount: 4, lastActivityAt: 1_700_000_000_000 },
                { path: '/Users/tester/repo-feature', changeCount: 0, lastActivityAt: 1_699_000_000_000 },
            ],
        } as any);

        const service = new ScmRepositoryService();
        const result = await service.fetchWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo',
            worktreePaths: ['/Users/tester/repo', '/Users/tester/repo-feature'],
        });

        expect(machineScmWorktreesEnrichment).toHaveBeenCalledWith('machine-a', {
            cwd: '/Users/tester/repo',
            worktreePaths: ['/Users/tester/repo', '/Users/tester/repo-feature'],
        });
        expect(result).toEqual([
            { path: '/Users/tester/repo', changeCount: 4, lastActivityAt: 1_700_000_000_000 },
            { path: '/Users/tester/repo-feature', changeCount: 0, lastActivityAt: 1_699_000_000_000 },
        ]);
    });

    it('caches the last enrichment under a status-aware namespace so subsequent reads do not hit the network', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: { homeDir: '/Users/tester' },
                },
            },
        } as any);
        vi.mocked(machineScmWorktreesEnrichment).mockResolvedValue({
            success: true,
            worktrees: [
                { path: '/Users/tester/repo', changeCount: 2, lastActivityAt: 1_700_000_000_000 },
            ],
        } as any);

        const service = new ScmRepositoryService();
        const first = await service.fetchWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo',
            worktreePaths: ['/Users/tester/repo'],
        });

        const cached = service.readCachedWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo',
        });
        expect(cached).toEqual(first);
    });

    it('reads cached enrichment through the canonical repo identity for child paths', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: { homeDir: '/Users/tester' },
                },
            },
        } as any);
        vi.mocked(machineScmStatusSnapshot).mockResolvedValue({
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
        vi.mocked(machineScmWorktreesEnrichment).mockResolvedValue({
            success: true,
            worktrees: [
                { path: '/Users/tester/repo', changeCount: 2, lastActivityAt: 1_700_000_000_000 },
            ],
        } as any);

        const service = new ScmRepositoryService();
        await service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        });
        const fetched = await service.fetchWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo',
            worktreePaths: ['/Users/tester/repo'],
        });

        expect(service.readCachedWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo/src/components',
        })).toEqual(fetched);
    });

    it('deduplicates concurrent enrichment requests for the same repo identity', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: { homeDir: '/Users/tester' },
                },
            },
        } as any);

        const deferred = { resolve: (_value: any): void => {} };
        const promise = new Promise<any>((resolve) => {
            deferred.resolve = resolve;
        });
        vi.mocked(machineScmWorktreesEnrichment).mockReturnValue(promise as any);

        const service = new ScmRepositoryService();
        const first = service.fetchWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo',
            worktreePaths: ['/Users/tester/repo'],
        });
        const second = service.fetchWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo',
            worktreePaths: ['/Users/tester/repo'],
        });

        expect(machineScmWorktreesEnrichment).toHaveBeenCalledTimes(1);

        deferred.resolve({
            success: true,
            worktrees: [
                { path: '/Users/tester/repo', changeCount: 9, lastActivityAt: 1_700_000_000_001 },
            ],
        });

        const [a, b] = await Promise.all([first, second]);
        expect(a).toEqual(b);
        expect(machineScmWorktreesEnrichment).toHaveBeenCalledTimes(1);
    });

    it('splits enrichment RPC calls at the protocol request cap', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: { homeDir: '/Users/tester' },
                },
            },
        } as any);
        vi.mocked(machineScmWorktreesEnrichment).mockImplementation(async (_machineId: string, args) => ({
            success: true,
            worktrees: args.worktreePaths.map((path) => ({ path, changeCount: 1 })),
        }) as any);

        const service = new ScmRepositoryService();
        const worktreePaths = Array.from(
            { length: 65 },
            (_value, index) => `/Users/tester/repo/wt-${index}`,
        );

        const result = await service.fetchWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo',
            worktreePaths,
        });

        expect(machineScmWorktreesEnrichment).toHaveBeenCalledTimes(2);
        expect(vi.mocked(machineScmWorktreesEnrichment).mock.calls[0]?.[1].worktreePaths).toHaveLength(64);
        expect(vi.mocked(machineScmWorktreesEnrichment).mock.calls[1]?.[1].worktreePaths).toHaveLength(1);
        expect(result?.map((entry) => entry.path)).toEqual(worktreePaths);
    });

    it('returns null when the enrichment RPC fails (back-compat: do not throw, let UI keep light snapshot)', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: { homeDir: '/Users/tester' },
                },
            },
        } as any);
        vi.mocked(machineScmWorktreesEnrichment).mockResolvedValue({
            success: false,
            error: 'command failed',
        } as any);

        const service = new ScmRepositoryService();
        const result = await service.fetchWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo',
            worktreePaths: ['/Users/tester/repo'],
        });

        expect(result).toBeNull();
    });

    // ---- F6: cache identity must be per-canonical-worktree-path, not per-repo only ----

    it('F6: concurrent enrichment requests for different path subsets each fetch and BOTH cache their entries', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: { homeDir: '/Users/tester' },
                },
            },
        } as any);

        // Two different path subsets in flight at the same time. They must both
        // execute the RPC (the in-flight key is per request set, not per repo).
        const deferredAB = { resolve: (_value: any): void => {} };
        const deferredBC = { resolve: (_value: any): void => {} };
        const promiseAB = new Promise<any>((resolve) => {
            deferredAB.resolve = resolve;
        });
        const promiseBC = new Promise<any>((resolve) => {
            deferredBC.resolve = resolve;
        });
        vi.mocked(machineScmWorktreesEnrichment)
            .mockReturnValueOnce(promiseAB as any)
            .mockReturnValueOnce(promiseBC as any);

        const service = new ScmRepositoryService();
        const ab = service.fetchWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo',
            worktreePaths: ['/Users/tester/repo/a', '/Users/tester/repo/b'],
        });
        const bc = service.fetchWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo',
            worktreePaths: ['/Users/tester/repo/b', '/Users/tester/repo/c'],
        });

        // Both must trigger an RPC (the in-flight key MUST disambiguate by path set).
        expect(machineScmWorktreesEnrichment).toHaveBeenCalledTimes(2);

        deferredAB.resolve({
            success: true,
            worktrees: [
                { path: '/Users/tester/repo/a', changeCount: 1, lastActivityAt: 1 },
                { path: '/Users/tester/repo/b', changeCount: 2, lastActivityAt: 2 },
            ],
        });
        deferredBC.resolve({
            success: true,
            worktrees: [
                { path: '/Users/tester/repo/b', changeCount: 22, lastActivityAt: 22 },
                { path: '/Users/tester/repo/c', changeCount: 3, lastActivityAt: 3 },
            ],
        });

        await Promise.all([ab, bc]);

        // After both responses, the cache must contain entries for ALL THREE paths
        // (a, b, c). Either response's value of `b` is acceptable, but `a` and `c`
        // must both be present (they would be lost if the cache were per-repo only).
        const cached = service.readCachedWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo',
        });
        expect(cached).not.toBeNull();
        const byPath = new Map(cached!.map((e) => [e.path, e]));
        expect(byPath.has('/Users/tester/repo/a')).toBe(true);
        expect(byPath.has('/Users/tester/repo/b')).toBe(true);
        expect(byPath.has('/Users/tester/repo/c')).toBe(true);
    });

    it('F6: sequential requests for [a,b] then [c] merge entries — all three paths remain cached', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: { homeDir: '/Users/tester' },
                },
            },
        } as any);

        vi.mocked(machineScmWorktreesEnrichment)
            .mockResolvedValueOnce({
                success: true,
                worktrees: [
                    { path: '/Users/tester/repo/a', changeCount: 1, lastActivityAt: 10 },
                    { path: '/Users/tester/repo/b', changeCount: 2, lastActivityAt: 20 },
                ],
            } as any)
            .mockResolvedValueOnce({
                success: true,
                worktrees: [
                    { path: '/Users/tester/repo/c', changeCount: 3, lastActivityAt: 30 },
                ],
            } as any);

        const service = new ScmRepositoryService();
        await service.fetchWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo',
            worktreePaths: ['/Users/tester/repo/a', '/Users/tester/repo/b'],
        });
        await service.fetchWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo',
            worktreePaths: ['/Users/tester/repo/c'],
        });

        const cached = service.readCachedWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo',
        });
        expect(cached).not.toBeNull();
        const byPath = new Map(cached!.map((e) => [e.path, e]));
        // All three entries must be present (the second fetch must merge into,
        // not replace, the cache entries from the first fetch).
        expect(byPath.get('/Users/tester/repo/a')?.changeCount).toBe(1);
        expect(byPath.get('/Users/tester/repo/b')?.changeCount).toBe(2);
        expect(byPath.get('/Users/tester/repo/c')?.changeCount).toBe(3);
    });

    it('F6: identical concurrent requests for the same path set are still deduped (one RPC, one promise)', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: { homeDir: '/Users/tester' },
                },
            },
        } as any);

        const deferred = { resolve: (_value: any): void => {} };
        const promise = new Promise<any>((resolve) => {
            deferred.resolve = resolve;
        });
        vi.mocked(machineScmWorktreesEnrichment).mockReturnValue(promise as any);

        const service = new ScmRepositoryService();
        const a = service.fetchWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo',
            worktreePaths: ['/Users/tester/repo/a', '/Users/tester/repo/b'],
        });
        // Even with re-ordered paths, the request set is canonically the same → one RPC.
        const b = service.fetchWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo',
            worktreePaths: ['/Users/tester/repo/b', '/Users/tester/repo/a'],
        });

        expect(machineScmWorktreesEnrichment).toHaveBeenCalledTimes(1);
        deferred.resolve({
            success: true,
            worktrees: [
                { path: '/Users/tester/repo/a', changeCount: 1 },
                { path: '/Users/tester/repo/b', changeCount: 2 },
            ],
        });
        const [aResult, bResult] = await Promise.all([a, b]);
        // Each promise must resolve with its caller's requested-path subset (the
        // shape of cache reads remains: response covers only what was requested).
        expect(aResult?.length).toBeGreaterThanOrEqual(2);
        expect(bResult?.length).toBeGreaterThanOrEqual(2);
    });

    it('does not invalidate the lightweight snapshot cache when enrichment runs (separate cache slots)', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: { homeDir: '/Users/tester' },
                },
            },
        } as any);

        const lightweightSnapshot: ProtocolScmWorkingSnapshot = {
            projectKey: 'machine-a:/Users/tester/repo',
            fetchedAt: 100,
            repo: {
                isRepo: true,
                rootPath: '/Users/tester/repo',
                backendId: 'git',
                mode: '.git',
                worktrees: [{ path: '/Users/tester/repo', branch: 'main', isCurrent: true }],
                remotes: [],
            },
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
            },
            branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
            hasConflicts: false,
            entries: [],
            totals: {
                includedFiles: 0,
                pendingFiles: 0,
                untrackedFiles: 0,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        };
        vi.mocked(machineScmStatusSnapshot).mockResolvedValue({
            success: true,
            snapshot: lightweightSnapshot,
        } as any);
        vi.mocked(machineScmWorktreesEnrichment).mockResolvedValue({
            success: true,
            worktrees: [
                { path: '/Users/tester/repo', changeCount: 3, lastActivityAt: 1_700_000_000_002 },
            ],
        } as any);

        const service = new ScmRepositoryService();
        const lightweight = await service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        });
        await service.fetchWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo',
            worktreePaths: ['/Users/tester/repo'],
        });

        // The lightweight cache slot must still serve the lightweight snapshot
        // unchanged — enrichment lives in its own cache namespace.
        expect(service.readCachedSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        })).toEqual(lightweight);
    });
});

describe('mergeWorktreesEnrichmentIntoSnapshot helper', () => {
    it('merges per-path enrichment fields onto matching worktree entries (others unchanged)', async () => {
        const { mergeWorktreesEnrichmentIntoSnapshot } = await import('./scmRepositoryService');
        const snapshot: UiScmWorkingSnapshot = {
            projectKey: 'machine-a:/repo',
            fetchedAt: 1,
            repo: {
                isRepo: true,
                rootPath: '/repo',
                backendId: 'git',
                mode: '.git',
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true },
                    { path: '/repo/.worktrees/feature', branch: 'feature', isCurrent: false },
                    { path: '/repo/.worktrees/orphan', branch: 'orphan', isCurrent: false },
                ],
            },
            capabilities: EMPTY_SCM_CAPABILITIES,
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
            stashCount: 0,
            hasConflicts: false,
            entries: [],
            totals: {
                includedFiles: 0,
                pendingFiles: 0,
                untrackedFiles: 0,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        };
        const merged = mergeWorktreesEnrichmentIntoSnapshot(snapshot, [
            { path: '/repo', changeCount: 5, lastActivityAt: 1_700_000_000_000 },
            { path: '/repo/.worktrees/feature', changeCount: 0, lastActivityAt: 1_699_000_000_000 },
            { path: '/repo/.worktrees/missing-no-op', changeCount: 99 },
        ]);

        expect(merged.repo.worktrees?.[0]).toEqual({
            path: '/repo',
            branch: 'main',
            isCurrent: true,
            changeCount: 5,
            lastActivityAt: 1_700_000_000_000,
        });
        expect(merged.repo.worktrees?.[1]).toEqual({
            path: '/repo/.worktrees/feature',
            branch: 'feature',
            isCurrent: false,
            changeCount: 0,
            lastActivityAt: 1_699_000_000_000,
        });
        // Orphan worktree (no entry in enrichment) stays untouched.
        expect(merged.repo.worktrees?.[2]).toEqual({
            path: '/repo/.worktrees/orphan',
            branch: 'orphan',
            isCurrent: false,
        });
        // The original snapshot is NOT mutated.
        expect(snapshot.repo.worktrees?.[0]).toEqual({
            path: '/repo',
            branch: 'main',
            isCurrent: true,
        });
    });

    it('returns the same snapshot reference when enrichment list is empty (no-op for React equality)', async () => {
        const { mergeWorktreesEnrichmentIntoSnapshot } = await import('./scmRepositoryService');
        const snapshot: UiScmWorkingSnapshot = {
            projectKey: 'machine-a:/repo',
            fetchedAt: 1,
            repo: {
                isRepo: true,
                rootPath: '/repo',
                backendId: 'git',
                mode: '.git',
                worktrees: [{ path: '/repo', branch: 'main', isCurrent: true }],
            },
            capabilities: EMPTY_SCM_CAPABILITIES,
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
            stashCount: 0,
            hasConflicts: false,
            entries: [],
            totals: {
                includedFiles: 0,
                pendingFiles: 0,
                untrackedFiles: 0,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        };
        const merged = mergeWorktreesEnrichmentIntoSnapshot(snapshot, []);
        expect(merged).toBe(snapshot);
    });
});

// ---- FR4-13: worktree enrichment cache must be bounded (LRU eviction) ----
describe('ScmRepositoryService.fetchWorktreesEnrichment — FR4-13 bounded enrichment cache', () => {
    function machinesState(homeDirByMachineId: Record<string, string>): unknown {
        const machines: Record<string, unknown> = {};
        for (const [machineId, homeDir] of Object.entries(homeDirByMachineId)) {
            machines[machineId] = { id: machineId, metadata: { homeDir } };
        }
        return { machines };
    }

    it('evicts the oldest repo entry when more than the cap (32) distinct repos are cached', async () => {
        const homeByMachineId: Record<string, string> = {};
        for (let i = 0; i < 33; i += 1) homeByMachineId[`m-${i}`] = `/Users/u-${i}`;
        vi.spyOn(storage, 'getState').mockReturnValue(machinesState(homeByMachineId) as any);

        vi.mocked(machineScmWorktreesEnrichment).mockImplementation(async (machineId: string) => ({
            success: true,
            worktrees: [
                { path: `/Users/u-${machineId.slice(2)}/repo`, changeCount: 1, lastActivityAt: 1 },
            ],
        }) as any);

        const service = new ScmRepositoryService({ maxRepoEnrichmentCacheEntries: 32 });

        for (let i = 0; i < 33; i += 1) {
            await service.fetchWorktreesEnrichment({
                machineId: `m-${i}`,
                path: '~/repo',
                worktreePaths: [`/Users/u-${i}/repo`],
            });
        }

        // The oldest repo (m-0) should have been evicted; m-1..m-32 should still be cached.
        expect(service.readCachedWorktreesEnrichment({ machineId: 'm-0', path: '~/repo' })).toBeNull();
        for (let i = 1; i < 33; i += 1) {
            expect(service.readCachedWorktreesEnrichment({ machineId: `m-${i}`, path: '~/repo' })).not.toBeNull();
        }
    });

    it('refreshes LRU recency on a cache read so recently-read entries are not evicted next', async () => {
        const homeByMachineId: Record<string, string> = {};
        for (let i = 0; i < 33; i += 1) homeByMachineId[`m-${i}`] = `/Users/u-${i}`;
        vi.spyOn(storage, 'getState').mockReturnValue(machinesState(homeByMachineId) as any);
        vi.mocked(machineScmWorktreesEnrichment).mockImplementation(async (machineId: string) => ({
            success: true,
            worktrees: [
                { path: `/Users/u-${machineId.slice(2)}/repo`, changeCount: 1, lastActivityAt: 1 },
            ],
        }) as any);

        const service = new ScmRepositoryService({ maxRepoEnrichmentCacheEntries: 32 });

        // Fill the cache with 32 entries (m-0..m-31).
        for (let i = 0; i < 32; i += 1) {
            await service.fetchWorktreesEnrichment({
                machineId: `m-${i}`,
                path: '~/repo',
                worktreePaths: [`/Users/u-${i}/repo`],
            });
        }
        // Read m-0 to bump it to MRU.
        expect(service.readCachedWorktreesEnrichment({ machineId: 'm-0', path: '~/repo' })).not.toBeNull();

        // Insert a 33rd repo: m-32. Now LRU is m-1 (m-0 was just promoted).
        await service.fetchWorktreesEnrichment({
            machineId: 'm-32',
            path: '~/repo',
            worktreePaths: ['/Users/u-32/repo'],
        });

        expect(service.readCachedWorktreesEnrichment({ machineId: 'm-0', path: '~/repo' })).not.toBeNull();
        expect(service.readCachedWorktreesEnrichment({ machineId: 'm-1', path: '~/repo' })).toBeNull();
        expect(service.readCachedWorktreesEnrichment({ machineId: 'm-32', path: '~/repo' })).not.toBeNull();
    });

    it('caps the per-repo worktree path map so a single repo cannot grow unboundedly (default 64)', async () => {
        vi.spyOn(storage, 'getState').mockReturnValue(machinesState({ 'm-a': '/Users/tester' }) as any);

        const totalEntries = 80;
        vi.mocked(machineScmWorktreesEnrichment).mockImplementation(async (_machineId: string, args: any) => ({
            success: true,
            worktrees: args.worktreePaths.map((p: string) => ({ path: p, changeCount: 1, lastActivityAt: 1 })),
        }) as any);

        const service = new ScmRepositoryService({ maxPerRepoEnrichmentEntries: 64 });
        for (let i = 0; i < totalEntries; i += 1) {
            await service.fetchWorktreesEnrichment({
                machineId: 'm-a',
                path: '~/repo',
                worktreePaths: [`/Users/tester/repo/wt-${i}`],
            });
        }
        const cached = service.readCachedWorktreesEnrichment({ machineId: 'm-a', path: '~/repo' });
        expect(cached).not.toBeNull();
        expect(cached!.length).toBeLessThanOrEqual(64);
    });
});

describe('snapshotToScmStatus totals-first derivations', () => {
    it('derives counts from totals.changedFiles when the snapshot omits entries', () => {
        const status = snapshotToScmStatus(makeSnapshot({
            entries: [],
            totals: {
                includedFiles: 0,
                pendingFiles: 0,
                untrackedFiles: 30000,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
                changedFiles: 30000,
            },
        }));

        expect(status.untrackedCount).toBe(30000);
        expect(status.modifiedCount).toBe(0);
        expect(status.isDirty).toBe(true);
    });

    it('keeps entries-derived fallbacks for legacy snapshots without totals.changedFiles', () => {
        const status = snapshotToScmStatus(makeSnapshot());

        expect(status.modifiedCount).toBe(1);
        expect(status.untrackedCount).toBe(1);
        expect(status.isDirty).toBe(true);
    });

    it('reports a clean worktree when totals report no changes even with omitted entries', () => {
        const status = snapshotToScmStatus(makeSnapshot({
            entries: [],
            totals: {
                includedFiles: 0,
                pendingFiles: 0,
                untrackedFiles: 0,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
                changedFiles: 0,
            },
        }));

        expect(status.isDirty).toBe(false);
        expect(status.untrackedCount).toBe(0);
    });
});

describe('summary poll request shapes', () => {
    it('fetches entries-carrying snapshots on explicit request without deduping against the summary in-flight request', async () => {
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
        vi.mocked(sessionScmStatusSnapshot)
            .mockResolvedValueOnce({
                success: true,
                snapshot: makeScmSnapshot({
                    entries: [],
                    entriesPresentation: 'omitted',
                    totals: {
                        includedFiles: 0,
                        pendingFiles: 0,
                        untrackedFiles: 2,
                        includedAdded: 0,
                        includedRemoved: 0,
                        pendingAdded: 0,
                        pendingRemoved: 0,
                        changedFiles: 2,
                    },
                }),
            } as any)
            .mockResolvedValueOnce({
                success: true,
                snapshot: makeScmSnapshot({
                    entriesPresentation: 'complete',
                    totals: {
                        includedFiles: 0,
                        pendingFiles: 0,
                        untrackedFiles: 2,
                        includedAdded: 0,
                        includedRemoved: 0,
                        pendingAdded: 0,
                        pendingRemoved: 0,
                        changedFiles: 2,
                    },
                }),
            } as any);

        const service = new ScmRepositoryService();
        await service.fetchSnapshotForSession('session_1');
        const entriesSnapshot = await service.fetchSnapshotForSession('session_1', {
            includeEntries: true,
            untrackedFiles: 'normal',
        });

        expect(sessionScmStatusSnapshot).toHaveBeenCalledTimes(2);
        expect(sessionScmStatusSnapshot).toHaveBeenNthCalledWith(2, 'session_1', {
            includeEntries: true,
            untrackedFiles: 'normal',
        });
        expect(entriesSnapshot?.entriesPresentation).toBe('complete');
    });
});

describe('normalizeWorkingSnapshotForUi presentation facts', () => {
    it('passes entriesPresentation, directory-entry fields and totals.changedFiles through to the UI shape', async () => {
        const { normalizeWorkingSnapshotForUi } = await import('./scmRepositoryService');

        const normalized = normalizeWorkingSnapshotForUi(makeScmSnapshot({
            entriesPresentation: 'truncated',
            entries: [{
                path: 'D/',
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
                isDirectory: true,
                untrackedFileCount: 30000,
            }],
            totals: {
                changedFiles: 30001,
            },
        }), 'machine:/repo');

        expect(normalized.entriesPresentation).toBe('truncated');
        expect(normalized.entries[0]?.isDirectory).toBe(true);
        expect(normalized.entries[0]?.untrackedFileCount).toBe(30000);
        expect(normalized.totals.changedFiles).toBe(30001);
    });

    it('omits the optional presentation facts for legacy snapshots', async () => {
        const { normalizeWorkingSnapshotForUi } = await import('./scmRepositoryService');

        const normalized = normalizeWorkingSnapshotForUi(makeScmSnapshot(), 'machine:/repo');

        expect(normalized.entriesPresentation).toBeUndefined();
        expect(normalized.entries[0]?.isDirectory).toBeUndefined();
        expect(normalized.totals.changedFiles).toBeUndefined();
    });
});
