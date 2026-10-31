import { describe, expect, it, vi } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import { runWithGitScmCommandRunner, type GitScmCommandRunner } from '../testkit/scmRuntime.test-support.js';

const runScmCommand = vi.fn<GitScmCommandRunner>();

function createTestContext() {
    return {
        cwd: '/tmp',
        projectKey: 'test:/tmp',
        detection: {
            isRepo: true,
            rootPath: '/tmp',
            mode: '.git' as const,
        },
    };
}

describe('git branch operations safety', () => {
    it('does not run `git stash pop` when transient stash was not created', async () => runWithGitScmCommandRunner(runScmCommand, async () => {

        let switchCalls = 0;
        runScmCommand.mockImplementation(async (input) => {
            const args = input.args;
            if (args[0] === 'switch') {
                switchCalls += 1;
                if (switchCalls === 1) {
                    return {
                        success: false,
                        exitCode: 1,
                        stdout: '',
                        stderr: 'error: Your local changes to the following files would be overwritten by checkout',
                    };
                }
                return { success: true, stdout: 'switched', stderr: '', exitCode: 0 };
            }
            if (args[0] === 'stash' && args[1] === 'push') {
                return { success: true, stdout: 'No local changes to save', stderr: '', exitCode: 0 };
            }
            if (args[0] === 'stash' && args[1] === 'pop') {
                return { success: true, stdout: 'popped', stderr: '', exitCode: 0 };
            }
            return { success: true, stdout: '', stderr: '', exitCode: 0 };
        });

        const { gitBranchCheckout } = await import('./branchOperations.js');

        const res = await gitBranchCheckout({
            context: createTestContext(),
            request: {
                name: 'other',
                strategy: 'bring_changes',
            } as any,
        });

        expect(res.success).toBe(true);
        expect(res.didCreateStash).toBe(false);
        expect(res.didPopStash).toBe(false);
        expect(runScmCommand).not.toHaveBeenCalledWith(expect.objectContaining({ args: expect.arrayContaining(['stash', 'pop']) }));
    }));

    it('falls back to `git checkout -b` when `git switch -c` is unavailable', async () => runWithGitScmCommandRunner(runScmCommand, async () => {
        runScmCommand.mockReset();

        runScmCommand.mockImplementation(async (input) => {
            const args = input.args;
            if (args[0] === 'switch' && args[1] === '-c') {
                return {
                    success: false,
                    exitCode: 1,
                    stdout: '',
                    stderr: 'git: \'switch\' is not a git command. See \'git --help\'.',
                };
            }
            if (args[0] === 'checkout' && args[1] === '-b') {
                return { success: true, stdout: 'ok', stderr: '', exitCode: 0 };
            }
            return { success: true, stdout: '', stderr: '', exitCode: 0 };
        });

        const { gitBranchCreate } = await import('./branchOperations.js');

        const res = await gitBranchCreate({
            context: createTestContext(),
            request: {
                name: 'new-branch',
                checkout: true,
            } as any,
        });

        expect(res.success).toBe(true);
        expect(runScmCommand).toHaveBeenCalledWith(expect.objectContaining({ args: ['checkout', '-b', 'new-branch'] }));
    }));

    it('passes branch create startPoint positionally for `git switch -c` and fallback checkout', async () => runWithGitScmCommandRunner(runScmCommand, async () => {
        runScmCommand.mockReset();

        runScmCommand.mockImplementation(async (input) => {
            const args = input.args;
            if (args[0] === 'switch' && args[1] === '-c') {
                return {
                    success: false,
                    exitCode: 1,
                    stdout: '',
                    stderr: 'git: \'switch\' is not a git command. See \'git --help\'.',
                };
            }
            if (args[0] === 'checkout' && args[1] === '-b') {
                return { success: true, stdout: 'ok', stderr: '', exitCode: 0 };
            }
            return { success: true, stdout: '', stderr: '', exitCode: 0 };
        });

        const { gitBranchCreate } = await import('./branchOperations.js');

        const res = await gitBranchCreate({
            context: createTestContext(),
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
    }));

    it('rejects option-like startPoint values for branch create', async () => runWithGitScmCommandRunner(runScmCommand, async () => {
        runScmCommand.mockReset();
        runScmCommand.mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0 });

        const { gitBranchCreate } = await import('./branchOperations.js');

        const res = await gitBranchCreate({
            context: createTestContext(),
            request: {
                name: 'new-branch',
                checkout: true,
                startPoint: '--bad',
            } as any,
        });

        expect(res.success).toBe(false);
        expect(res.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
        expect(runScmCommand).not.toHaveBeenCalled();
    }));
});
