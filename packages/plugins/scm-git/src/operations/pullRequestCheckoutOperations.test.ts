import { describe, expect, it, vi } from 'vitest';

import type {
  ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmPullRequestSummary,
  ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/scm';

import type { ScmBackendContext } from '../types.js';
import {
    runWithGitScmCommandRunner,
    type GitScmCommandRunner,
} from '../testkit/scmRuntime.test-support.js';
import { createGitPullRequestCheckoutOperations } from './pullRequestCheckoutOperations.js';

const provider: ScmHostingProviderRef = {
    id: 'scm.github',
    kind: 'github',
    displayName: 'GitHub',
    baseUrl: 'https://github.com',
    remoteName: 'origin',
    urlSafety: { allowedSchemes: ['https:'] },
};

const pullRequest: ScmPullRequestSummary = {
    provider,
    number: 7,
    title: 'Checkout PR',
    url: 'https://github.com/happier-dev/happier/pull/7',
    baseBranch: 'main',
    headBranch: 'feature/scm-pr-7',
    headSha: 'abc1234',
    baseSha: 'def5678',
    state: 'open',
};

const context: ScmBackendContext = {
    cwd: '/repo',
    projectKey: 'machine:/repo',
    detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
};

function createSnapshot(input?: Readonly<{
    provider?: ScmHostingProviderRef;
}>): ScmWorkingSnapshot {
    return {
        projectKey: context.projectKey,
        fetchedAt: 100,
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            remotes: [{ name: 'origin', fetchUrl: 'https://github.com/happier-dev/happier.git' }],
            worktrees: [],
        },
        capabilities: { capabilityScope: 'local-backend' },
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        hostingProvider: input?.provider ?? provider,
        pullRequestStatus: null,
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
}

function createRegistry(input?: Readonly<{
    branch?: string;
    remoteRef?: string;
}>) {
    return {
        getAdapter(id: string) {
            return id === provider.id
                ? {
                    resolvePullRequestCheckoutReference: vi.fn(async () => ({
                        pullRequest,
                        branch: input?.branch ?? 'feature/scm-pr-7',
                        remoteRef: input?.remoteRef ?? 'refs/pull/7/head',
                        headSha: 'abc1234',
                        baseSha: 'def5678',
                    })),
                }
                : undefined;
        },
    };
}

describe('git pull request checkout operations', () => {
    it('fetches adapter-owned checkout refs and switches to a matching local PR branch without force or stash', async () => {
        const runner = vi.fn<GitScmCommandRunner>()
            .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 })
            .mockResolvedValueOnce({ success: false, stdout: '', stderr: 'not found', exitCode: 1 })
            .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 })
            .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 });
        const operations = createGitPullRequestCheckoutOperations({
            registry: createRegistry(),
            readSnapshot: async () => createSnapshot(),
        });

        const response = await runWithGitScmCommandRunner(runner, () => operations.checkout({
            context,
            request: { cwd: '/repo', prReference: { number: 7 } },
        }));

        expect(response).toMatchObject({
            success: true,
            pullRequest,
            branch: 'feature/scm-pr-7',
            headSha: 'abc1234',
            baseSha: 'def5678',
        });
        expect(runner).toHaveBeenNthCalledWith(1, expect.objectContaining({
            command: 'git',
            args: ['fetch', 'origin', 'refs/pull/7/head'],
        }));
        expect(runner).toHaveBeenNthCalledWith(3, expect.objectContaining({
            args: ['branch', '--', 'feature/scm-pr-7', 'FETCH_HEAD'],
        }));
        expect(runner).toHaveBeenNthCalledWith(4, expect.objectContaining({
            args: ['switch', 'feature/scm-pr-7'],
        }));
        expect(runner.mock.calls.flatMap(([call]) => call.args.join(' '))).not.toContain('--force');
        expect(runner.mock.calls.flatMap(([call]) => call.args.join(' '))).not.toContain('stash');
    });

    it('fetches the provider PR ref before delegating worktree realization through the existing checkout seam', async () => {
        const runner = vi.fn<GitScmCommandRunner>()
            .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 })
            .mockResolvedValueOnce({ success: false, stdout: '', stderr: 'not found', exitCode: 1 })
            .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 });
        const realizeWorkspaceCheckout = vi.fn(async () => ({
            kind: 'git_worktree' as const,
            targetPath: '/repo/.dev/worktree/feature/scm-pr-7',
        }));
        const operations = createGitPullRequestCheckoutOperations({
            registry: createRegistry(),
            readSnapshot: async () => createSnapshot(),
            realizeWorkspaceCheckout,
        });

        const response = await runWithGitScmCommandRunner(runner, () => operations.prepareWorktree({
            context,
            request: {
                cwd: '/repo',
                sourcePath: '/repo',
                prReference: { number: 7 },
                mode: 'worktree',
            },
        }));

        expect(response).toMatchObject({
            success: true,
            targetPath: '/repo/.dev/worktree/feature/scm-pr-7',
            branch: 'feature/scm-pr-7',
            pullRequest,
        });
        expect(runner).toHaveBeenNthCalledWith(1, expect.objectContaining({
            command: 'git',
            args: ['fetch', 'origin', 'refs/pull/7/head'],
        }));
        expect(runner).toHaveBeenNthCalledWith(3, expect.objectContaining({
            args: ['branch', '--', 'feature/scm-pr-7', 'FETCH_HEAD'],
        }));
        expect(realizeWorkspaceCheckout).toHaveBeenCalledWith({
            context,
            workspaceCheckoutRealization: {
                kind: 'git_worktree',
                sourcePath: '/repo',
                displayName: 'feature/scm-pr-7',
                baseRef: 'feature/scm-pr-7',
                targetPath: null,
            },
        });
    });

    it('rejects unsafe provider checkout refs before invoking git fetch', async () => {
        const runner = vi.fn<GitScmCommandRunner>()
            .mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0 });
        const operations = createGitPullRequestCheckoutOperations({
            registry: createRegistry({ remoteRef: '--upload-pack=/tmp/evil' }),
            readSnapshot: async () => createSnapshot(),
        });

        const response = await runWithGitScmCommandRunner(runner, () => operations.checkout({
            context,
            request: { cwd: '/repo', prReference: { number: 7 } },
        }));

        expect(response).toMatchObject({
            success: false,
        });
        expect(runner).not.toHaveBeenCalled();
    });

    it('rejects unsupported provider branch ref syntax before invoking git fetch', async () => {
        const runner = vi.fn<GitScmCommandRunner>()
            .mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0 });
        const operations = createGitPullRequestCheckoutOperations({
            registry: createRegistry({ branch: 'feature..evil' }),
            readSnapshot: async () => createSnapshot(),
        });

        const response = await runWithGitScmCommandRunner(runner, () => operations.checkout({
            context,
            request: { cwd: '/repo', prReference: { number: 7 } },
        }));

        expect(response).toMatchObject({
            success: false,
        });
        expect(runner).not.toHaveBeenCalled();
    });

    it.each([
        '--upload-pack=/tmp/evil',
        '../evil',
        '.',
    ])('rejects unsafe remote name %s before invoking git fetch', async (remoteName) => {
        const runner = vi.fn<GitScmCommandRunner>()
            .mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0 });
        const operations = createGitPullRequestCheckoutOperations({
            registry: createRegistry(),
            readSnapshot: async () => createSnapshot({
                provider: {
                    ...provider,
                    remoteName,
                },
            }),
        });

        const response = await runWithGitScmCommandRunner(runner, () => operations.checkout({
            context,
            request: { cwd: '/repo', prReference: { number: 7 } },
        }));

        expect(response).toMatchObject({
            success: false,
        });
        expect(runner).not.toHaveBeenCalled();
    });
});
