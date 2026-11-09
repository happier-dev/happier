import { afterEach, describe, expect, it, vi } from 'vitest';

import { installRepositoryScmCommonModuleMocks } from './repositoryScmTestHelpers';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { machineScmBranchList } from '@/sync/ops/scm/machineScm';

const storageGetStateMock = vi.hoisted(() => vi.fn());
const sessionScmBranchListMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn());

installRepositoryScmCommonModuleMocks({
    // A stub, not importOriginal: the real storage graph reaches this service's own resolver, which
    // would then bind the real store instead of this fixture (and costs a full app-graph load).
    storage: async () => createStorageModuleStub({
        storage: {
            getState: storageGetStateMock,
        },
    }),
});

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmBranchList: vi.fn(),
}));

vi.mock('@/sync/ops', () => ({
    sessionScmBranchList: (...args: unknown[]) => sessionScmBranchListMock(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdMock(sessionId),
}));

describe('repoScmBranchService', () => {
    function createSessionBranchState(): Record<string, unknown> {
        return {
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    active: true,
                    activeAt: 42,
                    metadata: {
                        homeDir: '/Users/tester',
                        host: 'mbp.local',
                    },
                },
            },
            sessions: {
                session_1: {
                    id: 'session_1',
                    active: false,
                    updatedAt: 100,
                    metadata: {
                        machineId: 'machine-a',
                        path: '~/repo',
                        host: 'mbp.local',
                    },
                },
            },
        };
    }

    afterEach(() => {
        storageGetStateMock.mockReset();
        storageGetStateMock.mockReturnValue({});
        sessionScmBranchListMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(undefined);
        vi.restoreAllMocks();
    });

    it('uses the selected server and Home for branch reads and cache identity', async () => {
        storageGetStateMock.mockReturnValue({});
        vi.mocked(machineScmBranchList).mockImplementation(async (_machineId, request, options) => ({
            success: true,
            branches: [{
                name: `${options?.serverId}:${request.cwd}`,
                type: 'local' as const,
                isCurrent: false,
                upstream: null,
            }],
        }));
        const { RepoScmBranchService } = await import('./repoScmBranchService');
        const service = new RepoScmBranchService();

        await service.fetchBranchesForMachinePath({
            serverId: 'server-a',
            machineId: 'machine-a',
            path: '~/repo',
            homeDir: '/Users/server-a',
        });
        await service.fetchBranchesForMachinePath({
            serverId: 'server-b',
            machineId: 'machine-a',
            path: '~/repo',
            homeDir: '/Users/server-b',
            includeRemotes: true,
        });

        expect(machineScmBranchList).toHaveBeenCalledWith(
            'machine-a',
            { cwd: '/Users/server-a/repo', includeRemotes: false },
            { serverId: 'server-a' },
        );
        expect(machineScmBranchList).toHaveBeenCalledWith(
            'machine-a',
            { cwd: '/Users/server-b/repo', includeRemotes: true },
            { serverId: 'server-b' },
        );
        expect(service.readCachedBranchesForMachinePath({
            serverId: 'server-a',
            machineId: 'machine-a',
            path: '~/repo',
            homeDir: '/Users/server-a',
        })[0]?.name).toBe('server-a:/Users/server-a/repo');
        expect(service.readCachedBranchesForMachinePath({
            serverId: 'server-b',
            machineId: 'machine-a',
            path: '~/repo',
            homeDir: '/Users/server-b',
            includeRemotes: true,
        })[0]?.name).toBe('server-b:/Users/server-b/repo');
    });

    it('deduplicates concurrent branch requests for the same machine/path and remote toggle', async () => {
        storageGetStateMock.mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
        } as any);
        const deferred = {
            resolve: (_value: any): void => {},
        };
        const branchPromise = new Promise<any>((resolve) => {
            deferred.resolve = resolve;
        });
        vi.mocked(machineScmBranchList).mockReturnValue(branchPromise as any);

        const { RepoScmBranchService } = await import('./repoScmBranchService');
        const service = new RepoScmBranchService();
        const firstPromise = service.fetchBranchesForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
            includeRemotes: false,
        });
        const secondPromise = service.fetchBranchesForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
            includeRemotes: false,
        });

        expect(machineScmBranchList).toHaveBeenCalledTimes(1);

        deferred.resolve({
            success: true,
            branches: [{ name: 'main', type: 'local', isCurrent: true, upstream: 'origin/main' }],
        });

        await expect(Promise.all([firstPromise, secondPromise])).resolves.toEqual([
            [{ name: 'main', type: 'local', isCurrent: true, upstream: 'origin/main' }],
            [{ name: 'main', type: 'local', isCurrent: true, upstream: 'origin/main' }],
        ]);
        expect(machineScmBranchList).toHaveBeenCalledTimes(1);
    });

    it('hydrates the shared machine/path branch cache when a session branch request resolves a repo identity', async () => {
        storageGetStateMock.mockReturnValue(createSessionBranchState() as any);
        vi.mocked(machineScmBranchList).mockResolvedValue({
            success: true,
            branches: [
                { name: 'main', type: 'local', isCurrent: true, upstream: 'origin/main' },
                { name: 'origin/release', type: 'remote', isCurrent: false, upstream: null },
            ],
        } as any);

        const { RepoScmBranchService } = await import('./repoScmBranchService');
        const service = new RepoScmBranchService();
        const branches = await service.fetchBranchesForSession({
            sessionId: 'session_1',
            includeRemotes: true,
        });

        expect(machineScmBranchList).toHaveBeenCalledWith('machine-a', {
            cwd: '/Users/tester/repo',
            includeRemotes: true,
        });
        expect(service.readCachedBranchesForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
            includeRemotes: true,
        })).toEqual(branches);
        expect(sessionScmBranchListMock).not.toHaveBeenCalled();
    });

    it('carries the preferred session server into machine-backed branch requests', async () => {
        storageGetStateMock.mockReturnValue(createSessionBranchState() as any);
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        vi.mocked(machineScmBranchList).mockResolvedValue({
            success: true,
            branches: [{ name: 'main', type: 'local', isCurrent: true, upstream: 'origin/main' }],
        } as any);

        const { RepoScmBranchService } = await import('./repoScmBranchService');
        const service = new RepoScmBranchService();
        const branches = await service.fetchBranchesForSession({
            sessionId: 'session_1',
            includeRemotes: true,
        });

        expect(resolvePreferredServerIdForSessionIdMock).toHaveBeenCalledWith('session_1');
        expect(machineScmBranchList).toHaveBeenCalledWith(
            'machine-a',
            {
                cwd: '/Users/tester/repo',
                includeRemotes: true,
            },
            { serverId: 'server-owned' },
        );
        expect(branches).toEqual([
            { name: 'main', type: 'local', isCurrent: true, upstream: 'origin/main' },
        ]);
    });

    it('deduplicates concurrent session and machine/path branch requests for the same repo identity', async () => {
        storageGetStateMock.mockReturnValue(createSessionBranchState() as any);
        const deferred = {
            resolve: (_value: any): void => {},
        };
        const branchPromise = new Promise<any>((resolve) => {
            deferred.resolve = resolve;
        });
        vi.mocked(machineScmBranchList).mockReturnValue(branchPromise as any);

        const { RepoScmBranchService } = await import('./repoScmBranchService');
        const service = new RepoScmBranchService();
        const firstPromise = service.fetchBranchesForSession({
            sessionId: 'session_1',
            includeRemotes: true,
        });
        const secondPromise = service.fetchBranchesForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
            includeRemotes: true,
        });

        expect(machineScmBranchList).toHaveBeenCalledTimes(1);
        expect(sessionScmBranchListMock).not.toHaveBeenCalled();

        deferred.resolve({
            success: true,
            branches: [{ name: 'main', type: 'local', isCurrent: true, upstream: 'origin/main' }],
        });

        await expect(Promise.all([firstPromise, secondPromise])).resolves.toEqual([
            [{ name: 'main', type: 'local', isCurrent: true, upstream: 'origin/main' }],
            [{ name: 'main', type: 'local', isCurrent: true, upstream: 'origin/main' }],
        ]);
    });

    it('falls back to the session branch RPC when the machine branch RPC fails for a session-scoped request', async () => {
        storageGetStateMock.mockReturnValue(createSessionBranchState() as any);
        vi.mocked(machineScmBranchList).mockResolvedValue({
            success: false,
            error: 'Machine unavailable',
        } as any);
        sessionScmBranchListMock.mockResolvedValue({
            success: true,
            branches: [
                { name: 'main', type: 'local', isCurrent: true, upstream: 'origin/main' },
            ],
        } as any);

        const { RepoScmBranchService } = await import('./repoScmBranchService');
        const service = new RepoScmBranchService();
        const branches = await service.fetchBranchesForSession({
            sessionId: 'session_1',
            includeRemotes: false,
        });

        expect(machineScmBranchList).toHaveBeenCalledWith('machine-a', {
            cwd: '/Users/tester/repo',
            includeRemotes: false,
        });
        expect(sessionScmBranchListMock).toHaveBeenCalledWith('session_1', {
            includeRemotes: false,
        });
        expect(branches).toEqual([
            { name: 'main', type: 'local', isCurrent: true, upstream: 'origin/main' },
        ]);
    });

    it('does not let an invalidated in-flight request repopulate the branch cache with stale data', async () => {
        storageGetStateMock.mockReturnValue(createSessionBranchState() as any);

        let resolveBranches:
            | ((value: {
                success: boolean;
                branches: Array<{ name: string; type: 'local'; isCurrent: true; upstream: null }>;
            }) => void)
            | undefined;
        const branchPromise = new Promise<{
            success: boolean;
            branches: Array<{ name: string; type: 'local'; isCurrent: true; upstream: null }>;
        }>((resolve) => {
            resolveBranches = resolve;
        });
        vi.mocked(machineScmBranchList).mockReturnValue(branchPromise as any);

        const { RepoScmBranchService } = await import('./repoScmBranchService');
        const service = new RepoScmBranchService();

        const pendingFetch = service.fetchBranchesForSession({
            sessionId: 'session_1',
            includeRemotes: true,
        });

        expect(machineScmBranchList).toHaveBeenCalledTimes(1);

        service.invalidateBranchesForSession({ sessionId: 'session_1' });

        resolveBranches?.({
            success: true,
            branches: [{ name: 'stale/main', type: 'local', isCurrent: true, upstream: null }],
        });

        await expect(pendingFetch).resolves.toEqual([
            { name: 'stale/main', type: 'local', isCurrent: true, upstream: null },
        ]);
        expect(service.readCachedBranchesForSession({
            sessionId: 'session_1',
            includeRemotes: true,
        })).toEqual([]);
    });

    it('keeps cached branches available after invalidation so callers can render immediately while refreshing', async () => {
        storageGetStateMock.mockReturnValue(createSessionBranchState() as any);
        vi.mocked(machineScmBranchList).mockResolvedValue({
            success: true,
            branches: [{ name: 'main', type: 'local', isCurrent: true, upstream: null }],
        } as any);

        const { RepoScmBranchService } = await import('./repoScmBranchService');
        const service = new RepoScmBranchService();

        await service.fetchBranchesForSession({
            sessionId: 'session_1',
            includeRemotes: true,
        });

        expect(service.readCachedBranchesForSession({
            sessionId: 'session_1',
            includeRemotes: true,
        })).toEqual([{ name: 'main', type: 'local', isCurrent: true, upstream: null }]);

        service.invalidateBranchesForSession({ sessionId: 'session_1' });

        expect(service.readCachedBranchesForSession({
            sessionId: 'session_1',
            includeRemotes: true,
        })).toEqual([{ name: 'main', type: 'local', isCurrent: true, upstream: null }]);
    });
});
