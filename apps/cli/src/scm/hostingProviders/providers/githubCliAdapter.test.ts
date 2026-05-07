import { describe, expect, it, vi } from 'vitest';

import type { ScmHostingProvider } from '@happier-dev/protocol';

const provider: ScmHostingProvider = {
    kind: 'github',
    name: 'GitHub',
    baseUrl: 'https://github.com',
    nameWithOwner: 'happier-dev/happier',
    remoteName: 'origin',
};

const enterpriseProvider: ScmHostingProvider = {
    kind: 'github',
    name: 'GitHub',
    baseUrl: 'https://github.company.com',
    nameWithOwner: 'happier-dev/happier',
    remoteName: 'origin',
};

describe('githubCliAdapter', () => {
    it('lists open pull requests through an authenticated local gh CLI', async () => {
        const mod = await import('./githubCliAdapter').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected GitHub CLI adapter module');

        const runCommand = vi.fn(async () => ({
            success: true,
            stdout: JSON.stringify([
                {
                    number: 12,
                    title: 'Add PR support',
                    url: 'https://github.com/happier-dev/happier/pull/12',
                    state: 'OPEN',
                    baseRefName: 'main',
                    headRefName: 'feature/pr-support',
                },
            ]),
            stderr: '',
            exitCode: 0,
        }));

        const adapter = mod.createGithubCliAdapter({ runCommand });
        if (!adapter.listOpenPullRequests) throw new Error('expected GitHub CLI list adapter');

        await expect(adapter.listOpenPullRequests({
            provider,
            base: 'main',
            head: 'feature/pr-support',
        })).resolves.toEqual([
            {
                provider,
                number: 12,
                title: 'Add PR support',
                url: 'https://github.com/happier-dev/happier/pull/12',
                baseBranch: 'main',
                headBranch: 'feature/pr-support',
                state: 'open',
            },
        ]);

        expect(runCommand).toHaveBeenCalledWith({
            args: [
                'pr',
                'list',
                '--repo',
                'happier-dev/happier',
                '--state',
                'open',
                '--json',
                'number,title,url,state,baseRefName,headRefName,mergedAt',
                '--base',
                'main',
                '--head',
                'feature/pr-support',
            ],
            timeoutMs: expect.any(Number),
        });
    });

    it('creates a pull request through gh and then reads the created PR summary', async () => {
        const mod = await import('./githubCliAdapter').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected GitHub CLI adapter module');

        const runCommand = vi.fn(async ({ args }: { args: readonly string[] }) => {
            if (args[0] === 'pr' && args[1] === 'create') {
                return {
                    success: true,
                    stdout: 'https://github.com/happier-dev/happier/pull/42\n',
                    stderr: '',
                    exitCode: 0,
                };
            }
            if (args[0] === 'pr' && args[1] === 'view') {
                return {
                    success: true,
                    stdout: JSON.stringify({
                        number: 42,
                        title: 'Ship PR support',
                        url: 'https://github.com/happier-dev/happier/pull/42',
                        state: 'OPEN',
                        baseRefName: 'main',
                        headRefName: 'feature/pr-support',
                    }),
                    stderr: '',
                    exitCode: 0,
                };
            }
            return {
                success: false,
                stdout: '',
                stderr: `unexpected gh args: ${args.join(' ')}`,
                exitCode: 1,
            };
        });

        const adapter = mod.createGithubCliAdapter({ runCommand });
        if (!adapter.createPullRequest) throw new Error('expected GitHub CLI create adapter');

        await expect(adapter.createPullRequest({
            provider,
            base: 'main',
            head: 'feature/pr-support',
            title: 'Ship PR support',
            body: 'Implements PR management.',
        })).resolves.toMatchObject({
            number: 42,
            title: 'Ship PR support',
            url: 'https://github.com/happier-dev/happier/pull/42',
            baseBranch: 'main',
            headBranch: 'feature/pr-support',
            state: 'open',
        });

        expect(runCommand).toHaveBeenCalledWith({
            args: [
                'pr',
                'create',
                '--repo',
                'happier-dev/happier',
                '--base',
                'main',
                '--head',
                'feature/pr-support',
                '--title',
                'Ship PR support',
                '--body',
                'Implements PR management.',
            ],
            timeoutMs: expect.any(Number),
        });
    });

    it('describes repository publish targets from authenticated gh user metadata', async () => {
        const mod = await import('./githubCliAdapter').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected GitHub CLI adapter module');

        const runCommand = vi.fn(async ({ args }: { args: readonly string[] }) => {
            if (args[0] === 'api' && args[1] === 'user') {
                return {
                    success: true,
                    stdout: JSON.stringify({ login: 'happier-dev' }),
                    stderr: '',
                    exitCode: 0,
                };
            }
            if (args[0] === 'api' && args[1] === 'user/orgs') {
                return {
                    success: true,
                    stdout: JSON.stringify([{ login: 'happier-org' }]),
                    stderr: '',
                    exitCode: 0,
                };
            }
            return {
                success: false,
                stdout: '',
                stderr: `unexpected gh args: ${args.join(' ')}`,
                exitCode: 1,
            };
        });

        const adapter = mod.createGithubCliAdapter({ runCommand }) as Record<string, unknown>;
        expect(adapter.listRepositoryPublishTargets).toBeTypeOf('function');
        const listRepositoryPublishTargets = adapter.listRepositoryPublishTargets;
        if (typeof listRepositoryPublishTargets !== 'function') throw new Error('expected GitHub CLI publish-target adapter');

        await expect(listRepositoryPublishTargets({
            providerBaseUrl: 'https://github.com',
        })).resolves.toEqual([
            {
                providerKind: 'github',
                owner: 'happier-dev',
                ownerKind: 'user',
                label: 'happier-dev',
                default: true,
                supportedVisibilities: ['private', 'public'],
            },
            {
                providerKind: 'github',
                owner: 'happier-org',
                ownerKind: 'org',
                label: 'happier-org',
                supportedVisibilities: ['private', 'public', 'internal'],
            },
        ]);
    });

    it('passes the GitHub Enterprise host to gh api when describing publish targets', async () => {
        const mod = await import('./githubCliAdapter').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected GitHub CLI adapter module');

        const runCommand = vi.fn(async ({ args }: { args: readonly string[] }) => {
            if (args[0] === 'api' && args[3] === 'user') {
                return {
                    success: true,
                    stdout: JSON.stringify({ login: 'happier-dev' }),
                    stderr: '',
                    exitCode: 0,
                };
            }
            if (args[0] === 'api' && args[3] === 'user/orgs') {
                return {
                    success: true,
                    stdout: JSON.stringify([{ login: 'happier-org' }]),
                    stderr: '',
                    exitCode: 0,
                };
            }
            return {
                success: false,
                stdout: '',
                stderr: `unexpected gh args: ${args.join(' ')}`,
                exitCode: 1,
            };
        });

        const adapter = mod.createGithubCliAdapter({ runCommand }) as Record<string, unknown>;
        expect(adapter.listRepositoryPublishTargets).toBeTypeOf('function');
        const listRepositoryPublishTargets = adapter.listRepositoryPublishTargets;
        if (typeof listRepositoryPublishTargets !== 'function') throw new Error('expected GitHub CLI publish-target adapter');

        await expect(listRepositoryPublishTargets({
            providerBaseUrl: enterpriseProvider.baseUrl,
        })).resolves.toMatchObject([
            {
                owner: 'happier-dev',
                ownerKind: 'user',
            },
            {
                owner: 'happier-org',
                ownerKind: 'org',
            },
        ]);

        expect(runCommand).toHaveBeenNthCalledWith(1, {
            args: ['api', '--hostname', 'github.company.com', 'user'],
            timeoutMs: expect.any(Number),
        });
        expect(runCommand).toHaveBeenNthCalledWith(2, {
            args: ['api', '--hostname', 'github.company.com', 'user/orgs'],
            timeoutMs: expect.any(Number),
        });
    });

    it('creates repositories through gh without letting gh mutate local git state', async () => {
        const mod = await import('./githubCliAdapter').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected GitHub CLI adapter module');

        const runCommand = vi.fn(async ({ args }: { args: readonly string[] }) => {
            if (args.includes('--source') || args.includes('--remote') || args.includes('--push') || args.includes('--confirm')) {
                return {
                    success: false,
                    stdout: '',
                    stderr: `forbidden gh repo create arg: ${args.join(' ')}`,
                    exitCode: 1,
                };
            }
            if (args[0] === 'repo' && args[1] === 'create') {
                return {
                    success: true,
                    stdout: '',
                    stderr: '',
                    exitCode: 0,
                };
            }
            if (args[0] === 'repo' && args[1] === 'view') {
                return {
                    success: true,
                    stdout: JSON.stringify({
                        nameWithOwner: 'happier-dev/happier',
                        url: 'https://github.com/happier-dev/happier',
                        sshUrl: 'git@github.com:happier-dev/happier.git',
                        defaultBranchRef: { name: 'main' },
                        visibility: 'PRIVATE',
                    }),
                    stderr: '',
                    exitCode: 0,
                };
            }
            return {
                success: false,
                stdout: '',
                stderr: `unexpected gh args: ${args.join(' ')}`,
                exitCode: 1,
            };
        });

        const adapter = mod.createGithubCliAdapter({ runCommand }) as Record<string, unknown>;
        expect(adapter.createRepository).toBeTypeOf('function');
        const createRepository = adapter.createRepository;
        if (typeof createRepository !== 'function') throw new Error('expected GitHub CLI repository create adapter');

        await expect(createRepository({
            providerBaseUrl: 'https://github.com',
            owner: 'happier-dev',
            ownerKind: 'user',
            repositoryName: 'happier',
            visibility: 'private',
            description: 'A calmer coding workspace.',
        })).resolves.toMatchObject({
            nameWithOwner: 'happier-dev/happier',
            url: 'https://github.com/happier-dev/happier',
            cloneUrl: 'https://github.com/happier-dev/happier.git',
            visibility: 'private',
        });

        expect(runCommand).toHaveBeenCalledWith({
            args: [
                'repo',
                'create',
                'happier-dev/happier',
                '--private',
                '--description',
                'A calmer coding workspace.',
            ],
            timeoutMs: expect.any(Number),
        });
    });

    it('passes the GitHub Enterprise host to gh repository create and view commands', async () => {
        const mod = await import('./githubCliAdapter').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected GitHub CLI adapter module');

        const runCommand = vi.fn(async ({ args }: { args: readonly string[] }) => {
            if (args[0] === 'repo' && args[1] === 'create') {
                return {
                    success: true,
                    stdout: '',
                    stderr: '',
                    exitCode: 0,
                };
            }
            if (args[0] === 'repo' && args[1] === 'view') {
                return {
                    success: true,
                    stdout: JSON.stringify({
                        nameWithOwner: 'happier-dev/happier',
                        url: 'https://github.company.com/happier-dev/happier',
                        sshUrl: 'git@github.company.com:happier-dev/happier.git',
                        defaultBranchRef: { name: 'main' },
                        visibility: 'PRIVATE',
                    }),
                    stderr: '',
                    exitCode: 0,
                };
            }
            return {
                success: false,
                stdout: '',
                stderr: `unexpected gh args: ${args.join(' ')}`,
                exitCode: 1,
            };
        });

        const adapter = mod.createGithubCliAdapter({ runCommand }) as Record<string, unknown>;
        expect(adapter.createRepository).toBeTypeOf('function');
        const createRepository = adapter.createRepository;
        if (typeof createRepository !== 'function') throw new Error('expected GitHub CLI repository create adapter');

        await expect(createRepository({
            providerBaseUrl: enterpriseProvider.baseUrl,
            owner: 'happier-dev',
            ownerKind: 'org',
            repositoryName: 'happier',
            visibility: 'private',
        })).resolves.toMatchObject({
            provider: {
                baseUrl: enterpriseProvider.baseUrl,
            },
            url: 'https://github.company.com/happier-dev/happier',
        });

        expect(runCommand).toHaveBeenNthCalledWith(1, {
            args: [
                'repo',
                'create',
                'github.company.com/happier-dev/happier',
                '--private',
            ],
            timeoutMs: expect.any(Number),
        });
        expect(runCommand).toHaveBeenNthCalledWith(2, {
            args: [
                'repo',
                'view',
                'github.company.com/happier-dev/happier',
                '--json',
                'nameWithOwner,url,sshUrl,defaultBranchRef,visibility',
            ],
            timeoutMs: expect.any(Number),
        });
    });
});
