import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScmWorkingSnapshot as ProtocolScmWorkingSnapshot } from '@happier-dev/protocol/scm/workingSnapshot';
import { SCM_OPERATION_ERROR_CODES} from '@happier-dev/protocol/scm/operationError';
import { SCM_WORKTREES_ENRICHMENT_MAX_PATHS } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createStorageStoreMock } from '@/dev/testkit/mocks/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { StorageState } from '@/sync/store/types';
import { storage } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot as UiScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { EMPTY_SCM_CAPABILITIES } from './core/snapshotMappers';
import { ScmRepositoryService, snapshotToScmStatus } from './scmRepositoryService';

type ScmTransportRequest = Readonly<{
    machineId: string;
    method: string;
    payload: Readonly<Record<string, unknown>>;
    serverId?: string;
}>;

const { statusRpcMock, enrichmentRpcMock } = vi.hoisted(() => ({
    statusRpcMock: vi.fn<(request: ScmTransportRequest) => Promise<unknown>>(),
    enrichmentRpcMock: vi.fn<(request: ScmTransportRequest) => Promise<unknown>>(),
}));

// Mock the network and storage environment; SCM routing/admission/mapping stays real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: ScmTransportRequest) =>
        request.method === RPC_METHODS.SCM_WORKTREES_ENRICHMENT
            ? enrichmentRpcMock(request)
            : statusRpcMock(request),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

function setScmState(overrides: Partial<StorageState>) {
    const machines = overrides.machines ?? { 'machine-a': createMachineFixture({ id: 'machine-a' }) };
    const sessions = overrides.sessions ?? {};
    vi.spyOn(storage, 'getState').mockReturnValue(createStorageStoreMock({
        settings: settingsDefaults,
        ...overrides,
        machines: Object.fromEntries(Object.entries(machines).map(([id, machine]) => [
            id, createMachineFixture({ ...machine, active: machine.active ?? true }),
        ])),
        sessions: Object.fromEntries(Object.entries(sessions).map(([id, session]) => [
            id, createSessionFixture({ ...session, active: session.active ?? true }),
        ])),
    }).getState());
}

beforeEach(() => {
    setScmState({});
});

afterEach(() => {
    statusRpcMock.mockReset();
    enrichmentRpcMock.mockReset();
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
            capabilityScope: 'local-backend',
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
    it('excludes media from the rail totals while retaining the changed-file count', () => {
        const snapshot = makeSnapshot();
        const media = { ...snapshot.entries[0]!, path: 'guide.pdf' };
        expect(snapshotToScmStatus({ ...snapshot, entries: [media] })).toMatchObject({
            changedFileCount: 1, isDirty: true, includedLinesAdded: 0, includedLinesRemoved: 0,
            pendingLinesAdded: 0, pendingLinesRemoved: 0, linesAdded: 0, linesRemoved: 0, linesChanged: 0,
        });
    });

    it('derives aggregate status counters from the canonical snapshot', () => {
        const status = snapshotToScmStatus(makeSnapshot());
        expect(status.branch).toBe('main');
        expect(status.isDirty).toBe(true);
        expect(status.changedFileCount).toBe(2);
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

        const snapshot = makeSnapshot();
        const directoryOnly = snapshotToScmStatus(makeSnapshot({
            entries: [{ ...snapshot.entries[1]!, path: 'scratch/' }],
        }));
        expect(directoryOnly.changedFileCount).toBe(0);
        expect(directoryOnly.isDirty).toBe(false);
    });
});

