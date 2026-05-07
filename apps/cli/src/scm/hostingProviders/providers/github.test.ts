import { describe, expect, it } from 'vitest';

describe('github hosting provider adapter', () => {
    it('detects neutral-host GitHub Enterprise remotes from owner/repository path shape', async () => {
        const mod = await import('./github').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected GitHub hosting provider adapter module');

        expect(mod.githubScmHostingProviderAdapter.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'ssh://git@code.company.com/happier-dev/happier.git',
        })).toMatchObject({
            kind: 'github',
            name: 'GitHub',
            baseUrl: 'https://code.company.com',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });
    });

    it('does not claim neutral-host remotes with nested namespaces', async () => {
        const mod = await import('./github').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected GitHub hosting provider adapter module');

        expect(mod.githubScmHostingProviderAdapter.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@scm.corp:happier-dev/mobile/app.git',
        })).toBeNull();
    });
});
