import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('useServerRetentionPolicy', () => {
    it('returns server retention capabilities for the requested server', async () => {
        const { buildServerFeaturesResponse } = await import('./serverFeaturesTestUtils');
        const { resetServerFeaturesClientForTests, getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { resetServerRetentionPolicyClientForTests } = await import('@/sync/api/capabilities/serverRetentionPolicyClient');
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');

        resetServerFeaturesClientForTests();
        resetServerRetentionPolicyClientForTests();

        const server = upsertServerProfile({ serverUrl: 'https://retention.example', name: 'Retention', source: 'manual' });
        const payload = buildServerFeaturesResponse();
        payload.capabilities.server = {
            retention: {
                policyVersion: 1,
                enabled: true,
                sessions: {
                    mode: 'delete_inactive',
                    inactivityDays: 30,
                    requires: ['updatedAt', 'lastActiveAt'],
                },
                accountChanges: { mode: 'delete_older_than', days: 30 },
                usageEvents: { mode: 'keep_forever' },
                voiceSessionLeases: { mode: 'keep_forever' },
                userFeedItems: { mode: 'delete_older_than', days: 90 },
                sessionShareAccessLogs: { mode: 'delete_older_than', days: 30 },
                publicShareAccessLogs: { mode: 'delete_older_than', days: 30 },
                terminalAuthRequests: { mode: 'delete_older_than', days: 7 },
                accountAuthRequests: { mode: 'delete_older_than', days: 7 },
                authPairingSessions: { mode: 'delete_older_than', days: 7 },
                repeatKeys: { mode: 'delete_older_than', days: 7 },
                globalLocks: { mode: 'delete_older_than', days: 7 },
                automationRuns: { mode: 'delete_older_than', days: 30 },
                automationRunEvents: { mode: 'delete_older_than', days: 30 },
            },
        };

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => payload,
        })) as any);

        await getServerFeaturesSnapshot({ serverId: server.id, force: true });

        const { useServerRetentionPolicy } = await import('./useServerRetentionPolicy');
        const seen = await renderHookAndCollectValues(() => useServerRetentionPolicy(server.id));

        expect(seen.at(-1)).toMatchObject({
            enabled: true,
            completeness: 'legacy_partial',
            domains: expect.arrayContaining([expect.objectContaining({
                id: 'sessions',
                policy: expect.objectContaining({ mode: 'delete_inactive', inactivityDays: 30 }),
            })]),
        });
    });
});
