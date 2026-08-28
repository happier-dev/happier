import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import {
    applyCodexConnectedServiceAuthGeneration,
} from './application.js';

describe('Codex connected-service runtime auth application', () => {
    it('applies direct live auth through account/login/start without transport invalidation', async () => {
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
        const order: string[] = [];
        const client = {
            request: vi.fn(async () => {
                order.push('login');
                return { ok: true };
            }),
        };
        const updateRefreshSelection = vi.fn(async () => {
            order.push('refresh-selection');
            return async () => {
                order.push('rollback');
            };
        });

        await expect(applyCodexConnectedServiceAuthGeneration({
            client,
            candidate,
            forcedWorkspaceId: 'workspace-work',
            refreshSelection: {
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'team',
                activeProfileId: 'work',
                fallbackProfileId: 'backup',
                generation: 2,
            },
            updateRefreshSelection,
        })).resolves.toEqual({
            applied: true,
            appliedVia: 'direct_live_hot_auth',
            activeAccountId: 'workspace-work',
        });

        expect(client.request).toHaveBeenCalledWith('account/login/start', {
            type: 'chatgptAuthTokens',
            accessToken: 'access',
            chatgptAccountId: 'workspace-work',
        });
        expect(updateRefreshSelection).toHaveBeenCalledWith({
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'work',
            fallbackProfileId: 'backup',
            generation: 2,
        });
        expect(order).toEqual(['refresh-selection', 'login']);
    });

    it('rolls back an armed refresh bridge selection when live login fails before mutation', async () => {
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
        const order: string[] = [];
        const client = {
            request: vi.fn(async () => {
                order.push('login');
                throw new Error('forced_chatgpt_workspace_id rejected supplied chatgptAccountId');
            }),
        };
        const updateRefreshSelection = vi.fn(async () => {
            order.push('refresh-selection');
            return async () => {
                order.push('rollback');
            };
        });

        await expect(applyCodexConnectedServiceAuthGeneration({
            client,
            candidate,
            forcedWorkspaceId: null,
            refreshSelection: {
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'team',
                activeProfileId: 'work',
                fallbackProfileId: 'backup',
                generation: 2,
            },
            updateRefreshSelection,
        })).resolves.toEqual({
            applied: false,
            reason: 'workspace_incompatible',
        });

        expect(updateRefreshSelection).toHaveBeenCalledOnce();
        expect(order).toEqual(['refresh-selection', 'login', 'rollback']);
    });

    it('applies direct live auth while a Codex turn is in flight', async () => {
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
        const updateRefreshSelection = vi.fn(async () => undefined);

        await expect(applyCodexConnectedServiceAuthGeneration({
            client,
            candidate,
            forcedWorkspaceId: 'workspace-work',
            refreshSelection: {
                kind: 'profile',
                serviceId: 'openai-codex',
                profileId: 'work',
            },
            updateRefreshSelection,
        })).resolves.toEqual({
            applied: true,
            appliedVia: 'direct_live_hot_auth',
            activeAccountId: 'workspace-work',
        });

        expect(client.request).toHaveBeenCalledWith('account/login/start', {
            type: 'chatgptAuthTokens',
            accessToken: 'access',
            chatgptAccountId: 'workspace-work',
        });
        expect(updateRefreshSelection).toHaveBeenCalledWith({
            kind: 'profile',
            serviceId: 'openai-codex',
            profileId: 'work',
        });
    });

    it('does not fabricate exact account identity from labels when providerAccountId is missing', async () => {
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
                providerAccountId: null,
                providerEmail: 'work@example.test',
            },
        });
        const client = { request: vi.fn(async () => ({ ok: true })) };

        await expect(applyCodexConnectedServiceAuthGeneration({
            client,
            candidate,
            forcedWorkspaceId: null,
        })).resolves.toEqual({
            applied: false,
            reason: 'provider_account_identity_unavailable',
        });

        expect(client.request).not.toHaveBeenCalled();
    });
});
