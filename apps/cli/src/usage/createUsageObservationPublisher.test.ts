import { describe, expect, it, vi } from 'vitest';

import { FeaturesResponseSchema } from '@happier-dev/protocol';

import { createUsageObservationPublisher } from './createUsageObservationPublisher';
import { logger } from '@/ui/logger';
import { buildAcpUsageUpdateObservation } from '@/agent/acp/usage/buildAcpUsageObservation';
import type { UsageReportV1 } from './legacy/legacyUsageTransport';


import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

describe('createUsageObservationPublisher', () => {
    it.each(['slow', 'cancelled'] as const)('keeps a %s capability probe with its caller instead of downgrading or acknowledging capture', async kind => {
        vi.useFakeTimers();
        const controller = new AbortController();
        let requestSignal: Pick<AbortSignal, 'aborted'> | null | undefined;
        let finish!: (response: Response) => void;
        const postJson = vi.fn(async () => ({ ok: true as const }));
        const emitLegacyUsageReport = vi.fn();
        const publisher = createUsageObservationPublisher({
            token: 'token', apiServerUrl: 'https://slow-capabilities.test', postJson, emitLegacyUsageReport,
            fetchServerFeaturesSnapshot: params => fetchServerFeaturesSnapshot({ ...params,
                // Only the external HTTP is held; capability parsing and cancellation remain real.
                fetchImpl: async (_url, init) => {
                    requestSignal = init?.signal;
                    return await new Promise<Response>((resolve, reject) => {
                        finish = resolve;
                        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                    });
                },
            }),
        });
        const observation = { provider: 'codex', source: 'codex-native', scope: 'turn_delta' as const,
            key: 'session-1', modelId: null, tokens: { total: 12, input: 12, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            cost: null, contextUsedTokens: null, contextWindowTokens: null };
        const pending = publisher.publish({ sessionId: 'session-1', signal: controller.signal, observation,
            ...(kind === 'cancelled' ? { subject: { kind: 'native' as const, machineId: 'machine-1',
                agent: { pluginId: 'happier.agent.codex', localId: 'codex' }, sourceRootKey: 'root', nativeSessionKey: 'native' },
                externalKey: 'inference' } : {}),
        });
        const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { server: { usageAnalytics: {
            version: 1, eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
            legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' },
        } } } });
        try {
            await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
            if (kind === 'slow') {
                await vi.advanceTimersByTimeAsync(1_501);
                expect(emitLegacyUsageReport).not.toHaveBeenCalled();
                expect(postJson).not.toHaveBeenCalled();
                finish(Response.json(features));
                expect(await pending).toEqual({ status: 'sent', transport: 'v2' });
                expect(postJson).toHaveBeenCalledOnce();
            } else {
                controller.abort();
                expect(requestSignal?.aborted).toBe(true);
                expect(await pending).toEqual({ status: 'failed' });
                expect(postJson).not.toHaveBeenCalled();
            }
            expect(emitLegacyUsageReport).not.toHaveBeenCalled();
        } finally {
            finish?.(Response.json(features));
            await pending;
            vi.useRealTimers();
        }
    });

    it.each([
        { mode: 'unadvertised', withContext: true },
        { mode: 'unadvertised', withContext: false },
        { mode: 'rejected', withContext: true },
        { mode: 'rejected', withContext: false },
    ] as const)('preserves complete scalar snapshots across tokenless costs, replay, and fresh $mode fallback (context=$withContext)', async ({ mode, withContext }) => {
        const stored = new Map<string, UsageReportV1>();
        const createPublisher = () => createUsageObservationPublisher({
            token: 'token', apiServerUrl: 'https://api.example.test',
            fetchServerFeaturesSnapshot: async () => mode === 'unadvertised'
                ? { status: 'unsupported', reason: 'endpoint_missing' }
                : { status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: { server: { usageAnalytics: {
                    version: 1, eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
                    legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' },
                } } } }) },
            postJson: async () => { throw { response: { status: 404 } }; },
            emitLegacyUsageReport: report => {
                // Released scalar servers replace the entire session/key row.
                stored.set(JSON.stringify([report.sessionId, report.key]), report);
            },
        });
        const publish = (publisher: ReturnType<typeof createPublisher>, update: Record<string, unknown>) => {
            const observation = buildAcpUsageUpdateObservation({ provider: 'fixture', update });
            if (!observation) throw new Error('Expected a usage observation');
            return publisher.publish({ sessionId: 'session', observation });
        };
        const totals = () => [...stored.values()].reduce((sum, report) => ({
            tokens: sum.tokens + report.tokens.total, cost: sum.cost + report.cost.total,
        }), { tokens: 0, cost: 0 });
        const partialCost = (amount: number) => ({ ...(withContext ? { used: 900, size: 1000 } : {}), cost: { amount, currency: 'USD' } });
        const billed = (inputTokens: number, outputTokens: number, amount: number) => ({
            inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cost: { amount, currency: 'USD' },
        });
        const first = createPublisher();
        await publish(first, billed(80, 20, 0.1));
        const contextResult = await publish(first, partialCost(0.2));
        expect(totals()).toEqual({ tokens: 100, cost: 0.1 });
        expect(contextResult).toEqual({ status: 'skipped' });
        await publish(first, billed(120, 30, 0.3));
        await publish(first, billed(120, 30, 0.3));
        expect(totals()).toEqual({ tokens: 150, cost: 0.3 });
        const resumed = createPublisher();
        expect(await publish(resumed, partialCost(0.4))).toEqual({ status: 'skipped' });
        expect(totals()).toEqual({ tokens: 150, cost: 0.3 });
        await publish(resumed, billed(120, 30, 0.3));
        await publish(resumed, billed(160, 40, 0.5));
        expect(await publish(resumed, partialCost(0.6))).toEqual({ status: 'skipped' });
        expect(totals()).toEqual({ tokens: 200, cost: 0.5 });
        expect(stored.size).toBe(1);
    });

    it.each([true, false])('retains tokenless costs in v2 accounting without scalar fallback (context=%s)', async withContext => {
        const postJson = vi.fn(async () => ({ ok: true as const }));
        const emitLegacyUsageReport = vi.fn();
        const publisher = createUsageObservationPublisher({
            token: 'token', apiServerUrl: 'https://api.example.test', postJson, emitLegacyUsageReport,
            fetchServerFeaturesSnapshot: async () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
                features: {}, capabilities: { server: { usageAnalytics: {
                    version: 1, eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
                    legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' },
                } } },
            }) }),
        });
        const observation = buildAcpUsageUpdateObservation({ provider: 'fixture', update: {
            ...(withContext ? { used: 900, size: 1000 } : {}), cost: { amount: 0.25, currency: 'USD' },
        } });
        if (!observation) throw new Error('Expected a usage observation');
        expect(await publisher.publish({ sessionId: 'session', observation })).toEqual({ status: 'sent', transport: 'v2' });
        expect(postJson).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({
            tokens: expect.objectContaining({ total: 0 }),
            cost: expect.objectContaining({ reportedUsd: 0.25 }),
            context: withContext ? { usedTokens: 900, windowTokens: 1000 } : undefined,
        }) }));
        expect(emitLegacyUsageReport).not.toHaveBeenCalled();
    });

    it.each(['unadvertised', 'rejected'] as const)('preserves producer delta identities on %s fallback across replay and a fresh publisher', async mode => {
        const reports: UsageReportV1[] = [];
        const stored = new Map<string, UsageReportV1>();
        const createPublisher = () => createUsageObservationPublisher({
            token: 'token', apiServerUrl: 'https://api.example.test',
            fetchServerFeaturesSnapshot: async () => mode === 'unadvertised'
                ? { status: 'unsupported', reason: 'endpoint_missing' }
                : { status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: { server: { usageAnalytics: {
                    version: 1, eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
                    legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' },
                } } } }) },
            postJson: async () => { throw { response: { status: 404 } }; },
            emitLegacyUsageReport: report => {
                reports.push(report);
                stored.set(JSON.stringify([report.sessionId, report.key]), report);
            },
        });
        const publish = (publisher: ReturnType<typeof createPublisher>, externalKey: string, update: Record<string, unknown>) => {
            const observation = buildAcpUsageUpdateObservation({ provider: 'fixture', update: {
                inputTokens: 100, outputTokens: 10, totalTokens: 110, cost: { amount: 0.25 }, ...update,
            } });
            if (!observation) throw new Error('Expected a usage observation');
            return publisher.publish({ sessionId: 'session', externalKey, observation });
        };
        const first = createPublisher();
        for (const externalKey of ['step-1', 'step-2', 'step-1']) {
            await publish(first, externalKey, { scope: 'turn_delta' });
        }
        const resumed = createPublisher();
        await publish(resumed, 'step-1', { scope: 'turn_delta' });
        await publish(resumed, 'step-3', { scope: 'turn_delta' });
        expect([...stored.values()].reduce((total, report) => total + report.tokens.total, 0)).toBe(330);
        expect([...stored.values()].reduce((total, report) => total + report.cost.total, 0)).toBe(0.75);
        await publish(resumed, 'cumulative-event', {});
        await publish(resumed, 'event', { scope: 'turn_delta', key: 'explicit-key' });
        await publish(resumed, 'explicit-cumulative-event', { scope: 'session_cumulative', key: 'explicit-counter' });
        expect(reports.map(report => report.key)).toEqual([
            'step-1', 'step-2', 'step-1', 'step-1', 'step-3', 'acp-usage-update', 'explicit-key', 'explicit-counter',
        ]);
        expect(reports.every(report => report.tokens.total === 110)).toBe(true);
    });

    it('keeps exact Codex response supplements out of scalar fallback regardless of arrival order', async () => {
        const reports: Array<{ tokens: { total: number } }> = [];
        const publisher = createUsageObservationPublisher({
            token: 'synthetic-token', apiServerUrl: 'https://api.example.test',
            fetchServerFeaturesSnapshot: async () => ({ status: 'unsupported', reason: 'endpoint_missing' }),
            emitLegacyUsageReport: report => { reports.push(report); },
        });
        const observation = { provider: 'codex', source: 'codex-app-server-response-usage', scope: 'turn_delta' as const,
            key: null, modelId: null, tokens: { total: 3, input: 2, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            cost: null, contextUsedTokens: null, contextWindowTokens: null };
        const exact = { sessionId: 'session-1', externalKey: 'response-1', observation };
        expect(await publisher.publish(exact)).toEqual({ status: 'skipped' });
        expect(await publisher.publish({ sessionId: 'session-1', observation: { ...observation,
            source: 'codex-app-server-token-usage', scope: 'session_cumulative', tokens: { ...observation.tokens, total: 1006, input: 1004, output: 2 },
        } })).toEqual({ status: 'sent', transport: 'legacy' });
        expect(await publisher.publish(exact)).toEqual({ status: 'skipped' });
        expect(reports.map(report => report.tokens.total)).toEqual([1006]);
    });

    it('keeps canceled native HTTP capture pending instead of acknowledging it', async () => {
        const controller = new AbortController();
        const publisher = createUsageObservationPublisher({
            token: 'token', apiServerUrl: 'https://api.example.test', emitLegacyUsageReport: () => { throw new Error('Native cannot use legacy transport'); },
            postJson: async (request) => {
                controller.abort();
                const signal = Reflect.get(request, 'signal');
                if (signal instanceof AbortSignal && signal.aborted) throw new DOMException('Canceled', 'AbortError');
                return { ok: true };
            },
            fetchServerFeaturesSnapshot: async () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: { server: { usageAnalytics: {
                version: 1, eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
                legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' },
            } } } }) }),
        });
        expect(await publisher.publish({
            signal: controller.signal,
            subject: { kind: 'native', machineId: 'machine-1', agent: { pluginId: 'happier.agent.codex', localId: 'codex' }, sourceRootKey: 'root', nativeSessionKey: 'native' },
            externalKey: 'inference',
            observation: { provider: 'codex', source: 'codex-native', scope: 'turn_delta', key: null, modelId: null, tokens: { total: 12, input: 12, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: null, contextUsedTokens: null, contextWindowTokens: null },
        })).toEqual({ status: 'failed' });
    });
    it('re-probes native ingest on explicit replay after the server becomes supported', async () => {
        let supported = false;
        const emitLegacyUsageReport = vi.fn();
        const publisher = createUsageObservationPublisher({
            token: 'token', apiServerUrl: 'https://api.example.test', emitLegacyUsageReport,
            postJson: async () => ({ ok: true }),
            fetchServerFeaturesSnapshot: async () => supported ? {
                status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: { server: { usageAnalytics: {
                    version: 1, eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
                    legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' },
                } } } }),
            } : { status: 'unsupported', reason: 'endpoint_missing' },
        });
        const input = {
            subject: { kind: 'native' as const, machineId: 'machine-1', agent: { pluginId: 'happier.agent.codex', localId: 'codex' }, sourceRootKey: 'root', nativeSessionKey: 'native' },
            externalKey: 'inference',
            observation: { provider: 'codex', source: 'codex-native', scope: 'turn_delta' as const, key: null, modelId: null, tokens: { total: 12, input: 12, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: null, contextUsedTokens: null, contextWindowTokens: null },
        };
        expect(await publisher.publish(input)).toEqual({ status: 'unsupported' });
        supported = true;
        expect(await publisher.publish(input)).toEqual({ status: 'sent', transport: 'v2' });
        expect(emitLegacyUsageReport).not.toHaveBeenCalled();
    });
    it.each([400, 404, 401])('never acknowledges native capture through legacy transport after HTTP %s', async (status) => {
        const emitLegacyUsageReport = vi.fn();
        const publisher = createUsageObservationPublisher({
            token: 'token', apiServerUrl: 'https://api.example.test', emitLegacyUsageReport,
            postJson: async () => { throw Object.assign(new Error('refused'), { response: { status } }); },
            fetchServerFeaturesSnapshot: async () => ({
                status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: { server: { usageAnalytics: {
                    version: 1, eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
                    legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' },
                } } } }),
            }),
        });
        const result = await publisher.publish({
            subject: { kind: 'native', machineId: 'machine-1', agent: { pluginId: 'happier.agent.codex', localId: 'codex' }, sourceRootKey: 'root', nativeSessionKey: 'native' },
            externalKey: 'inference',
            observation: { provider: 'codex', source: 'codex-native', scope: 'turn_delta', key: null, modelId: null, tokens: { total: 12, input: 12, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: null, contextUsedTokens: null, contextWindowTokens: null },
        });
        expect(result).toEqual({ status: status === 401 ? 'failed' : 'unsupported' });
        expect(emitLegacyUsageReport).not.toHaveBeenCalled();
    });
    it('returns a failure and warns when v2 transport fails without losing the stable retry key', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const postJson = vi.fn().mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValueOnce({ ok: true });
        const publisher = createUsageObservationPublisher({
            token: 'token', apiServerUrl: 'https://api.example.test', postJson,
            emitLegacyUsageReport: vi.fn(),
            fetchServerFeaturesSnapshot: async () => ({
                status: 'ready',
                features: FeaturesResponseSchema.parse({ features: {}, capabilities: { server: { usageAnalytics: {
                    version: 1, eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
                    legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' },
                } } } }),
            }),
        });
        const input = {
            sessionId: 'session-1', externalKey: 'native-record-1',
            observation: {
                provider: 'claude', source: 'claude-assistant-usage', scope: 'turn_delta' as const,
                key: 'claude-session', modelId: null,
                tokens: { total: 12, input: 7, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
                cost: null, contextUsedTokens: null, contextWindowTokens: null,
            },
        };
        try {
            await expect(publisher.publish(input)).resolves.toEqual({ status: 'failed' });
            expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: 'network unavailable' }));
            await expect(publisher.publish(input)).resolves.toEqual({ status: 'sent', transport: 'v2' });
            expect(postJson.mock.calls.map(([request]) => request.body.externalKey)).toEqual(['native-record-1', 'native-record-1']);
        } finally {
            warn.mockRestore();
        }
    });

    it('posts prompt-cache facts in one existing v2 accounting request when the server advertises support', async () => {
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
                promptCache: { lastUseAtMs: 0 },
                tokens: { total: 20, input: 12, output: 8, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
                cost: { reportedUsd: 0.2, estimatedUsd: 0, currency: 'USD' },
                contextUsedTokens: null,
                contextWindowTokens: null,
            },
        });

        expect(fetchServerFeaturesSnapshot).toHaveBeenCalledTimes(1);
        expect(postJson).toHaveBeenCalledTimes(1);
        expect(postJson).toHaveBeenCalledWith(
            expect.objectContaining({
                path: '/v2/usage-events',
                body: expect.objectContaining({
                    sessionId: 'session-1',
                    agentId: 'claude',
                    source: 'claude-sdk-result',
                    scope: 'session_final',
                    isCumulative: true,
                    promptCache: { lastUseAtMs: 0 },
                }),
            }),
        );
        expect(emitLegacyUsageReport).not.toHaveBeenCalled();

        expect(await publisher.publish({
            sessionId: 'session-1', observedAt: 20,
            observation: {
                provider: 'runtime-agent', source: 'runtime', scope: 'turn_delta', key: null, modelId: null,
                tokens: null, cost: null, contextUsedTokens: null, contextWindowTokens: null,
                promptCache: { lastUseAtMs: 10, ttlMs: 300_000 },
            },
        })).toEqual({ status: 'skipped' });
        expect(postJson).toHaveBeenCalledTimes(1);
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
