import { afterEach, describe, expect, it, vi } from 'vitest';

import { FeaturesResponseSchema } from '@happier-dev/protocol';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
    type ApiSessionSocketStub,
    createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;

const { fetchServerFeaturesSnapshotMock, readStoredCredentialsMock } = vi.hoisted(() => ({
    fetchServerFeaturesSnapshotMock: vi.fn(),
    readStoredCredentialsMock: vi.fn(),
}));

vi.mock('@/features/serverFeaturesClient', () => ({
    fetchServerFeaturesSnapshot: (params: unknown) => fetchServerFeaturesSnapshotMock(params),
}));

vi.mock('@/persistence', () => ({
    readCredentials: () => readStoredCredentialsMock(),
    readStoredCredentials: () => readStoredCredentialsMock(),
}));

vi.mock('./sockets', () => ({
    createUserScopedSocket: () => {
        if (!userSocketStub) throw new Error('Missing user socket stub');
        return userSocketStub as any;
    },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
    createSessionSocketTransport: () => {
        if (!sessionSocketStub) throw new Error('Missing session socket stub');
        return {
            socket: sessionSocketStub as any,
            transport: {
                connect: async () => {},
                disconnect: async () => {},
                destroy: async () => {},
                isConnected: () => sessionSocketStub?.connected === true,
                onConnected: () => () => {},
                onDisconnected: () => () => {},
                onError: () => () => {},
            },
        };
    },
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
    DEFAULT_MANAGED_CONNECTION_POLICY: {},
    createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
        start: async () => {
            params.createTransport();
            await params.onConnected?.();
        },
        stop: async () => {},
    }),
}));

function readyUsageFeatures() {
    return {
        status: 'ready' as const,
        features: FeaturesResponseSchema.parse({
            features: {},
            capabilities: {
                server: {
                    usageAnalytics: {
                        version: 1,
                        eventsIngest: { path: '/v2/usage-events' },
                        query: { path: '/v2/usage/query' },
                        legacy: {
                            usageReportsPath: '/v2/usage-reports',
                            usageQueryPath: '/v1/usage/query',
                        },
                    },
                },
            },
        }),
    };
}

function usageObservation(provider: string, total = 9) {
    return {
        provider,
        source: `${provider}-token-count`,
        scope: 'turn_delta' as const,
        key: `${provider}-usage-key`,
        modelId: null,
        tokens: { total, input: 4, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cost: null,
        contextUsedTokens: null,
        contextWindowTokens: null,
    };
}

async function createClient(token = 'fake-token') {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { ApiSessionClient } = await import('./sessionClient');
    return new ApiSessionClient(token, createPlainSessionFixture({ id: 'session-1' }));
}

afterEach(() => {
    vi.restoreAllMocks();
    sessionSocketStub = null;
    userSocketStub = null;
});

describe('ApiSessionClient usage transport', () => {
    it('publishes an explicit usage observation through v2 analytics ingest when available', async () => {
        vi.resetModules();
        fetchServerFeaturesSnapshotMock.mockResolvedValue(readyUsageFeatures());
        readStoredCredentialsMock.mockResolvedValue({ token: 'fake-token' });
        const axios = (await import('axios')).default as any;
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ data: { success: true, eventId: 'evt-1', createdAt: 1 } });
        const client = await createClient();

        await client.publishUsageObservation({ observation: usageObservation('codex') });

        expect(postSpy).toHaveBeenCalledWith(
            expect.stringContaining('/v2/usage-events'),
            expect.objectContaining({ sessionId: 'session-1', agentId: 'codex' }),
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer fake-token' }) }),
        );
        expect(sessionSocketStub?.emit.mock.calls.some((call) => call[0] === 'usage-report')).toBe(false);
        await client.close();
    });

    it('preserves backend mode and caller-owned stable external keys at the explicit publisher boundary', async () => {
        vi.resetModules();
        fetchServerFeaturesSnapshotMock.mockResolvedValue(readyUsageFeatures());
        readStoredCredentialsMock.mockResolvedValue({ token: 'fake-token' });
        const axios = (await import('axios')).default as any;
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ data: { success: true, eventId: 'evt-open', createdAt: 1 } });
        const client = await createClient();

        await client.publishUsageObservation({
            observation: usageObservation('opencode'),
            backendMode: 'server',
            externalKey: 'opencode-message:1',
        });

        expect(postSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
            agentId: 'opencode',
            backendMode: 'server',
            externalKey: 'opencode-message:1',
        }));
        await client.close();
    });

    it('falls back to the legacy usage-report transport when v2 ingest is unavailable', async () => {
        vi.resetModules();
        fetchServerFeaturesSnapshotMock.mockResolvedValue({ status: 'unsupported', reason: 'endpoint_missing' });
        readStoredCredentialsMock.mockResolvedValue({ token: 'fake-token' });
        const axios = (await import('axios')).default as any;
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ data: { success: true } });
        const client = await createClient();

        await client.publishUsageObservation({ observation: usageObservation('codex') });

        expect(postSpy).not.toHaveBeenCalled();
        expect(sessionSocketStub?.emit.mock.calls.find((call) => call[0] === 'usage-report')?.[1]).toEqual({
            key: 'codex-usage-key',
            sessionId: 'session-1',
            tokens: { total: 9, input: 4, output: 5 },
            cost: { total: 0 },
        });
        await client.close();
    });

    it('refreshes stored credentials and retries v2 ingest once after authentication failure', async () => {
        vi.resetModules();
        fetchServerFeaturesSnapshotMock.mockResolvedValue(readyUsageFeatures());
        readStoredCredentialsMock.mockResolvedValue({ token: 'fresh-token' });
        const axios = (await import('axios')).default as any;
        const postSpy = vi.spyOn(axios, 'post')
            .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { response: { status: 401 } }))
            .mockResolvedValueOnce({ data: { success: true, eventId: 'evt-2', createdAt: 2 } });
        const client = await createClient('stale-token');

        await client.publishUsageObservation({ observation: usageObservation('opencode', 18) });

        expect(readStoredCredentialsMock).toHaveBeenCalledTimes(1);
        expect(postSpy.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
            headers: expect.objectContaining({ Authorization: 'Bearer stale-token' }),
        }));
        expect(postSpy.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
            headers: expect.objectContaining({ Authorization: 'Bearer fresh-token' }),
        }));
        expect(sessionSocketStub?.emit.mock.calls.some((call) => call[0] === 'usage-report')).toBe(false);
        await client.close();
    });
});
