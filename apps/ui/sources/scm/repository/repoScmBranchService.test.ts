import { afterEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { machineScmBranchList } from '@/sync/ops/scm/machineScm';
import { sessionScmBranchList } from '@/sync/ops';

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: vi.fn(),
    },
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmBranchList: vi.fn(),
}));

vi.mock('@/sync/ops', () => ({
    sessionScmBranchList: vi.fn(),
}));

describe('repoScmBranchService', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('fetches repo branches for a machine/path through the canonical machine SCM layer', async () => {
        vi.mocked(storage.getState).mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
        } as any);
        vi.mocked(machineScmBranchList).mockResolvedValue({
            success: true,
            branches: [
                { name: 'main', type: 'local', isCurrent: true, upstream: 'origin/main' },
                { name: 'origin/release', type: 'remote', isCurrent: false, upstream: null },
            ],
        } as any);

        const { RepoScmBranchService } = await import('./repoScmBranchService');
        const service = new RepoScmBranchService();
        const branches = await service.fetchBranchesForMachinePath({
            machineId: 'machine-a',
            path: '~/repo',
            includeRemotes: true,
        });

        expect(machineScmBranchList).toHaveBeenCalledWith('machine-a', {
            cwd: '/Users/tester/repo',
            includeRemotes: true,
        });
        expect(branches).toEqual([
            { name: 'main', type: 'local', isCurrent: true, upstream: 'origin/main' },
            { name: 'origin/release', type: 'remote', isCurrent: false, upstream: null },
        ]);
    });

    it('deduplicates concurrent branch requests for the same machine/path and remote toggle', async () => {
        vi.mocked(storage.getState).mockReturnValue({
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
        vi.mocked(storage.getState).mockReturnValue({
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
        expect(sessionScmBranchList).not.toHaveBeenCalled();
    });

    it('deduplicates concurrent session and machine/path branch requests for the same repo identity', async () => {
        vi.mocked(storage.getState).mockReturnValue({
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
        expect(sessionScmBranchList).not.toHaveBeenCalled();

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
        vi.mocked(storage.getState).mockReturnValue({
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
        vi.mocked(machineScmBranchList).mockResolvedValue({
            success: false,
            error: 'Machine unavailable',
        } as any);
        vi.mocked(sessionScmBranchList).mockResolvedValue({
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
        expect(sessionScmBranchList).toHaveBeenCalledWith('session_1', {
            includeRemotes: false,
        });
        expect(branches).toEqual([
            { name: 'main', type: 'local', isCurrent: true, upstream: 'origin/main' },
        ]);
    });

    it('does not let an invalidated in-flight request repopulate the branch cache with stale data', async () => {
        vi.mocked(storage.getState).mockReturnValue({
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
        vi.mocked(storage.getState).mockReturnValue({
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
