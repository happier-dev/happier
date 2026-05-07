import { describe, expect, it } from 'vitest';

import {
    buildConnectedServiceCredentialRecord,
    type ScmHostingProvider,
} from '@happier-dev/protocol';

import type { ScmBackendContext } from '../../../types';

const githubProvider = {
    kind: 'github',
    name: 'GitHub',
    baseUrl: 'https://github.com',
    nameWithOwner: 'happier-dev/happier',
    remoteName: 'origin',
} as const satisfies ScmHostingProvider;

describe('pull request operation helpers', () => {
    it('returns connected-account github auth with an auth profile cache key for github.com', async () => {
        const mod = await import('./pullRequestOperationHelpers') as Record<string, unknown>;
        const resolveGithubConnectedAccountAuth = mod.resolveGithubConnectedAccountAuth;
        expect(resolveGithubConnectedAccountAuth).toBeTypeOf('function');
        if (typeof resolveGithubConnectedAccountAuth !== 'function') {
            throw new Error('expected GitHub connected-account auth helper');
        }

        const credential = buildConnectedServiceCredentialRecord({
            now: 1_000,
            serviceId: 'github',
            profileId: 'primary',
            kind: 'token',
            token: {
                token: 'ghp_connected',
                providerAccountId: '42',
                providerEmail: 'octo@example.com',
            },
        });
        const context: ScmBackendContext = {
            cwd: '/repo',
            projectKey: 'test:/repo',
            detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
            connectedAccounts: {
                resolveCredential: async (serviceId) => serviceId === 'github' ? credential : null,
            },
        };

        await expect(resolveGithubConnectedAccountAuth({
            context,
            providerBaseUrl: 'https://github.com',
        })).resolves.toMatchObject({
            kind: 'available',
            token: 'ghp_connected',
            authProfileKey: 'connected:token:primary',
        });
    });

    it('skips github connected-account lookup for enterprise hosts and falls back to gh cli auth', async () => {
        const mod = await import('./pullRequestOperationHelpers') as Record<string, unknown>;
        const resolveHostingAuthProfileKey = mod.resolveHostingAuthProfileKey;
        expect(resolveHostingAuthProfileKey).toBeTypeOf('function');
        if (typeof resolveHostingAuthProfileKey !== 'function') {
            throw new Error('expected hosting auth profile resolver');
        }

        let resolveCredentialCalls = 0;
        const credential = buildConnectedServiceCredentialRecord({
            now: 1_000,
            serviceId: 'github',
            profileId: 'primary',
            kind: 'token',
            token: {
                token: 'ghp_connected',
                providerAccountId: '42',
                providerEmail: 'octo@example.com',
            },
        });
        const context: ScmBackendContext = {
            cwd: '/repo',
            projectKey: 'test:/repo',
            detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
            connectedAccounts: {
                resolveCredential: async (serviceId) => {
                    resolveCredentialCalls += 1;
                    return serviceId === 'github' ? credential : null;
                },
            },
        };

        await expect(resolveHostingAuthProfileKey({
            context,
            provider: {
                ...githubProvider,
                baseUrl: 'https://github.company.com',
            },
            detectGithubCliAuth: async () => ({
                kind: 'authenticated',
                command: 'gh',
                host: 'github.company.com',
            }),
        })).resolves.toBe('gh-cli');
        expect(resolveCredentialCalls).toBe(0);
    });
});
