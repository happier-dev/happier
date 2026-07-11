import { describe, expect, it, vi } from 'vitest';

import { FeaturesResponseSchema } from '@happier-dev/protocol';

import { createUsageObservationPublisher } from './createUsageObservationPublisher';

describe('createUsageObservationPublisher', () => {
    it('posts usage events to v2 analytics ingest when the server advertises support', async () => {
        const fetchServerFeaturesSnapshot = vi.fn(async () => ({
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
        }));
        const postJson = vi.fn(async () => ({ ok: true as const }));
        const emitLegacyUsageReport = vi.fn();
        const publisher = createUsageObservationPublisher({
            token: 'token-1',
            apiServerUrl: 'https://api.example.test',
            fetchServerFeaturesSnapshot,
            postJson,
            emitLegacyUsageReport,
        });

        await publisher.publish({
            sessionId: 'session-1',
            observedAt: 10,
            observation: {
                provider: 'claude',
                source: 'claude-sdk-result',
                scope: 'session_final',
                key: 'claude-session',
                modelId: 'claude-sonnet',
                tokens: { total: 20, input: 12, output: 8, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
                cost: { reportedUsd: 0.2, estimatedUsd: 0, currency: 'USD' },
                contextUsedTokens: null,
                contextWindowTokens: null,
            },
        });

        expect(fetchServerFeaturesSnapshot).toHaveBeenCalledTimes(1);
        expect(postJson).toHaveBeenCalledWith(
            expect.objectContaining({
                path: '/v2/usage-events',
                body: expect.objectContaining({
                    sessionId: 'session-1',
                    agentId: 'claude',
                    source: 'claude-sdk-result',
                    scope: 'session_final',
                    isCumulative: true,
                }),
            }),
        );
        expect(emitLegacyUsageReport).not.toHaveBeenCalled();
    });

    it('falls back to legacy usage-report when the server does not advertise v2 analytics ingest', async () => {
        const fetchServerFeaturesSnapshot = vi.fn(async () => ({
            status: 'unsupported' as const,
            reason: 'endpoint_missing' as const,
        }));
        const postJson = vi.fn();
        const emitLegacyUsageReport = vi.fn();
        const publisher = createUsageObservationPublisher({
            token: 'token-1',
            apiServerUrl: 'https://api.example.test',
            fetchServerFeaturesSnapshot,
            postJson,
            emitLegacyUsageReport,
        });

        await publisher.publish({
            sessionId: 'session-1',
            observation: {
                provider: 'codex',
                source: 'codex-token-count',
                scope: 'turn_delta',
                key: 'codex-session',
                modelId: null,
                tokens: { total: 12, input: 7, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
                cost: null,
                contextUsedTokens: null,
                contextWindowTokens: null,
            },
        });

        expect(postJson).not.toHaveBeenCalled();
        expect(emitLegacyUsageReport).toHaveBeenCalledWith({
            key: 'codex-session',
            sessionId: 'session-1',
            tokens: { total: 12, input: 7, output: 5 },
            cost: { total: 0 },
        });
    });

    it('downgrades permanently to legacy usage-report after an unsupported v2 ingest response', async () => {
        const fetchServerFeaturesSnapshot = vi.fn(async () => ({
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
        }));
        const postJson = vi
            .fn()
            .mockRejectedValueOnce(Object.assign(new Error('missing'), { response: { status: 404 } }));
        const emitLegacyUsageReport = vi.fn();
        const publisher = createUsageObservationPublisher({
            token: 'token-1',
            apiServerUrl: 'https://api.example.test',
            fetchServerFeaturesSnapshot,
            postJson,
            emitLegacyUsageReport,
        });
        const observation = {
            provider: 'codex',
            source: 'codex-token-count',
            scope: 'turn_delta' as const,
            key: 'codex-session',
            modelId: null,
            tokens: { total: 12, input: 7, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            cost: null,
            contextUsedTokens: null,
            contextWindowTokens: null,
        };

        await publisher.publish({ sessionId: 'session-1', observation });
        await publisher.publish({ sessionId: 'session-1', observation });

        expect(fetchServerFeaturesSnapshot).toHaveBeenCalledTimes(1);
        expect(postJson).toHaveBeenCalledTimes(1);
        expect(emitLegacyUsageReport).toHaveBeenCalledTimes(2);
    });

    it('refreshes the bearer token and retries v2 ingest after an auth failure', async () => {
        const fetchServerFeaturesSnapshot = vi.fn(async () => ({
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
        }));
        const postJson = vi
            .fn()
            .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { response: { status: 401 } }))
            .mockResolvedValueOnce({ ok: true as const });
        const resolveToken = vi.fn(async () => 'token-2');
        const emitLegacyUsageReport = vi.fn();
        const publisher = createUsageObservationPublisher({
            token: 'token-1',
            apiServerUrl: 'https://api.example.test',
            fetchServerFeaturesSnapshot,
            postJson,
            resolveToken,
            emitLegacyUsageReport,
        });

        await publisher.publish({
            sessionId: 'session-1',
            observation: {
                provider: 'opencode',
                source: 'opencode-message-updated',
                scope: 'session_cumulative',
                key: 'opencode-message:1',
                modelId: 'openai/gpt-5.4',
                tokens: { total: 20, input: 10, output: 5, reasoning: 5, cacheRead: 0, cacheWrite: 0 },
                cost: { reportedUsd: 0, estimatedUsd: 0.12, currency: 'USD' },
                contextUsedTokens: 20,
                contextWindowTokens: 1_024,
            },
        });

        expect(fetchServerFeaturesSnapshot).toHaveBeenCalledTimes(1);
        expect(resolveToken).toHaveBeenCalledTimes(1);
        expect(postJson).toHaveBeenCalledTimes(2);
        expect(postJson.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({
                token: 'token-1',
                path: '/v2/usage-events',
            }),
        );
        expect(postJson.mock.calls[1]?.[0]).toEqual(
            expect.objectContaining({
                token: 'token-2',
                path: '/v2/usage-events',
            }),
        );
        expect(emitLegacyUsageReport).not.toHaveBeenCalled();
    });

    it('falls back to legacy usage-report when auth refresh cannot recover v2 ingest', async () => {
        const fetchServerFeaturesSnapshot = vi.fn(async () => ({
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
        }));
        const postJson = vi
            .fn()
            .mockRejectedValue(Object.assign(new Error('unauthorized'), { response: { status: 401 } }));
        const resolveToken = vi.fn(async () => 'token-2');
        const emitLegacyUsageReport = vi.fn();
        const publisher = createUsageObservationPublisher({
            token: 'token-1',
            apiServerUrl: 'https://api.example.test',
            fetchServerFeaturesSnapshot,
            postJson,
            resolveToken,
            emitLegacyUsageReport,
        });

        await publisher.publish({
            sessionId: 'session-1',
            observation: {
                provider: 'opencode',
                source: 'opencode-step-finish',
                scope: 'session_cumulative',
                key: 'opencode-step:1',
                modelId: null,
                tokens: { total: 24, input: 12, output: 7, reasoning: 5, cacheRead: 0, cacheWrite: 0 },
                cost: { reportedUsd: 0, estimatedUsd: 0.09, currency: 'USD' },
                contextUsedTokens: 24,
                contextWindowTokens: 1_024,
            },
        });

        expect(resolveToken).toHaveBeenCalledTimes(1);
        expect(postJson).toHaveBeenCalledTimes(2);
        expect(emitLegacyUsageReport).toHaveBeenCalledWith({
            key: 'opencode-step:1',
            sessionId: 'session-1',
            tokens: { total: 24, input: 12, output: 7, thought: 5 },
            cost: { total: 0.09 },
        });
    });
});
