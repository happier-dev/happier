import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
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

async function createClient(token = 'fake-token', options: Readonly<{ connected?: boolean; ack?: unknown }> = {}) {
    sessionSocketStub = createApiSessionSocketStub({ connected: options.connected ?? true,
        emitWithAck: (event) => event === 'usage-event'
            ? options.ack ?? { success: true, eventId: 'evt-socket', createdAt: 1 } : { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { ApiSessionClient } = await import('./sessionClient');
    return createTestApiSessionClient(ApiSessionClient, token, createPlainSessionFixture({ id: 'session-1' }));
}

function usageEmits() {
    return sessionSocketStub?.emitWithAck.mock.calls.filter(([event]) => event === 'usage-event') ?? [];
}

afterEach(() => {
    vi.restoreAllMocks();
    sessionSocketStub = null;
    userSocketStub = null;
});

describe('ApiSessionClient usage transport', () => {
    it('publishes one usage observation as one acknowledged Session-socket emit and no HTTP POST', async () => {
        vi.resetModules();
        fetchServerFeaturesSnapshotMock.mockResolvedValue(readyUsageFeatures());
        readStoredCredentialsMock.mockResolvedValue({ token: 'fake-token' });
        const axios = (await import('axios')).default as any;
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ data: { success: true, eventId: 'evt-1', createdAt: 1 } });
        const client = await createClient();

        await expect(client.publishUsageObservation({ observation: usageObservation('codex') }))
            .resolves.toEqual({ status: 'sent', transport: 'socket' });

        expect(postSpy).not.toHaveBeenCalled();
        expect(fetchServerFeaturesSnapshotMock).not.toHaveBeenCalled();
        expect(usageEmits()).toHaveLength(1);
        expect(usageEmits()[0]?.[1]).toEqual(expect.objectContaining({ sessionId: 'session-1', agentId: 'codex', scope: 'turn_delta' }));
        expect(sessionSocketStub?.emit.mock.calls.some((call) => call[0] === 'usage-report')).toBe(false);
        await client.close();
    });

    it('preserves backend mode and caller-owned stable external keys at the explicit publisher boundary', async () => {
        vi.resetModules();
        readStoredCredentialsMock.mockResolvedValue({ token: 'fake-token' });
        const client = await createClient();

        await client.publishUsageObservation({
            observation: usageObservation('opencode'),
            backendMode: 'server',
            externalKey: 'opencode-message:1',
        });

        expect(usageEmits()[0]?.[1]).toEqual(expect.objectContaining({
            agentId: 'opencode',
            backendMode: 'server',
            externalKey: 'opencode-message:1',
        }));
        await client.close();
    });

    it('reports a refused acknowledgement as a typed publish failure without a second transport', async () => {
        vi.resetModules();
        readStoredCredentialsMock.mockResolvedValue({ token: 'fake-token' });
        const axios = (await import('axios')).default as any;
        const postSpy = vi.spyOn(axios, 'post');
        const client = await createClient('fake-token', { ack: { success: false, error: 'Forbidden' } });

        await expect(client.publishUsageObservation({ observation: usageObservation('codex') }))
            .resolves.toEqual({ status: 'failed' });

        expect(usageEmits()).toHaveLength(1);
        expect(postSpy).not.toHaveBeenCalled();
        await client.close();
    });

    it('delivers a usage observation exactly once over v2 HTTP ingest while the Session socket is disconnected', async () => {
        vi.resetModules();
        readStoredCredentialsMock.mockResolvedValue({ token: 'fake-token' });
        const axios = (await import('axios')).default as any;
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ data: { success: true, eventId: 'evt-http', createdAt: 1 } });
        const client = await createClient('fake-token', { connected: false });

        await expect(client.publishUsageObservation({ observation: usageObservation('codex') }))
            .resolves.toEqual({ status: 'sent', transport: 'http' });

        expect(usageEmits()).toHaveLength(0);
        expect(postSpy.mock.calls.map(([url, body]) => [new URL(String(url)).pathname, (body as { sessionId?: string }).sessionId]))
            .toEqual([['/v2/usage-events', 'session-1']]);
        await client.close();
    });

    it('delivers through v2 HTTP ingest, refreshing credentials once, while the Session socket is disconnected', async () => {
        vi.resetModules();
        readStoredCredentialsMock.mockResolvedValue({ token: 'fresh-token' });
        const axios = (await import('axios')).default as any;
        const postSpy = vi.spyOn(axios, 'post')
            .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { response: { status: 401 } }))
            .mockResolvedValueOnce({ data: { success: true, eventId: 'evt-2', createdAt: 2 } });
        const client = await createClient('stale-token', { connected: false });

        await expect(client.publishUsageObservation({ observation: usageObservation('opencode', 18) }))
            .resolves.toEqual({ status: 'sent', transport: 'http' });

        expect(usageEmits()).toHaveLength(0);
        expect(postSpy.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/v2/usage-events', '/v2/usage-events']);
        expect(postSpy.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
            headers: expect.objectContaining({ Authorization: 'Bearer stale-token' }),
        }));
        expect(postSpy.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
            headers: expect.objectContaining({ Authorization: 'Bearer fresh-token' }),
        }));
        await client.close();
    });
});
