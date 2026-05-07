import { describe, expect, it } from 'vitest';

describe('gitlab hosting provider adapter', () => {
    it('detects self-hosted GitLab remotes', async () => {
        const mod = await import('./gitlab').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected GitLab hosting provider adapter module');

        expect(mod.gitlabScmHostingProviderAdapter.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@gitlab.company.test:happier-dev/mobile/app.git',
        })).toMatchObject({
            kind: 'gitlab',
            name: 'GitLab',
            baseUrl: 'https://gitlab.company.test',
            nameWithOwner: 'happier-dev/mobile/app',
            remoteName: 'origin',
        });
    });

    it('detects neutral-host GitLab remotes from nested namespace path shape', async () => {
        const mod = await import('./gitlab').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected GitLab hosting provider adapter module');

        expect(mod.gitlabScmHostingProviderAdapter.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@scm.corp:happier-dev/mobile/app.git',
        })).toMatchObject({
            kind: 'gitlab',
            name: 'GitLab',
            baseUrl: 'https://scm.corp',
            nameWithOwner: 'happier-dev/mobile/app',
            remoteName: 'origin',
        });
    });
});
