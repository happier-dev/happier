import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { createNativeUsageCaptureStore, type NativeUsageCaptureState } from './nativeUsageCaptureState';
import { readCodexNativeAccounting } from '../../../../../packages/plugins/codex/src/agent/usage/nativeAccounting';
import { FeaturesResponseSchema, UsageEventIngestRequestSchema } from '@happier-dev/protocol';
import { createUsageObservationPublisher } from '../createUsageObservationPublisher';
import { createNativeUsageCollector } from './nativeUsageCollector';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

describe('native accounting capture custody', () => {
    it('persists priced Codex reader observations and replays one ingest from the retained cursor', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-codex-priced-custody-'));
        try {
            const sessions = join(directory, 'sessions');
            await mkdir(sessions);
            await writeFile(join(sessions, 'rollout.jsonl'), JSON.stringify({
                type: 'token_usage_record', timestamp: '2026-10-31T00:00:00.000Z',
                payload: { thread_id: 'native-codex', response_id: 'priced-response', model: 'gpt-5',
                    usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 3, reasoning_output_tokens: 2 } },
            }) + '\n');
            const source = { kind: 'codexHome', home: 'user', homePath: directory } as const;
            const request = { source, signal: new AbortController().signal,
                exec: createUnavailablePluginServices().exec,
                managedEndpointRead: async () => { throw new Error('File-backed fixture'); },
                ripgrep: { run: async () => { throw new Error('File-backed accounting has no content search'); } },
            };
            const result = await readCodexNativeAccounting(request, source, { CODEX_HOME: directory });
            if (!result.ok || result.value.outcome !== 'advanced') throw new Error('Expected priced native accounting');
            const read = result.value;
            expect(read.observations).toHaveLength(1);
            const observedCost = read.observations[0]!.observation.cost;
            expect(observedCost?.estimatedUsd).toBeGreaterThan(0);
            expect(observedCost?.breakdown?.cacheSavingsUsd).toBeGreaterThan(0);
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const authority = { serverId: 'home', accountId: 'account', machineId: 'machine' };
            const path = join(directory, 'capture.sealed');
            const state = { v: 1, authority, sources: [{
                sourceId: 'codex-root', agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
                source, sourceKey: 'native-root', root: sessions, supported: true, consented: true,
                cursor: read.nextCursor, pending: [...read.observations],
            }] } satisfies NativeUsageCaptureState;
            await createNativeUsageCaptureStore({ path, authority, storage }).save(state);
            const retained = await createNativeUsageCaptureStore({ path, authority, storage }).load();
            expect(retained.sources[0]!.pending[0]!.observation.cost).toEqual(JSON.parse(JSON.stringify(observedCost)));
            expect(await readCodexNativeAccounting({ ...request, cursor: retained.sources[0]!.cursor }, source,
                { CODEX_HOME: directory })).toEqual({ ok: true, value: { outcome: 'unchanged' } });
            const posted: unknown[] = [];
            const store = createNativeUsageCaptureStore({ path, authority, storage });
            const collector = createNativeUsageCollector({ authority, storage, store,
                budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }),
                discoverSources: async () => [],
                resolveRoot: async () => { throw new Error('No root edit requested'); },
                readAccounting: (captured, signal) => readCodexNativeAccounting({ ...request, cursor: captured.cursor, signal }, source, { CODEX_HOME: directory }),
                // Only the OS watcher and HTTP boundary are substituted.
                subscribeSource: async () => ({ dispose() {} }),
                publisher: createUsageObservationPublisher({ token: 'synthetic-token', apiServerUrl: 'https://capture.test',
                    emitLegacyUsageReport: () => { throw new Error('Native capture requires v2'); },
                    fetchServerFeaturesSnapshot: async () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {},
                        capabilities: { server: { usageAnalytics: { version: 1, eventsIngest: { path: '/v2/usage-events' },
                            query: { path: '/v2/usage/query' }, legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' } } } } }) }),
                    postJson: async request => {
                        expect((await store.load()).sources[0]!.pending).toHaveLength(1);
                        posted.push(request.body);
                        return { ok: true };
                    },
                }),
                deleteHistory: async () => { throw new Error('No deletion requested'); },
            });
            try {
                await collector.initialize();
                await collector.flushPending();
                expect(posted).toHaveLength(1);
                expect(UsageEventIngestRequestSchema.parse(posted[0])).toMatchObject({ subject: { kind: 'native' },
                    tokens: read.observations[0]!.observation.tokens, cost: JSON.parse(JSON.stringify(observedCost)) });
                expect((await store.load()).sources[0]!.pending).toHaveLength(0);
                await collector.flushPending();
                expect(posted).toHaveLength(1);
            } finally { await collector.dispose(); }

        } finally { await rm(directory, { recursive: true, force: true }); }
    });

    it('retains normalized pending and its cursor across restart using device-only custody', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-usage-custody-'));
        try {
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const authority = { serverId: 'home', accountId: 'plain-account', machineId: 'machine' };
            const path = join(directory, 'capture.sealed');
            const store = createNativeUsageCaptureStore({ path, authority, storage });
            const state = { v: 1, authority, sources: [{
                sourceId: 'opaque-root', agent: { pluginId: 'happier.agent.claude', localId: 'claude' },
                source: { kind: 'claudeConfig', configDir: directory }, sourceKey: 'private-root', root: directory,
                supported: true, consented: true, cursor: 'completed-record-1', pending: [{
                    nativeSessionId: 'native-session', observedAt: 10,
                    observation: { provider: 'claude', source: 'native', scope: 'turn_delta', key: 'inference', modelId: 'model',
                        tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 5 },
                        cost: null, contextUsedTokens: null, contextWindowTokens: null },
                }],
            }] } satisfies NativeUsageCaptureState;
            await store.save(state);
            const retainedState = { ...state, retiredCaptureMode: 'native', authority: { ...authority, retiredAuthority: true },
                sources: state.sources.map(source => ({ ...source, retiredSource: true,
                    agent: { ...source.agent, retiredAgent: true }, source: { ...source.source, retiredRoot: true },
                    pending: source.pending.map(pending => ({ ...pending, retiredPending: true,
                        observation: { ...pending.observation, retiredObservation: true,
                            tokens: { ...pending.observation.tokens, retiredTokens: 1 } } })) })) };
            await writeFile(path, storage.sealJson({ purpose: 'usage_accounting_capture', value: retainedState }), { mode: 0o600 });
            const restarted = createNativeUsageCaptureStore({ path, authority, storage });
            // Provider-native source JSON is opaque custody, unlike the typed capture fields.
            const openedState = { ...state, sources: state.sources.map(source => ({ ...source,
                source: { ...source.source, retiredRoot: true } })) };
            expect(await restarted.load()).toEqual(openedState);
            await expect(restarted.save(retainedState)).rejects.toThrow();
            const retainedBytes = await readFile(path, 'utf8');
            expect(retainedBytes).not.toContain('native-session');
            expect(retainedBytes).not.toContain(directory);
            await restarted.save({ ...openedState, sources: openedState.sources.map(source => ({ ...source, pending: [] })) });
            expect((await store.load()).sources[0]?.pending).toEqual([]);
            expect(storage.openJson({ purpose: 'usage_accounting_capture', ciphertext: await readFile(path, 'utf8') }))
                .toEqual({ ...openedState, sources: openedState.sources.map(source => ({ ...source, pending: [] })) });
            await expect(createNativeUsageCaptureStore({ path, storage, authority: { ...authority, accountId: 'other' } }).load())
                .rejects.toThrow(/authority/);
            await writeFile(path, 'corrupt-custody', { mode: 0o600 });
            await expect(restarted.load()).rejects.toThrow();
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
});
