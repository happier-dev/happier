import { describe, expect, it, vi, afterEach } from 'vitest';
import { SCM_OPERATION_ERROR_CODES} from '@happier-dev/protocol/scm/operationError';
import { SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN } from '@happier-dev/protocol/scm/worktrees';

import { installRepositoryScmCommonModuleMocks } from './repositoryScmTestHelpers';
import { createPartialStorageModuleMock } from '@/dev/testkit/mocks/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

const machineScmWorktreeCreateMock = vi.hoisted(() => vi.fn());
const machineScmWorktreePruneMock = vi.hoisted(() => vi.fn());
const machineScmWorktreeRemoveMock = vi.hoisted(() => vi.fn());
const storageGetStateMock = vi.hoisted(() => vi.fn(() => ({})));

function makeWorktreeSnapshot(
    repo: ScmWorkingSnapshot['repo'],
    branch: Partial<ScmWorkingSnapshot['branch']> = {},
): ScmWorkingSnapshot {
    return {
        repo,
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false, ...branch },
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
        fetchedAt: 0,
        projectKey: 'project',
        hasConflicts: false,
        entries: [],
        stashCount: 0,
    };
}

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmWorktreeCreate: (...args: unknown[]) => machineScmWorktreeCreateMock(...args),
    machineScmWorktreePrune: (...args: unknown[]) => machineScmWorktreePruneMock(...args),
    machineScmWorktreeRemove: (...args: unknown[]) => machineScmWorktreeRemoveMock(...args),
}));

installRepositoryScmCommonModuleMocks({
    storage: async (importOriginal) => createPartialStorageModuleMock(importOriginal, {
        storage: {
            getState: storageGetStateMock,
        },
    }),
});

