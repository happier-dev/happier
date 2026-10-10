import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FeaturesResponseSchema, UsageEventIngestRequestSchema } from '@happier-dev/protocol';
import { createPiExternalSessionsContribution } from '../../../../../packages/plugins/pi/src/agent/externalSessions/contribution';
import { createOpenCodeExternalSessionsContribution } from '../../../../../packages/plugins/opencode/src/agent/surfaces/sessions/external/contribution';
import { createClaudeExternalSessionsContribution } from '../../../../../packages/plugins/claude/src/agent/surfaces/sessions/external/contribution';
import type { AgentExternalSessionsManagedEndpointRead, AgentExternalSessionObservationObserveResourceRequest } from '@happier-dev/plugin-sdk/sessions/external';
import { createBoundedAgentExternalSessionsContribution } from '@/session/external/agentExternalSessionsInvocation';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { createUsageObservationPublisher } from '../createUsageObservationPublisher';
import { createNativeUsageCaptureStore, type NativeUsageCaptureSource } from './nativeUsageCaptureState';
import { createNativeUsageCollector } from './nativeUsageCollector';
import { createExternalSessionsInvocationFixture } from '@/testkit/backends/externalSessionFixtures';
import { createExternalSessionObservationReconciler } from '@/api/session/external/leases/createExternalSessionObservationReconciler';

