import { describe, expect, it } from 'vitest';

describe('SCM hosting provider registry', () => {
    it('detects GitHub remotes from HTTPS and SSH URLs', async () => {
        const mod = await import('./registry').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected SCM hosting provider registry module');

        const registry = mod.createDefaultScmHostingProviderRegistry();
        const https = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'https://github.com/happier-dev/happier.git',
        });
        const ssh = registry.detectRemote({
            remoteName: 'upstream',
            remoteUrl: 'git@github.com:happier-dev/happier.git',
        });

        expect(https).toMatchObject({
            kind: 'github',
            name: 'GitHub',
            baseUrl: 'https://github.com',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });
        expect(ssh).toMatchObject({
            kind: 'github',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'upstream',
        });
    });

    it('detects GitHub Enterprise-style remotes without hardcoding github.com', async () => {
        const mod = await import('./registry').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected SCM hosting provider registry module');

        const registry = mod.createDefaultScmHostingProviderRegistry();

        expect(registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'ssh://git@github.company.com/happier-dev/happier.git',
        })).toMatchObject({
            kind: 'github',
            name: 'GitHub',
            baseUrl: 'https://github.company.com',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });
    });

    it('detects GitLab and Bitbucket remotes without enabling write adapters', async () => {
        const mod = await import('./registry').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected SCM hosting provider registry module');

        const registry = mod.createDefaultScmHostingProviderRegistry();
        expect(registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@gitlab.com:happier-dev/mobile/app.git',
        })).toMatchObject({
            kind: 'gitlab',
            name: 'GitLab',
            baseUrl: 'https://gitlab.com',
            nameWithOwner: 'happier-dev/mobile/app',
        });

        expect(registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'https://bitbucket.org/happier-dev/happier.git',
        })).toMatchObject({
            kind: 'bitbucket',
            name: 'Bitbucket',
            baseUrl: 'https://bitbucket.org',
            nameWithOwner: 'happier-dev/happier',
        });
    });

    it('builds provider-specific compare URLs', async () => {
        const mod = await import('./registry').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected SCM hosting provider registry module');

        const registry = mod.createDefaultScmHostingProviderRegistry();

        expect(registry.buildCompareUrl({
            provider: {
                kind: 'github',
                name: 'GitHub',
                baseUrl: 'https://github.com',
                nameWithOwner: 'happier-dev/happier',
                remoteName: 'origin',
            },
            base: 'main',
            head: 'feature/pr-support',
        })).toBe('https://github.com/happier-dev/happier/compare/main...feature%2Fpr-support');

        expect(registry.buildCompareUrl({
            provider: {
                kind: 'gitlab',
                name: 'GitLab',
                baseUrl: 'https://gitlab.com',
                nameWithOwner: 'happier-dev/mobile/app',
                remoteName: 'origin',
            },
            base: 'release/2026',
            head: 'feature/pr-support',
        })).toBe('https://gitlab.com/happier-dev/mobile/app/-/compare/release%2F2026...feature%2Fpr-support');

        expect(registry.buildCompareUrl({
            provider: {
                kind: 'bitbucket',
                name: 'Bitbucket',
                baseUrl: 'https://bitbucket.org',
                nameWithOwner: 'happier-dev/happier',
                remoteName: 'origin',
            },
            base: 'main',
            head: 'feature/pr-support',
        })).toBe('https://bitbucket.org/happier-dev/happier/branch/feature%2Fpr-support?dest=main');
    });

    it('returns null for remotes that no registered provider owns', async () => {
        const mod = await import('./registry').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected SCM hosting provider registry module');

        const registry = mod.createDefaultScmHostingProviderRegistry();
        expect(registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'ssh://git@example.com/happier-dev/happier.git',
        })).toBeNull();
    });
});
