import { describe, expect, it, vi } from 'vitest';

import type { ScmHostingProvider } from '@happier-dev/protocol';

const provider: ScmHostingProvider = {
    kind: 'gitlab',
    name: 'GitLab',
    baseUrl: 'https://gitlab.com',
    nameWithOwner: 'happier-dev/mobile/app',
    remoteName: 'origin',
};

describe('gitlabCliAdapter', () => {
    it('lists open merge requests through an authenticated local glab CLI', async () => {
        const mod = await import('./gitlabCliAdapter').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected GitLab CLI adapter module');

        const runCommand = vi.fn(async () => ({
            success: true,
            stdout: JSON.stringify([
                {
                    iid: 17,
                    title: 'Add GitLab support',
                    web_url: 'https://gitlab.com/happier-dev/mobile/app/-/merge_requests/17',
                    state: 'opened',
                    source_branch: 'feature/gitlab',
                    target_branch: 'main',
                },
            ]),
            stderr: '',
            exitCode: 0,
        }));

        const adapter = mod.createGitlabCliAdapter({ runCommand });
        if (!adapter.listOpenPullRequests) throw new Error('expected GitLab CLI list adapter');

        await expect(adapter.listOpenPullRequests({
            provider,
            base: 'main',
            head: 'feature/gitlab',
        })).resolves.toEqual([
            {
                provider,
                number: 17,
                title: 'Add GitLab support',
                url: 'https://gitlab.com/happier-dev/mobile/app/-/merge_requests/17',
                baseBranch: 'main',
                headBranch: 'feature/gitlab',
                state: 'open',
            },
        ]);

        expect(runCommand).toHaveBeenCalledWith({
            args: [
                'mr',
                'list',
                '--repo',
                'happier-dev/mobile/app',
                '--state',
                'opened',
                '--output',
                'json',
                '--target-branch',
                'main',
                '--source-branch',
                'feature/gitlab',
            ],
            timeoutMs: expect.any(Number),
        });
    });

    it('creates a merge request through glab and then reads the created MR summary', async () => {
        const mod = await import('./gitlabCliAdapter').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected GitLab CLI adapter module');

        const runCommand = vi.fn(async ({ args }: { args: readonly string[] }) => {
            if (args[0] === 'api' && args.includes('projects/happier-dev%2Fmobile%2Fapp/merge_requests')) {
                expect(args).not.toContain('Implements merge request management.');
                return {
                    success: true,
                    stdout: 'https://gitlab.com/happier-dev/mobile/app/-/merge_requests/18\n',
                    stderr: '',
                    exitCode: 0,
                };
            }
            if (args[0] === 'mr' && args[1] === 'view') {
                return {
                    success: true,
                    stdout: JSON.stringify({
                        iid: 18,
                        title: 'Ship GitLab support',
                        web_url: 'https://gitlab.com/happier-dev/mobile/app/-/merge_requests/18',
                        state: 'opened',
                        source_branch: 'feature/gitlab',
                        target_branch: 'main',
                    }),
                    stderr: '',
                    exitCode: 0,
                };
            }
            return {
                success: false,
                stdout: '',
                stderr: `unexpected glab args: ${args.join(' ')}`,
                exitCode: 1,
            };
        });

        const adapter = mod.createGitlabCliAdapter({ runCommand });
        if (!adapter.createPullRequest) throw new Error('expected GitLab CLI create adapter');

        await expect(adapter.createPullRequest({
            provider,
            base: 'main',
            head: 'feature/gitlab',
            title: 'Ship GitLab support',
            body: 'Implements merge request management.',
        })).resolves.toMatchObject({
            number: 18,
            title: 'Ship GitLab support',
            url: 'https://gitlab.com/happier-dev/mobile/app/-/merge_requests/18',
            baseBranch: 'main',
            headBranch: 'feature/gitlab',
            state: 'open',
        });

        expect(runCommand).toHaveBeenCalledWith({
            args: [
                'api',
                '--hostname',
                'gitlab.com',
                '--method',
                'POST',
                'projects/happier-dev%2Fmobile%2Fapp/merge_requests',
                '--raw-field',
                'source_branch=feature/gitlab',
                '--raw-field',
                'target_branch=main',
                '--raw-field',
                'title=Ship GitLab support',
                '--field',
                expect.stringMatching(/^description=@.+/),
            ],
            timeoutMs: expect.any(Number),
        });
    });
});