describe('consented native accounting collector', () => {
    it('keeps Claude record replay identity separate from witnessed inference correlation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-claude-correlation-'));
        let collector: ReturnType<typeof createNativeUsageCollector> | undefined;
        try {
            const projectDir = join(directory, 'projects', 'project');
            await mkdir(projectDir, { recursive: true });
            await writeFile(join(projectDir, 'native-session.jsonl'), [
                { uuid: 'record-without-inference' }, { uuid: 'record-with-inference', inferenceId: 'actual-message-id' },
            ].map(({ uuid, inferenceId }) => JSON.stringify({ type: 'assistant', sessionId: 'native-session', uuid,
                timestamp: '2026-01-01T00:00:00.000Z', message: {
                    ...(inferenceId ? { id: inferenceId } : {}), model: 'claude-sonnet-4-20250514',
                    usage: { input_tokens: 10, output_tokens: 2 }, content: [{ type: 'text', text: 'PRIVATE_TRANSCRIPT' }],
                } }) + '\n').join(''));
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const authority = { serverId: 'home', accountId: 'account', machineId: 'machine' };
            const store = createNativeUsageCaptureStore({ path: join(directory, 'capture.sealed'), authority, storage });
            const contribution = createClaudeExternalSessionsContribution({ env: { NODE_ENV: 'test', CLAUDE_CONFIG_DIR: directory } });
            const published: unknown[] = [];
            let failTransport = true;
            collector = createNativeUsageCollector({ store, storage, authority,
                budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }),
                discoverSources: async () => [{ agent: { pluginId: 'happier.agent.claude', localId: 'claude' },
                    source: { kind: 'claudeConfig', configDir: directory }, sourceKey: directory, root: directory, supported: true }],
                resolveRoot: async () => { throw new Error('Not used'); },
                readAccounting: async (source, signal) => {
                    if (!contribution.readAccounting) throw new Error('Accounting facet absent');
                    return contribution.readAccounting({ source: source.source, cursor: source.cursor, ...createExternalSessionsInvocationFixture(signal) });
                },
                // Only the OS watcher and HTTP transport boundaries are replaced.
                subscribeSource: async () => ({ dispose() {} }),
                publisher: createUsageObservationPublisher({ token: 'token', apiServerUrl: 'https://server.test',
                    emitLegacyUsageReport: () => { throw new Error('Native accounting must not use legacy'); },
                    fetchServerFeaturesSnapshot: async () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {},
                        capabilities: { server: { usageAnalytics: { version: 1, eventsIngest: { path: '/v2/usage-events' },
                            query: { path: '/v2/usage/query' }, legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' } } } } }) }),
                    postJson: async request => {
                        published.push(request.body);
                        if (failTransport) throw new Error('HTTP transport unavailable');
                        return { ok: true };
                    },
                }),
                deleteHistory: async () => ({ success: true, deletedEventCount: 0 }),
            });
            const [source] = await collector.discover();
            expect(source.externalSessionSource).toEqual({ kind: 'claudeConfig', configDir: directory });
            await collector.setConsent(source.sourceId, true);
            await collector.flushPending();
            expect((await store.load()).sources[0].pending).toMatchObject([
                { observation: { key: 'record-without-inference' } }, { inferenceId: 'actual-message-id' },
            ]);
            const initial = UsageEventIngestRequestSchema.parse(published[0]);
            expect(initial.externalKey).toEqual(expect.any(String));
            expect(initial.accounting).not.toHaveProperty('inferenceKey');
            expect(initial.accounting).toMatchObject({ status: 'partial', historyComplete: false });
            const failedAttempts = published.length;
            failTransport = false;
            await collector.flushPending();
            expect(published).toHaveLength(failedAttempts + 2);
            const replay = UsageEventIngestRequestSchema.parse(published[failedAttempts]);
            const witnessed = UsageEventIngestRequestSchema.parse(published[failedAttempts + 1]);
            expect(replay.externalKey).toBe(initial.externalKey);
            expect(replay.subject).toEqual(initial.subject);
            expect(replay.accounting).not.toHaveProperty('inferenceKey');
            expect(witnessed.accounting?.inferenceKey).toBe(witnessed.externalKey);
            expect(witnessed.accounting?.inferenceKey).not.toBe('actual-message-id');
            expect(witnessed.externalKey).not.toBe(initial.externalKey);
            expect(witnessed.subject?.nativeSessionKey).toBe(initial.subject?.nativeSessionKey);
            expect(JSON.stringify(published)).not.toContain('PRIVATE_TRANSCRIPT');
            expect((await store.load()).sources[0].pending).toEqual([]);
            await collector.flushPending();
            expect(published).toHaveLength(failedAttempts + 2);
        } finally {
            await collector?.dispose();
            await rm(directory, { recursive: true, force: true });
        }
    });
    it.each(['settlement', 'stop_initial_backfill', 'invalidate_empty', 'invalidate_paid'] as const)('preserves exact accounting lifecycle during %s', async mode => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-settlement-'));
        try {
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const authority = { serverId: 'home', accountId: 'account', machineId: 'machine' };
            const store = createNativeUsageCaptureStore({ path: join(directory, 'capture.sealed'), authority, storage });
            let output = 5;
            let historicalOutput = 5;
            let failMessageRead = false;
            const messageReads: string[] = [];
            let messageBytes = 0;
            const sessions = mode === 'settlement' ? Array.from({ length: 20 }, (_, i) => ({
                id: i === 0 ? 'native-session' : `history-${i}`, time: { updated: 1767225600100 },
            })) : [{ id: 'native-session', time: { updated: 1767225600100 } }];
            let readEntered = () => {};
            let releaseRead = () => {};
            const entered = new Promise<void>(resolve => { readEntered = resolve; });
            const released = new Promise<void>(resolve => { releaseRead = resolve; });
            let readSignal: AbortSignal | undefined;
            const managedEndpointRead: AgentExternalSessionsManagedEndpointRead = async ({ pathAndQuery }) => {
                const path = new URL(pathAndQuery, 'http://test').pathname;
                if (failMessageRead && path === '/session/native-session/message') {
                    return { ok: false, status: 500, statusText: 'Failed', headers: {}, body: null };
                }
                if (mode !== 'settlement' && path === '/session/native-session/message') {
                    readEntered(); await released;
                }
                const sessionId = path.match(/^\/session\/([^/]+)\/message$/)?.[1];
                const response = path === '/api/info' ? new Response('Not Found', { status: 404 })
                    : new Response(JSON.stringify(path === '/global/health' ? { healthy: true, version: '1.2.20' }
                        : path === '/experimental/session' || path === '/session' ? sessions
                        : path.match(/^\/session\/([^/]+)$/) ? sessions.find(session => path === `/session/${session.id}`)
                        : sessionId && mode !== 'invalidate_empty' ? [{ info: { id: 'paid', sessionID: sessionId,
                            role: 'assistant', modelID: 'model', cost: 0.25, time: { created: 1767225600000, completed: 1767225600200 },
                            tokens: { input: 10, output: sessionId === 'native-session' ? output : sessionId === 'history-1' ? historicalOutput : 5,
                                reasoning: 2, cache: { read: 3, write: 4 } } }, parts: [] }] : []),
                    { headers: { 'content-type': 'application/json' } });
                if (sessionId) { messageReads.push(sessionId); messageBytes += Buffer.byteLength(await response.clone().text()); }
                return { ok: response.ok, status: response.status, statusText: response.statusText,
                    headers: Object.fromEntries(response.headers.entries()), body: response.body };
            };
            const contribution = createBoundedAgentExternalSessionsContribution({
                contribution: createOpenCodeExternalSessionsContribution({ env: { NODE_ENV: 'test' } }),
                identity: { pluginId: 'happier.agent.opencode', agentId: 'opencode', occurrenceId: 'test-occurrence',
                    contributionQualifiedId: 'happier.agent.opencode/agents/opencode',
                    sourceCustody: { kind: 'development', registeredRootId: 'test-source-root' } },
                isCurrent: () => true, retirementSignal: new AbortController().signal,
                managedEndpointRead: async ({ signal }) => { readSignal = signal; return managedEndpointRead; },
                createInvocationExec: async () => createUnavailablePluginServices().exec,
            });
            let observerInput: AgentExternalSessionObservationObserveResourceRequest | undefined;
            const reconciler = createExternalSessionObservationReconciler({ acquireObserver: async input => {
                observerInput = input;
                return { dispose() {} };
            } });
            const budgetRegistry = new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null });
            const releaseOtherWork = budgetRegistry.retainFiniteTask(new Promise<void>(() => {}));
            const settledViews: Promise<unknown>[] = [];
            const collector = createNativeUsageCollector({ store, storage, authority,
                budgetRegistry,
                onSourceSettled: () => { settledViews.push(collector.get()); },
                discoverSources: async () => [{ agent: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
                    source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096' }, sourceKey: 'endpoint', root: null, supported: true }],
                resolveRoot: async () => { throw new Error('Not used'); },
                readAccounting: async (source, signal, changedNativeSessionIds) => {
                    if (!contribution.readAccounting) throw new Error('Accounting facet absent');
                    return contribution.readAccounting({ source: source.source, cursor: source.cursor, signal, changedNativeSessionIds });
                },
                subscribeSource: async (_source, callback) => {
                    return reconciler.registerAccountingSource({ resource: { pluginId: 'happier.agent.opencode', agentLocalId: 'opencode',
                        occurrenceId: 'test-occurrence', resourceKey: 'test-resource' }, source: _source.source, changeObservation: 'observe_resource',
                        onChange: change => callback(change.changedNativeSessionIds),
                    });
                },
                publisher: createUsageObservationPublisher({ token: 'token', apiServerUrl: 'https://server.test',
                    emitLegacyUsageReport: () => false,
                    fetchServerFeaturesSnapshot: async () => mode.startsWith('invalidate_') ? { status: 'ready', features: FeaturesResponseSchema.parse({ features: {},
                        capabilities: { server: { usageAnalytics: { version: 1, eventsIngest: { path: '/v2/usage-events' },
                            query: { path: '/v2/usage/query' }, legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' } } } } }) }
                        : { status: 'unsupported', reason: 'endpoint_missing' },
                    postJson: async () => ({ ok: true }),
                }),
                deleteHistory: async () => ({ success: true, deletedEventCount: 0 }),
            });
            const [source] = await collector.discover();
            if (mode.startsWith('invalidate_')) {
                try {
                    await collector.setConsent(source.sourceId, true);
                    await entered;
                    expect((await collector.get())[0].status).toBe('reading');
                    expect(settledViews).toEqual([]);
                    releaseRead();
                    await collector.flushPending();
                    expect(await Promise.all(settledViews)).toEqual([[expect.objectContaining({
                        status: 'ready', pendingCount: 0,
                    })]]);
                    expect((await budgetRegistry.getLiveWorkProducer().read()).items).toHaveLength(1);
                } finally { releaseRead(); releaseOtherWork(); await collector.dispose(); }
                return;
            }
            releaseOtherWork();
            if (mode === 'stop_initial_backfill') {
                const consenting = collector.setConsent(source.sourceId, true);
                await entered;
                const stopping = collector.stop(source.sourceId);
                // Let the real owner complete its asynchronous admission/abort steps,
                // while the HTTP boundary remains unresolved.
                await new Promise<void>(resolve => setImmediate(resolve));
                try { expect(readSignal?.aborted).toBe(true); }
                finally { releaseRead(); await consenting; await stopping; await collector.dispose(); }
                expect((await store.load()).sources[0]).toMatchObject({ consented: false, pending: [] });
                expect(settledViews).toEqual([]);
                return;
            }
            await collector.setConsent(source.sourceId, true);
            await collector.flushPending();
            expect((await store.load()).sources[0].pending).toHaveLength(20);
            expect((await store.load()).sources[0].pending[0]).toMatchObject({ inferenceId: 'paid', observation: { tokens: { output: 5 } } });
            expect(messageReads).toHaveLength(20);
            const initialBytes = messageBytes;
            messageReads.length = 0; messageBytes = 0;
            await collector.flushPending();
            expect({ messageReads, messageBytes }).toEqual({ messageReads: [], messageBytes: 0 });
            output = 6;
            observerInput!.requestTranscriptRefresh('unlinked-native-key', 'native-session');
            await collector.flushPending();
            expect(messageReads).toEqual(['native-session']);
            expect(messageBytes).toBeGreaterThan(0);
            expect(messageBytes).toBeLessThan(initialBytes / 10);
            expect((await store.load()).sources[0].pending).toHaveLength(20);
            expect((await store.load()).sources[0].pending[0]).toMatchObject({ inferenceId: 'paid', observedAt: 1767225600200,
                observation: { tokens: { output: 6 } } });
            messageReads.length = 0; messageBytes = 0;
            output = 7; historicalOutput = 6;
            observerInput!.requestTranscriptRefresh('unlinked-native-key', 'native-session');
            observerInput!.requestTranscriptRefresh('another-unlinked-key', 'history-1');
            await collector.flushPending();
            expect(messageReads).toEqual(['native-session', 'history-1']);
            expect((await store.load()).sources[0].pending.slice(0, 2)).toMatchObject([
                { nativeSessionId: 'native-session', observation: { tokens: { output: 7 } } },
                { nativeSessionId: 'history-1', observation: { tokens: { output: 6 } } },
            ]);
            // A failed correlated read makes the frontier uncertain. A later
            // different-Session event must recover the missed settlement too.
            output = 8; failMessageRead = true;
            observerInput!.requestTranscriptRefresh('unlinked-native-key', 'native-session');
            await collector.flushPending();
            expect((await store.load()).sources[0].error).toBe('read_failed');
            failMessageRead = false; messageReads.length = 0;
            observerInput!.requestTranscriptRefresh('another-unlinked-key', 'history-1');
            await collector.flushPending();
            expect(messageReads).toHaveLength(20);
            expect((await store.load()).sources[0].pending[0]).toMatchObject({ nativeSessionId: 'native-session', observation: { tokens: { output: 8 } } });
            await collector.dispose();
            await reconciler.dispose();
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
    it('keeps unavailable publication in sealed custody, replays after restart without its input, and retires stopped demand', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-collector-'));
        try {
            const agentDir = join(directory, 'agent');
            const nativeDir = join(agentDir, 'sessions', '--project--');
            await mkdir(nativeDir, { recursive: true });
            const file = join(nativeDir, 'session.jsonl');
            const paid = (id: string, observedAt = 1767225601000) => JSON.stringify({ type: 'message', id, parentId: null,
                timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', model: 'model', provider: 'provider',
                    timestamp: observedAt, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
                    content: [{ type: 'text', text: 'private prompt must never escape' }] } }) + '\n';
            await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: 'native-session', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const authority = { serverId: 'home', accountId: 'plain-account', machineId: 'machine' };
            const store = createNativeUsageCaptureStore({ path: join(directory, 'capture.sealed'), authority, storage });
            const contribution = createPiExternalSessionsContribution({ env: { NODE_ENV: 'test', PI_CODING_AGENT_DIR: agentDir } });
            let supported = false;
            const published: unknown[] = [];
            const publisher = createUsageObservationPublisher({ token: 'token', apiServerUrl: 'https://server.test',
                emitLegacyUsageReport: () => { throw new Error('Native accounting must never use legacy'); },
                fetchServerFeaturesSnapshot: async () => supported ? { status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: { server: { usageAnalytics: {
                    version: 1, eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
                    legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' },
                } } } }) } : { status: 'unsupported', reason: 'endpoint_missing' },
                postJson: async request => { published.push(request.body); return { ok: true }; },
            });
            let readCount = 0;
            let demandCount = 0;
            let onChange = () => {};
            const deps = { store, authority, storage, publisher,
                budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }),
                discoverSources: async () => [{ agent: { pluginId: 'happier.agent.pi', localId: 'pi' }, source: { kind: 'piAgentDir', agentDir }, sourceKey: agentDir, root: agentDir, supported: true }],
                resolveRoot: async () => { throw new Error('Not used'); },
                readAccounting: async (source: NativeUsageCaptureSource, signal: AbortSignal) => {
                    readCount++;
                    if (!contribution.readAccounting) throw new Error('Accounting facet absent');
                    return contribution.readAccounting({ source: source.source, cursor: source.cursor, ...createExternalSessionsInvocationFixture(signal) });
                },
                // Real OS watcher boundary; no internal collector/codec/publisher behavior is mocked.
                subscribeSource: async (_source: unknown, callback: () => void) => { demandCount++; onChange = callback; return { dispose() { demandCount--; } }; },
                deleteHistory: async () => ({ success: true as const, deletedEventCount: 0 }),
            };
            const collector = createNativeUsageCollector(deps);
            await collector.initialize();
            const [discovered] = await collector.discover();
            expect(readCount).toBe(0);
            expect(demandCount).toBe(0);
            await collector.setConsent(discovered.sourceId, true);
            await collector.flushPending();
            expect((await collector.get(discovered.sourceId))[0].asOfMs).toBeNull();
            expect((await store.load()).sources[0].pending).toEqual([]);
            await appendFile(file, paid('inference-one', 0));
            onChange();
            await collector.flushPending();
            expect((await collector.get(discovered.sourceId))[0].asOfMs).toBe(0);
            expect((await store.load()).sources[0]).toMatchObject({ consented: true, cursor: expect.any(String), pending: [{ inferenceId: 'inference-one' }] });
            expect(published).toHaveLength(0);
            expect(demandCount).toBe(1);
            await appendFile(file, paid('appended-inference'));
            onChange();
            await collector.flushPending();
            expect((await store.load()).sources[0].pending.map(row => row.inferenceId)).toEqual(['inference-one', 'appended-inference']);
            const readsAtIdle = readCount;
            await collector.flushPending();
            expect(readCount).toBe(readsAtIdle);
            await collector.dispose();
            await rm(file);
            supported = true;
            const restarted = createNativeUsageCollector(deps);
            await restarted.initialize();
            await restarted.flushPending();
            expect(published).toHaveLength(2);
            await rename(agentDir, `${agentDir}-unavailable`);
            onChange();
            await restarted.flushPending();
            expect((await restarted.get(discovered.sourceId))[0].status).toBe('unavailable');
            await rename(`${agentDir}-unavailable`, agentDir);
            onChange();
            await restarted.flushPending();
            expect((await restarted.get(discovered.sourceId))[0].status).toBe('ready');
            const body = UsageEventIngestRequestSchema.parse(published[0]);
            expect(body).toMatchObject({ subject: { kind: 'native', machineId: 'machine' }, tokens: { total: 12 },
                accounting: { inputIncludesCache: false, outputIncludesReasoning: false } });
            expect(body.sessionId).toBeUndefined();
            expect(JSON.stringify(body)).not.toContain('private prompt');
            expect(JSON.stringify(body)).not.toContain(agentDir);
            expect(JSON.stringify(body)).not.toContain('native-session');
            expect((await store.load()).sources[0].pending).toEqual([]);
            await restarted.flushPending();
            expect(published).toHaveLength(2);
            await restarted.setConsent(discovered.sourceId, false);
            const readsAtStop = readCount;
            await appendFile(file, paid('inference-two'));
            onChange();
            await restarted.flushPending();
            expect(readCount).toBe(readsAtStop);
            expect(published).toHaveLength(2);
            expect(demandCount).toBe(0);
            await restarted.dispose();
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
    it.each(['delete', 'invalid_root', 'unavailable_pending'] as const)('source effect %s preserves the authorized lifetime and pending boundary', async effect => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-delete-'));
        try {
            await mkdir(join(directory, 'sessions'));
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const authority = { serverId: 'home', accountId: 'account', machineId: 'machine' };
            const store = createNativeUsageCaptureStore({ path: join(directory, 'capture.sealed'), authority, storage });
            await store.save({ v: 1, authority, sources: [{
                sourceId: 'root', sourceKey: 'source', agent: { pluginId: 'happier.agent.pi', localId: 'pi' },
                source: { kind: 'piAgentDir', agentDir: directory }, root: directory, supported: effect !== 'unavailable_pending', consented: true,
                pending: [{ nativeSessionId: 'native', inferenceId: 'paid', observedAt: 10, observation: {
                    provider: 'pi', source: 'native', scope: 'turn_delta', key: 'paid', modelId: 'model',
                    tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 5 },
                    cost: null, contextUsedTokens: null, contextWindowTokens: null,
                } }],
            }] });
            const contribution = createPiExternalSessionsContribution({ env: { NODE_ENV: 'test', PI_CODING_AGENT_DIR: directory } });
            let demands = 0;
            let deletes = 0;
            const published: unknown[] = [];
            const collector = createNativeUsageCollector({ store, storage, authority,
                budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }),
                discoverSources: async () => [], resolveRoot: async (source, root) => {
                    const resolved = await contribution.resolveSource({ source: { ...source.source, agentDir: root ?? directory },
                        ...createExternalSessionsInvocationFixture(new AbortController().signal) });
                    if (!resolved.ok) throw new Error('usage_source_root_invalid');
                    return { agent: source.agent, source: resolved.value.source, sourceKey: root ?? directory, root: root ?? directory, supported: true };
                },
                readAccounting: async (source, signal) => {
                    if (!contribution.readAccounting) throw new Error('Accounting absent');
                    return contribution.readAccounting({ source: source.source, cursor: source.cursor, ...createExternalSessionsInvocationFixture(signal) });
                },
                subscribeSource: async () => { demands++; return { dispose() { demands--; } }; },
                publisher: createUsageObservationPublisher({ token: 'token', apiServerUrl: 'https://server.test',
                    emitLegacyUsageReport: () => false, fetchServerFeaturesSnapshot: async () => effect === 'unavailable_pending'
                        ? { status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: { server: { usageAnalytics: {
                            version: 1, eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
                            legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' },
                        } } } }) } : { status: 'unsupported', reason: 'endpoint_missing' },
                    postJson: async request => { published.push(request.body); return { ok: true }; },
                }),
                deleteHistory: async (_source, range) => {
                    expect(range).toEqual({ startMs: 10, endMs: 10 });
                    // Explicit deletion retires local pending before outward HTTP success.
                    expect((await store.load()).sources[0].pending).toEqual([]);
                    deletes++; return { success: true, deletedEventCount: 1 };
                },
            });
            await collector.initialize();
            await collector.flushPending();
            if (effect === 'unavailable_pending') {
                expect((await store.load()).sources[0].pending).toEqual([]);
                expect(published).toHaveLength(1);
                expect(UsageEventIngestRequestSchema.parse(published[0])).toMatchObject({
                    subject: { kind: 'native' }, tokens: { total: 5 },
                });
                expect(demands).toBe(0);
                await collector.flushPending();
                expect(published).toHaveLength(1);
            } else if (effect === 'delete') {
                expect((await store.load()).sources[0].pending).toHaveLength(1);
                await expect(collector.deleteHistory('root', { startMs: 10, endMs: 10 })).resolves.toEqual({ success: true, deletedEventCount: 1 });
                expect((await store.load()).sources[0].consented).toBe(false);
                expect(demands).toBe(0);
                expect(deletes).toBe(1);
                await collector.flushPending();
                expect(demands).toBe(0);
            } else {
                await expect(collector.setRoot('root', '\0')).rejects.toThrow();
                expect((await store.load()).sources[0]).toMatchObject({ consented: true, pending: [{ inferenceId: 'paid' }] });
                expect(demands).toBe(1);
                expect(deletes).toBe(0);
            }
            await collector.dispose();
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
});
