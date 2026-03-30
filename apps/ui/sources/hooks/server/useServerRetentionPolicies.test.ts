import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('useServerRetentionPolicies', () => {
    it('returns retention capabilities keyed by server id for cached ready snapshots', async () => {
        vi.resetModules();

        const { buildServerFeaturesResponse } = await import('./serverFeaturesTestUtils');
        const { resetServerFeaturesClientForTests, getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');

        resetServerFeaturesClientForTests();

        const serverA = upsertServerProfile({ serverUrl: 'https://retention-a.example', name: 'Retention A', source: 'manual' });
        const serverB = upsertServerProfile({ serverUrl: 'https://retention-b.example', name: 'Retention B', source: 'manual' });

        const payloadByUrl = new Map<string, ReturnType<typeof buildServerFeaturesResponse>>([
            [
                'https://retention-a.example',
                Object.assign(buildServerFeaturesResponse(), {
                    capabilities: {
                        server: {
                            retention: {
                                policyVersion: 1,
                                enabled: true,
                                sessions: {
                                    mode: 'delete_inactive',
                                    inactivityDays: 30,
                                    requires: ['updatedAt', 'lastActiveAt'],
                                },
                                accountChanges: { mode: 'keep_forever' },
                                voiceSessionLeases: { mode: 'keep_forever' },
                                userFeedItems: { mode: 'keep_forever' },
                                sessionShareAccessLogs: { mode: 'keep_forever' },
                                publicShareAccessLogs: { mode: 'keep_forever' },
                                terminalAuthRequests: { mode: 'keep_forever' },
                                accountAuthRequests: { mode: 'keep_forever' },
                                authPairingSessions: { mode: 'keep_forever' },
                                repeatKeys: { mode: 'keep_forever' },
                                globalLocks: { mode: 'keep_forever' },
                                automationRuns: { mode: 'keep_forever' },
                                automationRunEvents: { mode: 'keep_forever' },
                            },
                        },
                    },
                }),
            ],
            [
                'https://retention-b.example',
                Object.assign(buildServerFeaturesResponse(), {
                    capabilities: {
                        server: {
                            retention: {
                                policyVersion: 1,
                                enabled: false,
                                sessions: { mode: 'keep_forever' },
                                accountChanges: { mode: 'keep_forever' },
                                voiceSessionLeases: { mode: 'keep_forever' },
                                userFeedItems: { mode: 'keep_forever' },
                                sessionShareAccessLogs: { mode: 'keep_forever' },
                                publicShareAccessLogs: { mode: 'keep_forever' },
                                terminalAuthRequests: { mode: 'keep_forever' },
                                accountAuthRequests: { mode: 'keep_forever' },
                                authPairingSessions: { mode: 'keep_forever' },
                                repeatKeys: { mode: 'keep_forever' },
                                globalLocks: { mode: 'keep_forever' },
                                automationRuns: { mode: 'keep_forever' },
                                automationRunEvents: { mode: 'keep_forever' },
                            },
                        },
                    },
                }),
            ],
        ]);

        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ ok: true }),
                };
            }
            const base = url.replace(/\/v1\/features$/, '');
            const payload = payloadByUrl.get(base);
            if (!payload) throw new Error(`Unexpected fetch: ${url}`);
            return {
                ok: true,
                status: 200,
                json: async () => payload,
            };
        }) as any);

        await getServerFeaturesSnapshot({ serverId: serverA.id, force: true });
        await getServerFeaturesSnapshot({ serverId: serverB.id, force: true });

        const { useServerRetentionPolicies } = await import('./useServerRetentionPolicies');
        const serverIds = [serverA.id, serverB.id];
        const seen = await renderHookAndCollectValues(() => useServerRetentionPolicies(serverIds));

        expect(seen.at(-1)).toMatchObject({
            [serverA.id]: {
                enabled: true,
                sessions: {
                    mode: 'delete_inactive',
                    inactivityDays: 30,
                },
            },
            [serverB.id]: {
                enabled: false,
                sessions: { mode: 'keep_forever' },
            },
        });
    });

    it('stays stable when the caller passes a freshly allocated server id array', async () => {
        vi.resetModules();

        const { buildServerFeaturesResponse } = await import('./serverFeaturesTestUtils');
        const { resetServerFeaturesClientForTests, getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');

        resetServerFeaturesClientForTests();

        const server = upsertServerProfile({ serverUrl: 'https://retention-inline.example', name: 'Retention Inline', source: 'manual' });
        const payload = Object.assign(buildServerFeaturesResponse(), {
            capabilities: {
                server: {
                    retention: {
                        policyVersion: 1,
                        enabled: true,
                        sessions: {
                            mode: 'delete_inactive',
                            inactivityDays: 14,
                            requires: ['updatedAt', 'lastActiveAt'],
                        },
                        accountChanges: { mode: 'keep_forever' },
                        voiceSessionLeases: { mode: 'keep_forever' },
                        userFeedItems: { mode: 'keep_forever' },
                        sessionShareAccessLogs: { mode: 'keep_forever' },
                        publicShareAccessLogs: { mode: 'keep_forever' },
                        terminalAuthRequests: { mode: 'keep_forever' },
                        accountAuthRequests: { mode: 'keep_forever' },
                        authPairingSessions: { mode: 'keep_forever' },
                        repeatKeys: { mode: 'keep_forever' },
                        globalLocks: { mode: 'keep_forever' },
                        automationRuns: { mode: 'keep_forever' },
                        automationRunEvents: { mode: 'keep_forever' },
                    },
                },
            },
        });

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => payload,
        })) as any);

        await getServerFeaturesSnapshot({ serverId: server.id, force: true });

        const { useServerRetentionPolicies } = await import('./useServerRetentionPolicies');
        const seen = await renderHookAndCollectValues(() => useServerRetentionPolicies([server.id]));

        expect(seen.at(-1)).toMatchObject({
            [server.id]: {
                enabled: true,
                sessions: {
                    mode: 'delete_inactive',
                    inactivityDays: 14,
                },
            },
        });
    }, 5_000);
});