describe('repoScmWorktreeService', () => {
    afterEach(() => {
        machineScmWorktreeCreateMock.mockReset();
        machineScmWorktreePruneMock.mockReset();
        machineScmWorktreeRemoveMock.mockReset();
        storageGetStateMock.mockReset();
        storageGetStateMock.mockReturnValue({});
    });

    it('refuses an invalid worktree request without publishing a created path or branch', async () => {
        const { repoScmWorktreeService } = await import('./repoScmWorktreeService');
        const result = await repoScmWorktreeService.createWorktreeForMachinePath({ machineId: '', path: '/repo' });

        expect(result).toMatchObject({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST });
        expect(result).not.toHaveProperty('worktreePath');
        expect(result).not.toHaveProperty('branchName');
        expect(machineScmWorktreeCreateMock).not.toHaveBeenCalled();
    });

    it('finds a reusable sibling worktree for the selected base branch while ignoring the current worktree', async () => {
        const { findReusableRepoWorktreeForBranch } = await import('./repoScmWorktreeService');

        const result = findReusableRepoWorktreeForBranch({
            snapshot: {
                repo: {
                    isRepo: true,
                    rootPath: '/repo',
                    backendId: 'git',
                    mode: '.git',
                    worktrees: [
                        { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                        { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
                    ],
                },
                branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                capabilities: {} as any,
                totals: {} as any,
                fetchedAt: 0,
                projectKey: 'project',
                hasConflicts: false,
                entries: [],
                stashCount: 0,
            } as any,
            selectedBaseRef: 'feature/auth',
            currentBranch: 'main',
            currentPath: '/repo/packages/app',
        });

        expect(result).toEqual({
            path: '/repo/.worktrees/feature-auth',
            branch: 'feature/auth',
            isCurrent: false,
        });
    });

    it('does not reuse the current worktree when the current path is home-relative', async () => {
        const { findReusableRepoWorktreeForBranch } = await import('./repoScmWorktreeService');

        const result = findReusableRepoWorktreeForBranch({
            snapshot: makeWorktreeSnapshot(
                {
                    isRepo: true,
                    rootPath: '/Users/alice/repo',
                    backendId: 'git',
                    mode: '.git',
                    worktrees: [
                        { path: '/Users/alice/repo', branch: 'main', isCurrent: true, isMain: true },
                    ],
                },
            ),
            selectedBaseRef: null,
            currentBranch: 'main',
            currentPath: '~/repo/packages/app',
            machineHomeDir: '/Users/alice',
        });

        expect(result).toBeNull();
    });

    it('reuses a local worktree when the selected base ref is a remote-tracking branch', async () => {
        const { findReusableRepoWorktreeForBranch } = await import('./repoScmWorktreeService');

        const result = findReusableRepoWorktreeForBranch({
            snapshot: makeWorktreeSnapshot(
                {
                    isRepo: true,
                    rootPath: '/repo',
                    backendId: 'git',
                    mode: '.git',
                    remotes: [{ name: 'origin' }],
                    worktrees: [
                        { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                        { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
                    ],
                },
            ),
            selectedBaseRef: 'origin/feature/auth',
            currentBranch: 'main',
            currentPath: '/repo',
        });

        expect(result).toEqual({
            path: '/repo/.worktrees/feature-auth',
            branch: 'feature/auth',
            isCurrent: false,
        });
    });

    it('prefers the longest remote-name prefix when matching remote-tracking branches', async () => {
        const { findReusableRepoWorktreeForBranch } = await import('./repoScmWorktreeService');

        const result = findReusableRepoWorktreeForBranch({
            snapshot: makeWorktreeSnapshot(
                {
                    isRepo: true,
                    rootPath: '/repo',
                    backendId: 'git',
                    mode: '.git',
                    remotes: [{ name: 'origin' }, { name: 'origin/fork' }],
                    worktrees: [
                        { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                        { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
                    ],
                },
            ),
            selectedBaseRef: 'origin/fork/feature/auth',
            currentBranch: 'main',
            currentPath: '/repo',
        });

        expect(result).toEqual({
            path: '/repo/.worktrees/feature-auth',
            branch: 'feature/auth',
            isCurrent: false,
        });
    });

    it.each([
        [
            'defaults to a new branch from the base ref',
            { baseRef: 'feature/auth' },
            { cwd: '/repo/packages/app', baseRef: 'feature/auth', branchMode: 'new', displayName: expect.any(String) },
            undefined,
        ],
        [
            'keeps explicit server scope',
            { baseRef: 'feature/auth', serverId: 'server-b' },
            expect.objectContaining({ cwd: '/repo/packages/app', baseRef: 'feature/auth' }),
            { serverId: 'server-b' },
        ],
        [
            'forwards existing-branch creation',
            { displayName: 'feature/auth', branchMode: 'existing' as const },
            { cwd: '/repo/packages/app', displayName: 'feature/auth', branchMode: 'existing' },
            undefined,
        ],
    ])('delegates worktree creation to the canonical machine SCM worktree RPC: %s', async (_title, input, expectedRequest, expectedOptions) => {
        machineScmWorktreeCreateMock.mockResolvedValue({
            success: true,
            reused: false,
            worktreePath: '/repo/.dev/worktree/feature-auth',
            branchName: 'feature-auth',
            repositoryRootPath: '/repo',
            sourceRootPath: '/repo',
        });

        const { repoScmWorktreeService } = await import('./repoScmWorktreeService');
        const result = await repoScmWorktreeService.createWorktreeForMachinePath({
            machineId: 'machine-1',
            path: '/repo/packages/app',
            ...input,
        });

        expect(machineScmWorktreeCreateMock).toHaveBeenCalledWith(
            'machine-1',
            expectedRequest,
            ...(expectedOptions ? [expectedOptions] : []),
        );
        expect(result.success).toBe(true);
    });

    it('resolves tilde machine paths to absolute paths using the machine homeDir before invoking the worktree RPC', async () => {
        storageGetStateMock.mockReturnValue({
            machines: {
                'machine-1': {
                    id: 'machine-1',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
        } as any);
        machineScmWorktreeCreateMock.mockResolvedValue({
            success: true,
            reused: false,
            worktreePath: '/Users/tester/repo/.dev/worktree/feature-auth',
            branchName: 'feature-auth',
            repositoryRootPath: '/Users/tester/repo',
            sourceRootPath: '/Users/tester/repo',
        });

        const { repoScmWorktreeService } = await import('./repoScmWorktreeService');
        await repoScmWorktreeService.createWorktreeForMachinePath({
            machineId: 'machine-1',
            path: '~/repo/packages/app',
            baseRef: 'feature/auth',
        });

        expect(machineScmWorktreeCreateMock).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({
                cwd: '/Users/tester/repo/packages/app',
                baseRef: 'feature/auth',
            }),
        );
    });

    it('removes and prunes worktrees through canonical machine SCM requests', async () => {
        machineScmWorktreeRemoveMock.mockResolvedValue({ success: true, stdout: '', stderr: '' });
        machineScmWorktreePruneMock.mockResolvedValue({ success: true, stdout: '', stderr: '' });

        const { repoScmWorktreeService } = await import('./repoScmWorktreeService');
        const removeResult = await repoScmWorktreeService.removeWorktreeForMachinePath({
            serverId: 'server-b',
            machineId: 'machine-1',
            path: '/repo',
            worktreePath: '/repo/.worktrees/feature-auth',
        });
        const pruneResult = await repoScmWorktreeService.pruneWorktreesForMachinePath({
            serverId: 'server-b',
            machineId: 'machine-1',
            path: '/repo',
        });

        expect(machineScmWorktreeRemoveMock).toHaveBeenCalledWith(
            'machine-1',
            {
                cwd: '/repo',
                worktreePath: '/repo/.worktrees/feature-auth',
                confirmed: true,
                authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN,
            },
            { serverId: 'server-b' },
        );
        expect(machineScmWorktreePruneMock).toHaveBeenCalledWith(
            'machine-1',
            {
                cwd: '/repo',
            },
            { serverId: 'server-b' },
        );
        expect(removeResult.success).toBe(true);
        expect(pruneResult.success).toBe(true);
    });
});
