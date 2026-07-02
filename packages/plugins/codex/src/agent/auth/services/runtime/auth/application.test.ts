import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { applyCodexConnectedServiceAuthGeneration } from './application.js';

describe('Codex connected-service runtime auth application', () => {
    it('falls back to restart/resume when transport invalidation fails after login/start', async () => {
        const candidate = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'openai-codex',
            profileId: 'work',
            kind: 'oauth',
            expiresAt: 2000,
            oauth: {
                accessToken: 'access',
                refreshToken: 'refresh',
                idToken: 'id',
                scope: null,
                tokenType: null,
                providerAccountId: 'workspace-work',
                providerEmail: null,
            },
        });
        const client = { request: vi.fn(async () => ({ ok: true })) };
        const invalidateTransports = vi.fn(async () => {
            throw new Error('transport is gone');
        });

        await expect(applyCodexConnectedServiceAuthGeneration({
            client,
            candidate,
            forcedWorkspaceId: 'workspace-work',
            invalidateTransports,
        })).resolves.toEqual({
            applied: false,
            reason: 'transport_invalidation_failed',
            recovery: 'restart_resume',
        });

        expect(client.request).toHaveBeenCalledOnce();
        expect(invalidateTransports).toHaveBeenCalledOnce();
    });

    it('sends Codex app-server the flat chatgptAuthTokens login payload', async () => {
        const candidate = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'openai-codex',
            profileId: 'work',
            kind: 'oauth',
            expiresAt: 2000,
            oauth: {
                accessToken: 'access',
                refreshToken: 'refresh',
                idToken: 'id-should-not-be-forwarded',
                scope: null,
                tokenType: null,
                providerAccountId: 'workspace-work',
                providerEmail: null,
            },
        });
        const client = { request: vi.fn(async () => ({ ok: true })) };
        const invalidateTransports = vi.fn(async () => undefined);

        await expect(applyCodexConnectedServiceAuthGeneration({
            client,
            candidate,
            forcedWorkspaceId: 'workspace-work',
            invalidateTransports,
        })).resolves.toEqual({ applied: true, via: 'hot' });

        expect(client.request).toHaveBeenCalledWith('account/login/start', {
            type: 'chatgptAuthTokens',
            accessToken: 'access',
            chatgptAccountId: 'workspace-work',
        });
    });
});
