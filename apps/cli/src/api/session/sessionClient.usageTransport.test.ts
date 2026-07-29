import { describe, expect, it, vi } from 'vitest';

import { FeaturesResponseSchema } from '@happier-dev/protocol';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import {
    type ApiSessionSocketStub,
    createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;

const { fetchServerFeaturesSnapshotMock } = vi.hoisted(() => ({
    fetchServerFeaturesSnapshotMock: vi.fn(),
}));
const { readCredentialsMock } = vi.hoisted(() => ({
    readCredentialsMock: vi.fn(),
}));

vi.mock('@/features/serverFeaturesClient', () => ({
    fetchServerFeaturesSnapshot: (params: unknown) => fetchServerFeaturesSnapshotMock(params),
}));

vi.mock('@/persistence', () => ({
    readCredentials: () => readCredentialsMock(),
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

describe('ApiSessionClient usage transport', () => {
    it('publishes token_count usage through v2 analytics ingest when available', async () => {
        vi.resetModules();
        fetchServerFeaturesSnapshotMock.mockReset();
        readCredentialsMock.mockReset();
        readCredentialsMock.mockResolvedValue({ token: 'fake-token' });
        fetchServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'ready',
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
        });
        sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
        userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ data: { success: true, eventId: 'evt-1', createdAt: 1 } });

        const { ApiSessionClient } = await import('./sessionClient');
        const client = new ApiSessionClient('fake-token', createPlainSessionFixture({ id: 'session-1' }));
        const sessionSocket = sessionSocketStub;
        if (!sessionSocket) {
            throw new Error('Missing session socket stub');
        }

        client.sendAgentMessage('codex', {
            type: 'token_count',
            tokens: { total: 9, input: 4, output: 5 },
            source: 'codex-token-count',
            scope: 'turn_delta',
        } as any);

        await vi.waitFor(() => {
            expect(postSpy).toHaveBeenCalled();
        });

        expect(postSpy).toHaveBeenCalledWith(
            expect.stringContaining('/v2/usage-events'),
            expect.objectContaining({
                sessionId: 'session-1',
                agentId: 'codex',
            }),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer fake-token',
                    'Content-Type': 'application/json',
                }),
            }),
        );
        expect(
            sessionSocket.emit.mock.calls.some((call) => call[0] === 'usage-report'),
        ).toBe(false);
    });

    it('redacts usage observation publication errors before logging', async () => {
        vi.resetModules();
        fetchServerFeaturesSnapshotMock.mockReset();
        readCredentialsMock.mockReset();
        readCredentialsMock.mockResolvedValue({ token: 'fake-token' });
        fetchServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'ready',
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
        });
        sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
        userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

        const axiosMod = await import('axios');
        vi.spyOn(axiosMod.default, 'post').mockRejectedValue(
            new Error(
                'usage failed for https://alice:SUPER_SECRET_PASSWORD@api.example.test/v1/usage?token=secret Authorization: Bearer USAGE_SECRET',
            ),
        );
        const { logger } = await import('@/ui/logger');
        const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

        try {
            const { createSessionClientUsageObservationPublisher } = await import(
                './client/createSessionClientUsageObservationPublisher'
            );
            const publisher = createSessionClientUsageObservationPublisher({
                token: 'fake-token',
                getSocket: () => ({
                    connected: true,
                    emit: vi.fn(),
                }),
            });

            await publisher.publish({
                sessionId: 'session-1',
                observation: {
                    provider: 'codex',
                    source: 'codex-token-count',
                    scope: 'turn_delta',
                    key: 'usage-key',
                    modelId: null,
                    tokens: { total: 9, input: 4, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
                    cost: null,
                    contextUsedTokens: null,
                    contextWindowTokens: null,
                },
            });

            expect(debugSpy.mock.calls.some(([message]) =>
                message === '[SOCKET] Failed to publish usage observation (non-fatal)'
            )).toBe(true);
            const [, logged] = debugSpy.mock.calls.find(([message]) =>
                message === '[SOCKET] Failed to publish usage observation (non-fatal)'
            ) ?? [];
            expect(logged).toEqual(expect.objectContaining({
                name: 'Error',
                message: 'usage failed for https://api.example.test/v1/usage Authorization: <redacted>',
            }));
            const serializedLog = JSON.stringify(logged);
            expect(serializedLog).not.toContain('SUPER_SECRET_PASSWORD');
            expect(serializedLog).not.toContain('token=secret');
            expect(serializedLog).not.toContain('USAGE_SECRET');
            expect(serializedLog).not.toContain('stack');
        } finally {
            debugSpy.mockRestore();
        }
    });

    it('publishes OpenCode token_count usage with backend mode and stable external key', async () => {
        vi.resetModules();
        fetchServerFeaturesSnapshotMock.mockReset();
        readCredentialsMock.mockReset();
        readCredentialsMock.mockResolvedValue({ token: 'fake-token' });
        fetchServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'ready',
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
        });
        sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
        userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ data: { success: true, eventId: 'evt-open', createdAt: 1 } });

        const { ApiSessionClient } = await import('./sessionClient');
        const client = new ApiSessionClient(
            'fake-token',
            createPlainSessionFixture({
                id: 'session-1',
                metadata: createTestMetadata({ opencodeBackendMode: 'server' }),
            }),
        );

        client.sendAgentMessage(
            'opencode',
            {
                type: 'token_count',
                key: 'opencode-message:1',
                tokens: { total: 9, input: 4, output: 5 },
                source: 'opencode-message-updated',
                scope: 'turn_delta',
            } as any,
            { localId: 'opencode-local-1' },
        );

        await vi.waitFor(() => {
            expect(postSpy).toHaveBeenCalled();
        });

        expect(postSpy.mock.calls[0]?.[1]).toEqual(
            expect.objectContaining({
                sessionId: 'session-1',
                agentId: 'opencode',
                backendMode: 'server',
                externalKey: 'opencode-message:1',
            }),
        );
    });

    it('falls back to legacy usage-report when v2 analytics ingest is unavailable', async () => {
        vi.resetModules();
        fetchServerFeaturesSnapshotMock.mockReset();
        readCredentialsMock.mockReset();
        readCredentialsMock.mockResolvedValue({ token: 'fake-token' });
        fetchServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'unsupported',
            reason: 'endpoint_missing',
        });
        sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
        userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ data: { success: true } });

        const { ApiSessionClient } = await import('./sessionClient');
        const client = new ApiSessionClient('fake-token', createPlainSessionFixture({ id: 'session-1' }));
        const sessionSocket = sessionSocketStub;
        if (!sessionSocket) {
            throw new Error('Missing session socket stub');
        }

        client.sendAgentMessage('codex', {
            type: 'token_count',
            tokens: { total: 9, input: 4, output: 5 },
            source: 'codex-token-count',
            scope: 'turn_delta',
        } as any);

        await vi.waitFor(() => {
            expect(
                sessionSocket.emit.mock.calls.some((call) => call[0] === 'usage-report'),
            ).toBe(true);
        });

        expect(postSpy).not.toHaveBeenCalled();
        expect(
            sessionSocket.emit.mock.calls.find((call) => call[0] === 'usage-report')?.[1],
        ).toEqual({
            key: 'codex-session',
            sessionId: 'session-1',
            tokens: { total: 9, input: 4, output: 5 },
            cost: { total: 0 },
        });
    });

    it('refreshes credentials and retries usage ingest after an auth failure', async () => {
        vi.resetModules();
        fetchServerFeaturesSnapshotMock.mockReset();
        readCredentialsMock.mockReset();
        readCredentialsMock.mockResolvedValue({ token: 'fresh-token' });
        fetchServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'ready',
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
        });
        sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
        userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const postSpy = vi.spyOn(axios, 'post')
            .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { response: { status: 401 } }))
            .mockResolvedValueOnce({ data: { success: true, eventId: 'evt-2', createdAt: 2 } });

        const { ApiSessionClient } = await import('./sessionClient');
        const client = new ApiSessionClient('stale-token', createPlainSessionFixture({ id: 'session-1' }));
        const sessionSocket = sessionSocketStub;
        if (!sessionSocket) {
            throw new Error('Missing session socket stub');
        }

        client.sendAgentMessage('opencode', {
            type: 'token_count',
            tokens: { total: 18, input: 8, output: 6, thought: 4 },
            source: 'opencode-message-updated',
            scope: 'session_cumulative',
        } as any);

        await vi.waitFor(() => {
            expect(postSpy).toHaveBeenCalledTimes(2);
        });

        expect(readCredentialsMock).toHaveBeenCalledTimes(1);
        expect(postSpy.mock.calls[0]?.[2]).toEqual(
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer stale-token',
                }),
            }),
        );
        expect(postSpy.mock.calls[1]?.[2]).toEqual(
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer fresh-token',
                }),
            }),
        );
        expect(
            sessionSocket.emit.mock.calls.some((call) => call[0] === 'usage-report'),
        ).toBe(false);
    });
});
