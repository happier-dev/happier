import { describe, expect, it, vi, afterEach } from 'vitest';

const runScmCommandMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());

vi.mock('../../../runtime', () => ({
    runScmCommand: (...args: unknown[]) => runScmCommandMock(...args),
}));

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return {
        ...actual,
        mkdir: (...args: unknown[]) => mkdirMock(...args),
    };
});

describe('git worktree operations', () => {
    afterEach(() => {
        runScmCommandMock.mockReset();
        mkdirMock.mockReset();
    });

    it('fails closed before invoking git when the base ref starts with a dash', async () => {
        const { gitWorktreeCreate } = await import('./worktreeOperations');

        const response = await gitWorktreeCreate({
            context: {
                cwd: '/repo',
                projectKey: 'project',
                detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
            },
            request: {
                cwd: '/repo',
                displayName: 'feature-auth',
                baseRef: '--bad-ref',
            },
        });

        expect(response.success).toBe(false);
        expect(response.error).toContain('Invalid Git base ref');
        expect(runScmCommandMock).not.toHaveBeenCalled();
        expect(mkdirMock).not.toHaveBeenCalled();
    });

    it('creates a git worktree from the repository root and falls back to a suffixed name when needed', async () => {
        runScmCommandMock
            .mockResolvedValueOnce({ success: true, stdout: '.git\n', stderr: '' })
            .mockResolvedValueOnce({ success: true, stdout: '/repo-linked\n', stderr: '' })
            .mockResolvedValueOnce({ success: true, stdout: '/repo/.git\n', stderr: '' })
            .mockResolvedValueOnce({ success: true, stdout: 'abc123\n', stderr: '' })
            .mockResolvedValueOnce({ success: false, stdout: '', stderr: 'already exists' })
            .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' });
        mkdirMock.mockResolvedValue(undefined);

        const { gitWorktreeCreate } = await import('./worktreeOperations');

        const response = await gitWorktreeCreate({
            context: {
                cwd: '/repo-linked/packages/app',
                projectKey: 'project',
                detection: { isRepo: true, rootPath: '/repo-linked', mode: '.git' },
            },
            request: {
                cwd: '/repo-linked/packages/app',
                displayName: 'feature-auth',
            },
        });

        expect(response).toEqual({
            success: true,
            worktreePath: '/repo/.dev/worktree/feature-auth-2',
            branchName: 'feature-auth-2',
            sourceRootPath: '/repo-linked',
            repositoryRootPath: '/repo',
        });
        expect(mkdirMock).toHaveBeenCalledWith('/repo/.dev/worktree', { recursive: true });
        expect(runScmCommandMock).toHaveBeenNthCalledWith(
            5,
            expect.objectContaining({
                bin: 'git',
                cwd: '/repo',
                args: ['worktree', 'add', '-b', 'feature-auth', '--', '.dev/worktree/feature-auth', 'abc123'],
            }),
        );
        expect(runScmCommandMock).toHaveBeenNthCalledWith(
            6,
            expect.objectContaining({
                bin: 'git',
                cwd: '/repo',
                args: ['worktree', 'add', '-b', 'feature-auth-2', '--', '.dev/worktree/feature-auth-2', 'abc123'],
            }),
        );
    });

    it('creates a new worktree directly on an existing local branch without creating a new branch', async () => {
        runScmCommandMock
            .mockResolvedValueOnce({ success: true, stdout: '.git\n', stderr: '' })
            .mockResolvedValueOnce({ success: true, stdout: '/repo\n', stderr: '' })
            .mockResolvedValueOnce({ success: true, stdout: '/repo/.git\n', stderr: '' })
            .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' });
        mkdirMock.mockResolvedValue(undefined);

        const { gitWorktreeCreate } = await import('./worktreeOperations');

        const response = await gitWorktreeCreate({
            context: {
                cwd: '/repo/packages/app',
                projectKey: 'project',
                detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
            },
            request: {
                cwd: '/repo/packages/app',
                displayName: 'feature/auth',
                branchMode: 'existing',
            },
        });

        expect(response).toEqual({
            success: true,
            worktreePath: '/repo/.dev/worktree/feature/auth',
            branchName: 'feature/auth',
            sourceRootPath: '/repo',
            repositoryRootPath: '/repo',
        });
        expect(mkdirMock).toHaveBeenCalledWith('/repo/.dev/worktree', { recursive: true });
        expect(runScmCommandMock).toHaveBeenCalledTimes(4);
        expect(runScmCommandMock).toHaveBeenNthCalledWith(
            4,
            expect.objectContaining({
                bin: 'git',
                cwd: '/repo',
                args: ['worktree', 'add', '--', '.dev/worktree/feature/auth', 'feature/auth'],
            }),
        );
    });
});