describe('ScmRepositoryService.fetchSnapshotForSession', () => {
    it('delivers Session page demand without poisoning subsequent full reads', async () => {
        setScmState({ sessions: { session_1: createSessionFixture({ id: 'session_1',
            metadata: { machineId: 'machine-a', path: '/repo', host: 'tester.local' } }) },
            machines: { 'machine-a': createMachineFixture({ id: 'machine-a',
                operationProtocolCapabilities: { scmStatusSnapshotPaging: { protocolVersions: [1] } } }) } });
        const page = makeScmSnapshot({ entriesPage: { totalFiles: 60221, nextCursor: 1 } });
        const full = makeScmSnapshot({ entries: [page.entries[0]!, { ...page.entries[0]!, path: 'second.ts' }] });
        statusRpcMock.mockImplementation(async ({ payload }) => ({ success: true, snapshot: payload.entriesPage ? page : full }));
        const service = new ScmRepositoryService();
        const [paged, samePage] = await Promise.all([
            service.fetchSnapshotForSession('session_1', { entriesPage: { limit: 1 } }),
            service.fetchSnapshotForSession('session_1', { entriesPage: { limit: 1 } }),
        ]);
        expect(statusRpcMock).toHaveBeenCalledTimes(1);
        expect(samePage).toBe(paged);
        expect(paged?.entriesPage).toEqual(page.entriesPage);
        expect(service.readCachedSnapshotForSession('session_1')).toBeNull();
        const complete = await service.fetchSnapshotForSession('session_1');
        expect(complete?.entries).toHaveLength(2);
        expect(service.readCachedSnapshotForSession('session_1')).toBe(complete);
        expect(statusRpcMock).toHaveBeenCalledTimes(2);
    });

    it('returns null when session metadata path is unavailable', async () => {
        setScmState({
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
        expect(statusRpcMock).not.toHaveBeenCalled();
    });

    it('uses project key path when session metadata path is unavailable', async () => {
        setScmState({
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
                            rootPath: '/repo-from-project',
                        },
                    }
                    : null,
        } as any);

        statusRpcMock.mockResolvedValue({
            success: true,
            snapshot: makeScmSnapshot({
                projectKey: 'machine-a:/repo-from-project',
                repo: {
                    isRepo: true,
                    rootPath: '/repo-from-project',
                    backendId: 'git',
                    mode: '.git',
                    worktrees: [],
                    remotes: [],
                },
            }),
        } as any);

        const service = new ScmRepositoryService();
        const result = await service.fetchSnapshotForSession('session_1');
        expect(result?.projectKey).toBe('machine-a:/repo-from-project');
        expect(statusRpcMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a', method: RPC_METHODS.SCM_STATUS_SNAPSHOT,
            payload: expect.objectContaining({ cwd: '/repo-from-project', outcomeVersion: 1, operationStateVersion: 1 }),
        }));
    });

    it('throws when rpc snapshot fetch fails', async () => {
        setScmState({
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
        statusRpcMock.mockResolvedValue({
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

    it('reports a refresh failure when the transport returns a malformed response', async () => {
        setScmState({
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
        statusRpcMock.mockResolvedValue(null as any);

        const service = new ScmRepositoryService();
        await expect(service.fetchSnapshotForSession('session_1')).rejects.toMatchObject({
            scmErrorCode: SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED,
            diagnosticDetail: 'Error: SCM_UNSUPPORTED_RESPONSE_ERROR',
        });
    });

    it('keeps an unrecognized read exception in diagnostic detail rather than display copy', async () => {
        setScmState({
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
        statusRpcMock.mockRejectedValue(new Error('network glitch'));

        const service = new ScmRepositoryService();
        const thrown = await service.fetchSnapshotForSession('session_1').then(() => null, (error: unknown) => error);
        expect(thrown).toMatchObject({
            scmErrorCode: SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED,
            diagnosticDetail: 'Error: network glitch',
        });
        expect((thrown as Error).message).not.toContain('network glitch');
    });

    it('returns a safe empty snapshot when rpc success response omits snapshot payload', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_002);
        setScmState({
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
        statusRpcMock.mockResolvedValue({
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
        setScmState({
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
        statusRpcMock.mockResolvedValue({
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
        setScmState({
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
        statusRpcMock.mockResolvedValue({
            success: true,
            snapshot: makeScmSnapshot({
                repo: { isRepo: true, rootPath: '/repo', backendId: 'sapling', mode: '.sl', worktrees: [], remotes: [] },
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

        statusRpcMock.mockResolvedValue({
            success: true,
            snapshot: makeScmSnapshot({
                repo: { isRepo: true, rootPath: '/repo', backendId: 'acme.scm/stacked', mode: '.git', worktrees: [], remotes: [] },
            }),
        } as any);
        const qualified = await new ScmRepositoryService().fetchSnapshotForSession('session_1');
        expect(qualified?.repo.backendId).toBe('acme.scm/stacked');
    });

    it('preserves protocol repo metadata in the ui snapshot shape', async () => {
        setScmState({
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
        statusRpcMock.mockResolvedValue({
            success: true,
            snapshot: makeScmSnapshot({
                branch: { headOid: 'observed-head', upstreamOid: 'observed-upstream' },
                capabilities: { writeCommitUndoLast: true },
                repo: {
                    isRepo: true,
                    rootPath: '/repo',
                    backendId: 'git',
                    mode: '.git',
                    defaultBranch: 'release/2026',
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

        expect(result?.branch).toMatchObject({ headOid: 'observed-head', upstreamOid: 'observed-upstream' });
        expect(result?.capabilities?.writeCommitUndoLast).toBe(true);
        expect(result?.repo.defaultBranch).toBe('release/2026');
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

    it('routes tilde session working directories through the canonical SCM facade', async () => {
        setScmState({
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
        statusRpcMock.mockResolvedValue({
            success: true,
            snapshot: makeScmSnapshot({
                projectKey: 'machine-a:/Users/tester/repo',
                repo: { isRepo: true, rootPath: '/Users/tester/repo', backendId: 'git', mode: '.git', worktrees: [], remotes: [] },
            }),
        } as any);

        const service = new ScmRepositoryService();
        await service.fetchSnapshotForSession('session_1');

        expect(statusRpcMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a', method: RPC_METHODS.SCM_STATUS_SNAPSHOT,
            payload: expect.objectContaining({ cwd: '~/repo', outcomeVersion: 1, operationStateVersion: 1 }),
        }));
    });

    it('stores session snapshots under the canonical repo root identity key when the session path is a subdirectory', async () => {
        setScmState({
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
        statusRpcMock.mockResolvedValue({
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
        setScmState({
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
        statusRpcMock.mockResolvedValue({
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

describe('ScmRepositoryService.fetchWorktreesEnrichment', () => {
    it('uses the dedicated worktrees enrichment rpc and caches the result by machine path', async () => {
        enrichmentRpcMock.mockResolvedValue({
            success: true,
            worktrees: [
                { path: '/repo', changeCount: 4, lastActivityAt: 1_700_000_000_000 },
                { path: '/repo/.worktrees/feature', changeCount: 0, lastActivityAt: 1_699_000_000_000 },
            ],
        });

        const service = new ScmRepositoryService();
        const result = await service.fetchWorktreesEnrichment({
            machineId: 'machine-a',
            path: '/repo',
            worktreePaths: ['/repo', '/repo/.worktrees/feature'],
        });

        expect(enrichmentRpcMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a', method: RPC_METHODS.SCM_WORKTREES_ENRICHMENT,
            payload: expect.objectContaining({
                cwd: '/repo',
                worktreePaths: ['/repo', '/repo/.worktrees/feature'],
                outcomeVersion: 1,
            }),
        }));
        expect(result).toEqual([
            { path: '/repo', changeCount: 4, lastActivityAt: 1_700_000_000_000 },
            { path: '/repo/.worktrees/feature', changeCount: 0, lastActivityAt: 1_699_000_000_000 },
        ]);
        expect(service.readCachedWorktreesEnrichment({
            machineId: 'machine-a',
            path: '/repo/subdir',
            worktreePaths: ['/repo/.worktrees/feature'],
        })).toEqual([
            { path: '/repo/.worktrees/feature', changeCount: 0, lastActivityAt: 1_699_000_000_000 },
        ]);
    });

    it('stores enrichment under the canonical repo identity after a child-path snapshot resolves the repo root', async () => {
        setScmState({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
        } as any);
        statusRpcMock.mockResolvedValue({
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
        enrichmentRpcMock.mockResolvedValue({
            success: true,
            worktrees: [
                { path: '/Users/tester/repo', changeCount: 4, lastActivityAt: 1_700_000_000_000 },
            ],
        });

        const service = new ScmRepositoryService();
        await service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo/src/components',
        });
        const result = await service.fetchWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo/src/components',
            worktreePaths: ['/Users/tester/repo'],
        });

        expect(service.readCachedWorktreesEnrichment({
            machineId: 'machine-a',
            path: '~/repo',
            worktreePaths: ['/Users/tester/repo'],
        })).toEqual(result);
    });

    it('splits enrichment requests at the protocol path limit', async () => {
        enrichmentRpcMock.mockResolvedValue({
            success: true,
            worktrees: [],
        });

        const worktreePaths = Array.from(
            { length: SCM_WORKTREES_ENRICHMENT_MAX_PATHS + 1 },
            (_, index) => `/repo/.worktrees/wt-${index}`,
        );

        const service = new ScmRepositoryService();
        await service.fetchWorktreesEnrichment({
            machineId: 'machine-a',
            path: '/repo',
            worktreePaths,
        });

        expect(enrichmentRpcMock).toHaveBeenCalledTimes(2);
        expect(enrichmentRpcMock.mock.calls[0]?.[0]?.payload).toMatchObject({
            worktreePaths: worktreePaths.slice(0, SCM_WORKTREES_ENRICHMENT_MAX_PATHS),
        });
        expect(enrichmentRpcMock.mock.calls[1]?.[0]?.payload).toMatchObject({
            worktreePaths: worktreePaths.slice(SCM_WORKTREES_ENRICHMENT_MAX_PATHS),
        });
    });

    it('returns null and leaves the cache untouched when the enrichment rpc fails', async () => {
        enrichmentRpcMock.mockResolvedValue({
            success: false,
            error: 'porcelain failed',
        });

        const service = new ScmRepositoryService();
        const result = await service.fetchWorktreesEnrichment({
            machineId: 'machine-a',
            path: '/repo',
            worktreePaths: ['/repo'],
        });

        expect(result).toBeNull();
        expect(service.readCachedWorktreesEnrichment({
            machineId: 'machine-a',
            path: '/repo',
            worktreePaths: ['/repo'],
        })).toBeNull();
    });
});

describe('ScmRepositoryService.fetchSnapshotForMachinePath', () => {
    it.each([false, true])('shares identical first-page demand only until settlement (failure: %s)', async fail => {
        setScmState({ machines: { 'machine-a': createMachineFixture({ id: 'machine-a',
            operationProtocolCapabilities: { scmStatusSnapshotPaging: { protocolVersions: [1] } } }) } });
        const page = makeScmSnapshot({ repo: { rootPath: '/Users/tester/repo' },
            entriesPage: { totalFiles: 60221, nextCursor: 23 } });
        let settle!: () => void;
        const pending = new Promise<void>(resolve => { settle = resolve; });
        statusRpcMock.mockImplementation(async () => {
            await pending;
            if (fail) throw new Error('transport failed');
            return { success: true, snapshot: page };
        });
        const service = new ScmRepositoryService();
        const target = { machineId: 'machine-a', path: '~/repo' };
        const firstVisit = Promise.allSettled([
            service.fetchSnapshotForMachinePath({ ...target, entriesPage: { limit: 23 } }),
            service.fetchSnapshotForMachinePath({ ...target, entriesPage: { limit: 23 } }),
        ]);
        await vi.waitFor(() => expect(statusRpcMock).toHaveBeenCalledTimes(1));
        settle();
        const results = await firstVisit;
        expect(results.map(result => result.status)).toEqual(fail ? ['rejected', 'rejected'] : ['fulfilled', 'fulfilled']);
        if (!fail) {
            expect(results[0]).toMatchObject({ value: { entriesPage: { totalFiles: 60221, nextCursor: 23 } } });
        }
        expect(service.readCachedSnapshotForMachinePath(target)).toBeNull();
        await service.fetchSnapshotForMachinePath({ ...target, entriesPage: { limit: 23 } }).catch(() => null);
        expect(statusRpcMock).toHaveBeenCalledTimes(2);
    });

    it('keeps different pages and full reads independent without retaining pages in the cache', async () => {
        setScmState({ machines: { 'machine-a': createMachineFixture({ id: 'machine-a',
            operationProtocolCapabilities: { scmStatusSnapshotPaging: { protocolVersions: [1] } } }) } });
        const page = makeScmSnapshot({ projectKey: '', repo: { rootPath: '/Users/tester/repo' },
            entriesPage: { totalFiles: 60221, nextCursor: 1 } });
        const full = makeScmSnapshot({ projectKey: '', repo: { rootPath: '/Users/tester/repo' },
            entries: [page.entries[0]!, { ...page.entries[0]!, path: 'second.ts' }] });
        statusRpcMock.mockImplementation(async ({ payload }) => ({ success: true, snapshot: payload.entriesPage ? page : full }));
        const service = new ScmRepositoryService();
        const target = { machineId: 'machine-a', path: '~/repo' };
        const [paged, complete] = await Promise.all([
            service.fetchSnapshotForMachinePath({ ...target, entriesPage: { limit: 1 } }),
            service.fetchSnapshotForMachinePath(target),
            service.fetchSnapshotForMachinePath({ ...target, entriesPage: { limit: 1, cursor: 1 } }),
        ]);
        expect(paged?.entriesPage).toEqual({ totalFiles: 60221, nextCursor: 1 });
        expect(paged?.entries).toHaveLength(1);
        expect(complete?.entries).toHaveLength(2);
        expect(service.readCachedSnapshotForMachinePath({ ...target, path: '~/repo/sub' })).toBe(complete);
        await service.fetchSnapshotForMachinePath({ ...target, entriesPage: { limit: 1, cursor: 1, path: 'second.ts' } });
        expect(statusRpcMock).toHaveBeenCalledTimes(4);
        expect(service.readCachedSnapshotForMachinePath(target)).toBe(complete);
        expect(statusRpcMock.mock.calls[3]?.[0].payload.entriesPage).toEqual({ limit: 1, cursor: 1, path: 'second.ts' });
    });

    it('does not retain a standalone page as a complete snapshot', async () => {
        setScmState({ machines: { 'machine-a': createMachineFixture({ id: 'machine-a',
            operationProtocolCapabilities: { scmStatusSnapshotPaging: { protocolVersions: [1] } } }) } });
        statusRpcMock.mockResolvedValue({ success: true, snapshot: makeScmSnapshot({ repo: { rootPath: '/Users/tester/repo' },
            entriesPage: { totalFiles: 60221, nextCursor: 1 } }) });
        const service = new ScmRepositoryService();
        await service.fetchSnapshotForMachinePath({ machineId: 'machine-a', path: '~/repo', entriesPage: { limit: 1 } });
        expect(service.readCachedSnapshotForMachinePath({ machineId: 'machine-a', path: '~/repo' })).toBeNull();
    });

    it('scopes target-Home reads and caches by server when machine ids collide', async () => {
        setScmState({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: { homeDir: '/wrong-active-home' },
                },
            },
        } as any);
        statusRpcMock.mockImplementation(async ({ serverId }) => ({
            success: true,
            snapshot: makeScmSnapshot({
                projectKey: '',
                repo: {
                    isRepo: true,
                    rootPath: '/Users/shared/repo',
                    backendId: 'git',
                    mode: '.git',
                    worktrees: [],
                },
                branch: {
                    head: serverId === 'server-a' ? 'from-a' : 'from-b',
                    upstream: null,
                    ahead: 0,
                    behind: 0,
                    detached: false,
                },
            }),
        } as any));

        const service = new ScmRepositoryService();
        await service.fetchSnapshotForMachinePath({
            serverId: 'server-a',
            machineId: 'machine-a',
            path: '~/repo',
            homeDir: '/Users/shared',
        });
        await service.fetchSnapshotForMachinePath({
            serverId: 'server-b',
            machineId: 'machine-a',
            path: '~/repo',
            homeDir: '/Users/shared',
        });

        expect(statusRpcMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-a', method: RPC_METHODS.SCM_STATUS_SNAPSHOT, serverId: 'server-a',
            payload: expect.objectContaining({ cwd: '/Users/shared/repo', outcomeVersion: 1, operationStateVersion: 1 }),
        }));
        expect(statusRpcMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-a', method: RPC_METHODS.SCM_STATUS_SNAPSHOT, serverId: 'server-b',
            payload: expect.objectContaining({ cwd: '/Users/shared/repo', outcomeVersion: 1, operationStateVersion: 1 }),
        }));
        expect(service.readCachedSnapshotForMachinePath({
            serverId: 'server-a',
            machineId: 'machine-a',
            path: '~/repo',
            homeDir: '/Users/shared',
        })?.branch.head).toBe('from-a');
        expect(service.readCachedSnapshotForMachinePath({
            serverId: 'server-b',
            machineId: 'machine-a',
            path: '~/repo',
            homeDir: '/Users/shared',
        })?.branch.head).toBe('from-b');
    });

    it('normalizes projectKey to the repo root when the request path is a subdirectory and the backend omits projectKey', async () => {
        setScmState({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
        } as any);
        statusRpcMock.mockResolvedValue({
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

        expect(statusRpcMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a', method: RPC_METHODS.SCM_STATUS_SNAPSHOT,
            payload: expect.objectContaining({ cwd: '/Users/tester/repo/subdir', outcomeVersion: 1, operationStateVersion: 1 }),
        }));
        expect(result?.projectKey).toBe('machine-a:/Users/tester/repo');
        expect(result?.repo.rootPath).toBe('/Users/tester/repo');
        expect(service.readCachedSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        })).toEqual(result);
    });

    it('normalizes repo root paths before building the canonical projectKey', async () => {
        setScmState({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
        } as any);
        statusRpcMock.mockResolvedValue({
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

    it('deduplicates concurrent machine/path snapshot requests before subdirectory aliases are known', async () => {
        setScmState({
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
        statusRpcMock.mockReturnValue(snapshotPromise as any);

        const service = new ScmRepositoryService();
        const rootPromise = service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        });
        const childPromise = service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo/subdir',
        });

        expect(statusRpcMock).toHaveBeenCalledTimes(1);

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
        expect(statusRpcMock).toHaveBeenCalledTimes(1);
    });

    it('waits for an in-flight sibling path snapshot before issuing another first snapshot', async () => {
        setScmState({
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
        statusRpcMock.mockReturnValue(snapshotPromise as any);

        const service = new ScmRepositoryService();
        const packageAPromise = service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo/packages/package-a',
        });
        const packageBPromise = service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo/packages/package-b',
        });

        expect(statusRpcMock).toHaveBeenCalledTimes(1);

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
        expect(statusRpcMock).toHaveBeenCalledTimes(1);
    });

    it('does not wait for sibling repository paths that only share a Windows home directory', async () => {
        setScmState({
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
        statusRpcMock.mockReturnValue(snapshotPromise as any);

        const service = new ScmRepositoryService();
        void service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~\\repo-a',
        });
        void service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~\\repo-b',
        });

        expect(statusRpcMock).toHaveBeenCalledTimes(2);
    });

    it('does not deduplicate concurrent lightweight and enriched machine/path snapshot requests', async () => {
        setScmState({
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

        statusRpcMock
            .mockResolvedValueOnce({ success: true, snapshot: lightweightSnapshot } as any)
            .mockResolvedValueOnce({ success: true, snapshot: enrichedSnapshot } as any);

        const service = new ScmRepositoryService();
        const [lightweight, enriched] = await Promise.all([
            service.fetchSnapshotForMachinePath({
                machineId: 'machine-a',
                path: '~/repo',
            }),
            service.fetchSnapshotForMachinePath({
                machineId: 'machine-a',
                path: '~/repo',
                includeWorktreeStatus: true,
            }),
        ]);

        expect(statusRpcMock).toHaveBeenCalledTimes(2);
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

    it('deduplicates concurrent session and machine/path snapshot requests for the same repo identity', async () => {
        setScmState({
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
        statusRpcMock.mockReturnValue(snapshotPromise as any);

        const service = new ScmRepositoryService();
        const firstPromise = service.fetchSnapshotForSession('session_1');
        const secondPromise = service.fetchSnapshotForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
        });

        expect(statusRpcMock).toHaveBeenCalledTimes(1);

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
        expect(statusRpcMock).toHaveBeenCalledTimes(1);
    });

    it('reads repository facts without the changed-file list and never serves them to a full reader', async () => {
        setScmState({ machines: { 'machine-a': { id: 'machine-a', metadata: { homeDir: '/Users/tester' } } } } as any);
        const repo = { isRepo: true, rootPath: '/Users/tester/repo', backendId: 'git' as const, mode: '.git' as const,
            worktrees: [{ path: '/Users/tester/repo', branch: 'main', isCurrent: true }] };
        statusRpcMock.mockImplementation(async (request) => ({ success: true, snapshot: request.payload.detail === 'facts'
            ? makeScmSnapshot({ projectKey: '', repo, entries: [], detail: 'facts' })
            : makeScmSnapshot({ projectKey: '', repo }) }));

        const service = new ScmRepositoryService();
        const facts = await service.fetchSnapshotForMachinePath({ machineId: 'machine-a', path: '~/repo', detail: 'facts' });
        expect(statusRpcMock).toHaveBeenCalledTimes(1);
        expect(statusRpcMock.mock.calls[0]?.[0].payload).toMatchObject({ detail: 'facts' });
        expect(facts?.repo.rootPath).toBe('/Users/tester/repo');
        expect(facts?.detail).toBe('facts');
        // Explicit incompleteness: a reader of the changed files never receives the facts read.
        expect(service.readCachedSnapshotForMachinePath({ machineId: 'machine-a', path: '~/repo' })).toBeNull();
        expect(service.readCachedSnapshotForMachinePath({ machineId: 'machine-a', path: '~/repo', detail: 'facts' })).toEqual(facts);

        const full = await service.fetchSnapshotForMachinePath({ machineId: 'machine-a', path: '~/repo' });
        expect(statusRpcMock).toHaveBeenCalledTimes(2);
        expect(statusRpcMock.mock.calls[1]?.[0].payload).not.toHaveProperty('detail');
        expect(full?.entries).toHaveLength(1);
        expect(full?.detail).toBeUndefined();
        // A full snapshot answers a later facts reader without another Machine read.
        expect(service.readCachedSnapshotForMachinePath({ machineId: 'machine-a', path: '~/repo/sub', detail: 'facts' })).toEqual(full);
    });

    it('answers a concurrent facts read from an in-flight full read, but never the reverse', async () => {
        setScmState({ machines: { 'machine-a': { id: 'machine-a', metadata: { homeDir: '/Users/tester' } } } } as any);
        const repo = { isRepo: true, rootPath: '/Users/tester/repo', backendId: 'git' as const, mode: '.git' as const, worktrees: [] };
        statusRpcMock.mockImplementation(async (request) => ({ success: true, snapshot: request.payload.detail === 'facts'
            ? makeScmSnapshot({ projectKey: '', repo, entries: [], detail: 'facts' })
            : makeScmSnapshot({ projectKey: '', repo }) }));

        const service = new ScmRepositoryService();
        const [full, facts] = await Promise.all([
            service.fetchSnapshotForMachinePath({ machineId: 'machine-a', path: '~/repo' }),
            service.fetchSnapshotForMachinePath({ machineId: 'machine-a', path: '~/repo', detail: 'facts' }),
        ]);
        expect(statusRpcMock).toHaveBeenCalledTimes(1);
        expect(facts).toBe(full);

        statusRpcMock.mockClear();
        const second = new ScmRepositoryService();
        const [facts2, full2] = await Promise.all([
            second.fetchSnapshotForMachinePath({ machineId: 'machine-a', path: '~/repo', detail: 'facts' }),
            second.fetchSnapshotForMachinePath({ machineId: 'machine-a', path: '~/repo' }),
        ]);
        expect(statusRpcMock).toHaveBeenCalledTimes(2);
        expect(facts2?.detail).toBe('facts');
        expect(full2?.entries).toHaveLength(1);
    });

    it('returns a cached repo snapshot when reading from a subdirectory path within the same repo', async () => {
        setScmState({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
        } as any);
        statusRpcMock.mockResolvedValue({
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

    it('does not rely on aliased cache entries surviving forever (alias eviction falls back to prefix-scan)', async () => {
        setScmState({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
        } as any);
        statusRpcMock.mockResolvedValue({
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
