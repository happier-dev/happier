import { beforeEach, describe, expect, it, vi } from 'vitest';

const serverFetchSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/http/client', () => ({
    serverFetch: serverFetchSpy,
}));

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('plugin permission grants HTTP action executor', () => {
    beforeEach(() => {
        serverFetchSpy.mockReset();
    });

    it('executes grant lifecycle actions through authenticated generic routes', async () => {
        const grant = {
            v: 1,
            id: 'grant-1',
            accountId: 'account-1',
            pluginId: 'review-coderabbit',
            capability: 'reviews.comments.write.direct',
            targetScope: { kind: 'project', projectId: 'project-1' },
            status: 'active',
            requestId: 'request-1',
            grantedByUserId: 'account-1',
            grantedAt: 2,
            createdAt: 2,
            updatedAt: 2,
        };
        serverFetchSpy.mockResolvedValueOnce(jsonResponse({ grants: [grant], pendingRequests: [] }));

        const { createPluginPermissionGrantHttpActionExecutor } = await import('./api');
        const execute = createPluginPermissionGrantHttpActionExecutor();
        await expect(execute('plugins.permissions.grants.list', {
            pluginId: 'review-coderabbit',
            capability: 'reviews.comments.write.direct',
            targetScope: { kind: 'project', projectId: 'project-1' },
        })).resolves.toEqual({ grants: [grant], pendingRequests: [] });

        expect(serverFetchSpy).toHaveBeenCalledWith(
            '/v1/plugins/permissions/grants/list',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    pluginId: 'review-coderabbit',
                    capability: 'reviews.comments.write.direct',
                    targetScope: { kind: 'project', projectId: 'project-1' },
                    includeRevoked: false,
                    includeResolvedRequests: false,
                    limit: 50,
                }),
            }),
            { includeAuth: true },
        );
    });

    it('surfaces route error codes instead of treating failures as grant state', async () => {
        serverFetchSpy.mockResolvedValueOnce(jsonResponse({ error: 'plugin_permission_authentication_required' }, 401));
        const { createPluginPermissionGrantHttpActionExecutor } = await import('./api');
        const execute = createPluginPermissionGrantHttpActionExecutor();

        await expect(execute('plugins.permissions.grants.grant', { requestId: 'request-1' }))
            .rejects.toThrow('plugin_permission_authentication_required');
    });
});
