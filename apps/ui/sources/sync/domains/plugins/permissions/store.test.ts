import { describe, expect, it } from 'vitest';

type StoreModule = Readonly<{
    createEmptyPluginPermissionGrantState: () => unknown;
    beginPluginPermissionGrantRefresh: (state: unknown) => unknown;
    applyPluginPermissionGrantList: (state: unknown, response: unknown) => unknown;
    upsertPluginPermissionPendingRequest: (state: unknown, request: unknown) => unknown;
    applyPluginPermissionGrantApproved: (state: unknown, result: unknown) => unknown;
    applyPluginPermissionGrantRevoked: (state: unknown, result: unknown) => unknown;
    applyPluginPermissionGrantRequestDismissed: (state: unknown, result: unknown) => unknown;
    hasPluginPermissionGrant: (state: unknown, input: unknown) => boolean;
    selectPluginPermissionPendingRequests: (state: unknown, filters?: unknown) => readonly unknown[];
}>;

async function loadStore(): Promise<StoreModule | null> {
    try {
        return await import('./store') as unknown as StoreModule;
    } catch {
        return null;
    }
}

const workspaceScope = { kind: 'workspace', workspaceId: 'workspace-1' } as const;
const projectScope = { kind: 'project', projectId: 'project-1' } as const;
const capability = 'reviews.comments.write.direct';

function pendingRequest(overrides: Record<string, unknown> = {}) {
    return {
        id: 'request-1',
        pluginId: 'review-coderabbit',
        pluginName: 'CodeRabbit',
        capability,
        targetScope: workspaceScope,
        requester: { kind: 'plugin', pluginId: 'review-coderabbit', sessionId: 'session-1' },
        reason: 'Write approved review comments without another prompt.',
        status: 'pending',
        requestedAt: 1,
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    };
}

function grant(overrides: Record<string, unknown> = {}) {
    return {
        id: 'grant-1',
        pluginId: 'review-coderabbit',
        capability,
        targetScope: workspaceScope,
        status: 'active',
        grantedAt: 2,
        createdAt: 2,
        updatedAt: 2,
        ...overrides,
    };
}

describe('plugin permission grant UI state', () => {
    it('preserves trusted grants and pending requests while refresh is in flight', async () => {
        const store = await loadStore();
        expect(store).not.toBeNull();
        if (!store) return;

        const loaded = store.applyPluginPermissionGrantList(
            store.beginPluginPermissionGrantRefresh(store.createEmptyPluginPermissionGrantState()),
            {
                grants: [grant()],
                pendingRequests: [pendingRequest()],
                cursor: null,
            },
        );

        expect(store.hasPluginPermissionGrant(loaded, {
            pluginId: 'review-coderabbit',
            capability,
            targetScope: workspaceScope,
        })).toBe(true);
        expect(store.selectPluginPermissionPendingRequests(loaded, { capability })).toHaveLength(1);

        const refreshing = store.beginPluginPermissionGrantRefresh(loaded);

        expect(store.hasPluginPermissionGrant(refreshing, {
            pluginId: 'review-coderabbit',
            capability,
            targetScope: workspaceScope,
        })).toBe(true);
        expect(store.selectPluginPermissionPendingRequests(refreshing, { capability })).toHaveLength(1);
    });

    it('matches target scopes exactly without broadening account grants into scoped checks', async () => {
        const store = await loadStore();
        expect(store).not.toBeNull();
        if (!store) return;

        const withRequest = store.upsertPluginPermissionPendingRequest(
            store.createEmptyPluginPermissionGrantState(),
            pendingRequest(),
        );
        expect(store.selectPluginPermissionPendingRequests(withRequest, { pluginId: 'review-coderabbit' })).toHaveLength(1);

        const approved = store.applyPluginPermissionGrantApproved(withRequest, {
            grant: grant(),
            pendingRequest: pendingRequest({ status: 'granted', grantId: 'grant-1', decidedAt: 2 }),
        });
        expect(store.hasPluginPermissionGrant(approved, {
            pluginId: 'review-coderabbit',
            capability,
            targetScope: workspaceScope,
        })).toBe(true);
        expect(store.hasPluginPermissionGrant(approved, {
            pluginId: 'review-coderabbit',
            capability,
            targetScope: projectScope,
        })).toBe(false);
        const accountWide = store.applyPluginPermissionGrantList(store.createEmptyPluginPermissionGrantState(), {
            grants: [grant({ id: 'account-grant', targetScope: { kind: 'account' } })],
            pendingRequests: [pendingRequest({ id: 'account-request', targetScope: { kind: 'account' } })],
        });
        expect(store.hasPluginPermissionGrant(accountWide, {
            pluginId: 'review-coderabbit',
            capability,
            targetScope: projectScope,
        })).toBe(false);
        expect(store.hasPluginPermissionGrant(accountWide, {
            pluginId: 'review-coderabbit',
            capability,
            targetScope: workspaceScope,
        })).toBe(false);
        expect(store.hasPluginPermissionGrant(accountWide, {
            pluginId: 'review-coderabbit',
            capability,
            targetScope: { kind: 'account' },
        })).toBe(true);
        expect(store.hasPluginPermissionGrant(accountWide, {
            pluginId: 'review-coderabbit',
            capability,
            targetScope: null,
        })).toBe(false);
        expect(store.selectPluginPermissionPendingRequests(accountWide, { targetScope: projectScope })).toHaveLength(0);
        expect(store.selectPluginPermissionPendingRequests(accountWide, { targetScope: { kind: 'account' } })).toHaveLength(1);
        expect(store.selectPluginPermissionPendingRequests(accountWide, { targetScope: null })).toHaveLength(0);
        expect(store.selectPluginPermissionPendingRequests(approved)).toHaveLength(0);

        const revoked = store.applyPluginPermissionGrantRevoked(approved, {
            grant: grant({ status: 'revoked', revokedAt: 3 }),
        });
        expect(store.hasPluginPermissionGrant(revoked, {
            pluginId: 'review-coderabbit',
            capability,
            targetScope: workspaceScope,
        })).toBe(false);

        const dismissed = store.applyPluginPermissionGrantRequestDismissed(withRequest, {
            pendingRequest: pendingRequest({ status: 'dismissed', decidedAt: 3 }),
        });
        expect(store.selectPluginPermissionPendingRequests(dismissed)).toHaveLength(0);
    });

    it('does not treat revoked grants or resolved requests as trusted active state', async () => {
        const store = await loadStore();
        expect(store).not.toBeNull();
        if (!store) return;

        const loaded = store.applyPluginPermissionGrantList(store.createEmptyPluginPermissionGrantState(), {
            grants: [grant({ id: 'revoked-grant', status: 'revoked', revokedAt: 3 })],
            pendingRequests: [pendingRequest({ id: 'resolved-request', status: 'granted', grantId: 'revoked-grant', decidedAt: 3 })],
        });

        expect(store.hasPluginPermissionGrant(loaded, {
            pluginId: 'review-coderabbit',
            capability,
            targetScope: workspaceScope,
        })).toBe(false);
        expect(store.selectPluginPermissionPendingRequests(loaded, { capability })).toHaveLength(0);
    });
});
