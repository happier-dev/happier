import { describe, expect, it, vi } from 'vitest';

type ActionsModule = Readonly<{
    createPluginPermissionGrantActions: (params: Readonly<{ execute: (actionId: string, input: unknown) => Promise<unknown> }>) => Readonly<{
        list: (input: unknown) => Promise<unknown>;
        request: (input: unknown) => Promise<unknown>;
        grant: (input: unknown) => Promise<unknown>;
        revoke: (input: unknown) => Promise<unknown>;
        dismissRequest: (input: unknown) => Promise<unknown>;
    }>;
}>;

async function loadActions(): Promise<ActionsModule | null> {
    try {
        return await import('./actions') as unknown as ActionsModule;
    } catch {
        return null;
    }
}

describe('plugin permission grant UI actions', () => {
    it('routes grant lifecycle operations through generic ActionSpec ids', async () => {
        const mod = await loadActions();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const execute = vi.fn(async (actionId: string, input: unknown) => {
            const pendingRequest = {
                v: 1,
                id: 'request-1',
                accountId: 'account-1',
                pluginId: 'review-coderabbit',
                capability: 'reviews.comments.write.direct',
                targetScope: { kind: 'workspace', workspaceId: 'workspace-1' },
                requester: { kind: 'plugin', pluginId: 'review-coderabbit', sessionId: 'session-1' },
                reason: 'Write approved comments directly.',
                status: actionId === 'plugins.permissions.grants.dismissRequest' ? 'dismissed' : 'pending',
                createdAt: 1,
                updatedAt: 1,
            };
            const grant = {
                v: 1,
                id: 'grant-1',
                accountId: 'account-1',
                pluginId: 'review-coderabbit',
                capability: 'reviews.comments.write.direct',
                targetScope: { kind: 'workspace', workspaceId: 'workspace-1' },
                status: actionId === 'plugins.permissions.grants.revoke' ? 'revoked' : 'active',
                requestId: 'request-1',
                grantedByUserId: 'account-1',
                grantedAt: 2,
                createdAt: 2,
                updatedAt: 2,
            };
            if (actionId === 'plugins.permissions.grants.list') return { grants: [], pendingRequests: [] };
            if (actionId === 'plugins.permissions.grants.request') return { pendingRequest };
            if (actionId === 'plugins.permissions.grants.grant') return { grant, pendingRequest: { ...pendingRequest, status: 'granted', grantId: 'grant-1', decidedAt: 2 } };
            if (actionId === 'plugins.permissions.grants.revoke') return { grant };
            return { pendingRequest };
        });
        const actions = mod.createPluginPermissionGrantActions({ execute });

        await actions.list({ pluginId: 'review-coderabbit' });
        await actions.request({
            pluginId: 'review-coderabbit',
            capability: 'reviews.comments.write.direct',
            targetScope: { kind: 'workspace', workspaceId: 'workspace-1' },
            requester: { kind: 'plugin', pluginId: 'review-coderabbit', sessionId: 'session-1' },
            reason: 'Write approved comments directly.',
        });
        await actions.grant({ requestId: 'request-1' });
        await actions.revoke({ grantId: 'grant-1' });
        await actions.dismissRequest({ requestId: 'request-1' });

        expect(execute.mock.calls).toEqual([
            ['plugins.permissions.grants.list', {
                pluginId: 'review-coderabbit',
                includeRevoked: false,
                includeResolvedRequests: false,
                limit: 50,
            }],
            ['plugins.permissions.grants.request', {
                pluginId: 'review-coderabbit',
                capability: 'reviews.comments.write.direct',
                targetScope: { kind: 'workspace', workspaceId: 'workspace-1' },
                requester: { kind: 'plugin', pluginId: 'review-coderabbit', sessionId: 'session-1' },
                reason: 'Write approved comments directly.',
            }],
            ['plugins.permissions.grants.grant', { requestId: 'request-1' }],
            ['plugins.permissions.grants.revoke', { grantId: 'grant-1' }],
            ['plugins.permissions.grants.dismissRequest', { requestId: 'request-1' }],
        ]);
    });
});
