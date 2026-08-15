import { beforeEach, describe, expect, it, vi } from 'vitest';

const serverFetch = vi.hoisted(() => vi.fn());
const getServerFeaturesSnapshot = vi.hoisted(() => vi.fn());

vi.mock('@/sync/http/client', () => ({ serverFetch }));
vi.mock('./serverFeaturesClient', () => ({ getServerFeaturesSnapshot }));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-a', serverUrl: 'https://relay.example', generation: 1 }),
}));
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    areServerProfileIdentifiersEquivalent: (left: string, right: string) => left === right,
    getServerProfileById: () => null,
    resolveServerProfileScopeIdForIdentifier: (id: string) => id,
}));
vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: vi.fn(),
}));

describe('serverRetentionPolicyClient', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const { resetServerRetentionPolicyClientForTests } = await import('./serverRetentionPolicyClient');
        resetServerRetentionPolicyClientForTests();
    });

    it('uses the complete v2 policy and preserves an unknown domain id', async () => {
        getServerFeaturesSnapshot.mockResolvedValue({ status: 'unsupported', reason: 'endpoint_missing' });
        serverFetch.mockResolvedValue(new Response(JSON.stringify({
            version: 2,
            enabled: true,
            complete: true,
            domains: [{ id: 'futureDomain', policy: { mode: 'delete_older_than', days: 9 } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));

        const { getServerRetentionPolicy } = await import('./serverRetentionPolicyClient');
        await expect(getServerRetentionPolicy({ serverId: 'server-a' })).resolves.toEqual({
            enabled: true,
            completeness: 'complete',
            domains: [{ id: 'futureDomain', policy: { mode: 'delete_older_than', days: 9 } }],
        });
    });

    it('falls back to an explicitly incomplete v1 projection on older servers', async () => {
        getServerFeaturesSnapshot.mockResolvedValue({
            status: 'ready',
            features: {
                capabilities: {
                    server: {
                        retention: {
                            policyVersion: 1,
                            enabled: true,
                            sessions: { mode: 'delete_inactive', inactivityDays: 30, requires: ['updatedAt', 'lastActiveAt'] },
                        },
                    },
                },
            },
        });
        serverFetch.mockResolvedValue(new Response(null, { status: 404 }));

        const { getServerRetentionPolicy } = await import('./serverRetentionPolicyClient');
        await expect(getServerRetentionPolicy({ serverId: 'server-a' })).resolves.toMatchObject({
            enabled: true,
            completeness: 'legacy_partial',
            domains: [{ id: 'sessions', policy: { mode: 'delete_inactive', inactivityDays: 30 } }],
        });
    });
});
