import { describe, expect, it, vi } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

const runScmCommand = vi.fn();

vi.mock('../../../runtime', () => ({
    runScmCommand,
}));

describe('git branch operations safety', () => {
    it('does not run `git stash pop` when transient stash was not created', async () => {
        vi.resetModules();

        let switchCalls = 0;
        runScmCommand.mockImplementation(async (input: { args: string[] }) => {
            const args = input.args;
            if (args[0] === 'switch') {
                switchCalls += 1;
                if (switchCalls === 1) {
                    return {
                        success: false,
                        stdout: '',
                        stderr: 'error: Your local changes to the following files would be overwritten by checkout',
                    };
                }
                return { success: true, stdout: 'switched', stderr: '' };
            }
            if (args[0] === 'stash' && args[1] === 'push') {
                return { success: true, stdout: 'No local changes to save', stderr: '' };
            }
            if (args[0] === 'stash' && args[1] === 'pop') {
                return { success: true, stdout: 'popped', stderr: '' };
            }
            return { success: true, stdout: '', stderr: '' };
        });

        const { gitBranchCheckout } = await import('./branchOperations');

        const res = await gitBranchCheckout({
            context: { cwd: '/tmp' } as any,
            request: {
                name: 'other',
                strategy: 'bring_changes',
            } as any,
        });

        expect(res.success).toBe(true);
        expect(res.didCreateStash).toBe(false);
        expect(res.didPopStash).toBe(false);
        expect(runScmCommand).not.toHaveBeenCalledWith(expect.objectContaining({ args: expect.arrayContaining(['stash', 'pop']) }));
    });

    it('falls back to `git checkout -b` when `git switch -c` is unavailable', async () => {
        vi.resetModules();
        runScmCommand.mockReset();

        runScmCommand.mockImplementation(async (input: { args: string[] }) => {
            const args = input.args;
            if (args[0] === 'switch' && args[1] === '-c') {
                return {
                    success: false,
                    stdout: '',
                    stderr: 'git: \'switch\' is not a git command. See \'git --help\'.',
                };
            }
            if (args[0] === 'checkout' && args[1] === '-b') {
                return { success: true, stdout: 'ok', stderr: '' };
            }
            return { success: true, stdout: '', stderr: '' };
        });

        const { gitBranchCreate } = await import('./branchOperations');

        const res = await gitBranchCreate({
            context: { cwd: '/tmp' } as any,
            request: {
                name: 'new-branch',
                checkout: true,
            } as any,
        });

        expect(res.success).toBe(true);
        expect(runScmCommand).toHaveBeenCalledWith(expect.objectContaining({ args: ['checkout', '-b', 'new-branch'] }));
    });

    it('passes branch create startPoint positionally for `git switch -c` and fallback checkout', async () => {
        vi.resetModules();
        runScmCommand.mockReset();

        runScmCommand.mockImplementation(async (input: { args: string[] }) => {
            const args = input.args;
            if (args[0] === 'switch' && args[1] === '-c') {
                return {
                    success: false,
                    stdout: '',
                    stderr: 'git: \'switch\' is not a git command. See \'git --help\'.',
                };
            }
            if (args[0] === 'checkout' && args[1] === '-b') {
                return { success: true, stdout: 'ok', stderr: '' };
            }
            return { success: true, stdout: '', stderr: '' };
        });

        const { gitBranchCreate } = await import('./branchOperations');

        const res = await gitBranchCreate({
            context: { cwd: '/tmp' } as any,
            request: {
                name: 'new-branch',
                checkout: true,
                startPoint: 'origin/main',
            } as any,
        });

        expect(res.success).toBe(true);
        expect(runScmCommand).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ args: ['switch', '-c', 'new-branch', 'origin/main'] }),
        );
        expect(runScmCommand).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ args: ['checkout', '-b', 'new-branch', 'origin/main'] }),
        );
    });

    it('rejects option-like startPoint values for branch create', async () => {
        vi.resetModules();
        runScmCommand.mockReset();
        runScmCommand.mockResolvedValue({ success: true, stdout: '', stderr: '' });

        const { gitBranchCreate } = await import('./branchOperations');

        const res = await gitBranchCreate({
            context: { cwd: '/tmp' } as any,
            request: {
                name: 'new-branch',
                checkout: true,
                startPoint: '--bad',
            } as any,
        });

        expect(res.success).toBe(false);
        expect(res.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
        expect(runScmCommand).not.toHaveBeenCalled();
    });

    it('blocks no-stash branch checkout when local changes would be overwritten', async () => {
        vi.resetModules();
        runScmCommand.mockReset();

        runScmCommand.mockImplementation(async (input: { args: string[] }) => {
            const args = input.args;
            if (args[0] === 'switch') {
                return {
                    success: false,
                    stdout: '',
                    stderr: 'error: Your local changes to the following files would be overwritten by checkout',
                };
            }
            if (args[0] === 'stash') {
                throw new Error('no-stash checkout must not run git stash');
            }
            return { success: true, stdout: '', stderr: '' };
        });

        const { gitBranchCheckoutWithoutStash } = await import('./branchOperations');

        const res = await gitBranchCheckoutWithoutStash({
            context: { cwd: '/tmp' } as any,
            name: 'feature/pr',
        });

        expect(res.success).toBe(false);
        expect(res.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
        expect(runScmCommand).toHaveBeenCalledOnce();
    });
});
