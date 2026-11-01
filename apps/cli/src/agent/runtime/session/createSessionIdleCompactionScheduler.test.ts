import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from './input/sessionProviderInputConsumer';
import { createDeferred } from '@/testkit/async/deferred';
import { createSessionIdleCompactionScheduler } from './createSessionIdleCompactionScheduler';
import { createEventsFixture, createPluginContextFixture, createSdkExecFixture, createTerminalHostFixture } from '../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';
import { createClaudeNativeSessionRuntimeFromOperations } from '../../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime';
import { createClaudeAgentSdkTurnOperations } from '../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';

function fixture(options: { minContextTokens?: number; cacheWindowOverrideMs?: number; mode?: 'host' | 'native'; enabled?: boolean; omitNativeProducer?: boolean } = {}) {
  const queue = new MessageQueue2<string>(() => 'mode');
  let children = 0;
  let attention = false;
  let known = true;
  const consumer = createSessionProviderInputConsumer({ messageQueue: queue, session: {
    waitForMetadataUpdate: async () => false,
    getMetadataSnapshot: () => ({}),
    getAgentStateSnapshot: () => attention ? { requests: { approval: { tool: 'test', arguments: {}, createdAt: 1 } } } : {},
    readSubagentLiveWork: () => ({ state: known ? children ? 'active' : 'settled' : 'unknown', activeCount: children }),
    ...(options.omitNativeProducer ? {} : { readNativeRuntimeActivitySnapshot: () => ({ state: 'idle' as const, activeCount: 0 }) }),
    readRuntimeActivitySnapshotTail: () => ({ sequence: 1, custody: null, settlement: {
      identity: { mutationKey: 'activity', admissionOrder: 1 }, desiredValue: { state: 'idle', activeCount: 0 }, result: 'applied',
      committedProjection: { state: 'idle', activeCount: 0, observedAt: 1, revision: 1 }, committedRevision: 1,
    } }),
    readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
  } });
  const controls: unknown[] = [];
  const signal = new AbortController().signal;
  const controlSignals: AbortSignal[] = [];
  let reads = 0;
  const scheduler = createSessionIdleCompactionScheduler({
    signal,
    mode: options.mode ?? 'host', preference: { enabled: options.enabled ?? true, ...options },
    compact: async (request, options) => { controls.push(request); controlSignals.push(options.signal); return { status: 'admitted' }; },
    readLiveWork: () => { reads++; return consumer.readLiveWork(); },
  });
  const observe = (promptCache: { lastUseAtMs: number; ttlMs?: number } | undefined = { lastUseAtMs: Date.now(), ttlMs: 1000 }, usedTokens = 100) =>
    scheduler.observeUsage({ promptCache, context: { usedTokens } });
  return { scheduler, observe, controls, controlSignals, signal, queue, consumer, get reads() { return reads; },
    setChildren: (count: number) => { children = count; }, setAttention: (value: boolean) => { attention = value; }, setKnown: (value: boolean) => { known = value; } };
}

describe('Session idle compaction scheduler', () => {
  afterEach(() => vi.useRealTimers());
  it.each([undefined, 0])('waits for an observed context even with minimum %s', async minimumContextTokens => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const f = fixture(minimumContextTokens === undefined ? {} : { minContextTokens: minimumContextTokens });
    const existingTimers = vi.getTimerCount();
    f.scheduler.observeUsage({ promptCache: { lastUseAtMs: Date.now(), ttlMs: 1000 } });
    expect(vi.getTimerCount() - existingTimers).toBe(0);
    f.scheduler.observeUsage({ context: {
      usedTokens: 0,
    } });
    expect(vi.getTimerCount() - existingTimers).toBe(1);
    await vi.advanceTimersByTimeAsync(900);
    expect(f.controls).toHaveLength(1);
  });
  it('admits from the real Claude request clock, assistant cache evidence and later result context', async () => {
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, { exec: exec.service });
    const operations = createClaudeAgentSdkTurnOperations({ ctx, directory: '/tmp/claude-idle-cache', launchEnv: {},
      permissionMode: 'default', happierSessionId: 'idle-cache', initialProviderSessionId: 'native-idle-cache', publishSdkMessages: true });
    // SDK process IO and host service registration are the external boundaries;
    // request attribution, usage mapping and the native facade remain real.
    const context = { session: { services: { activeInput: { bind: () => ({ dispose() {} }) },
      models: { bind: () => ({ dispose() {} }) } } } } as unknown as import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionRuntimeContext;
    const runtime = createClaudeNativeSessionRuntimeFromOperations(operations,
      { kind: 'create', sessionId: 'idle-cache', cwd: '/tmp/claude-idle-cache' }, context);
    const f = fixture({ minContextTokens: 100, cacheWindowOverrideMs: 1000 });
    const observed: import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionRuntimeEvent[] = [];
    const subscription = runtime.watch(event => {
      if (event.kind === 'usage-observed') { observed.push(event); f.scheduler.observeUsage(event); }
    });
    try {
      operations.beginProviderTurn('idle-cache-turn');
      await operations.sendProviderTurnPrompt('Hello');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const requestStartedAt = Date.now();
      await exec.emit({ type: 'stream_event', session_id: 'native-idle-cache',
        event: { type: 'message_start', message: { id: 'idle-cache-request' } } });
      await exec.emit({ type: 'assistant', uuid: 'idle-cache-row', session_id: 'native-idle-cache', message: {
        id: 'idle-cache-request', role: 'assistant', content: [], model: 'claude-sonnet-4-6',
        usage: { input_tokens: 1000, output_tokens: 1, cache_creation_input_tokens: 100,
          cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 } },
      } });
      await vi.advanceTimersByTimeAsync(899);
      expect(observed).toContainEqual(expect.objectContaining({ promptCache: { lastUseAtMs: requestStartedAt, ttlMs: 3_600_000 } }));
      expect(f.reads).toBe(0); expect(f.controls).toHaveLength(0);
      await exec.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-idle-cache',
        usage: { input_tokens: 1000, output_tokens: 10, cache_creation_input_tokens: 100,
          iterations: [{ type: 'message', input_tokens: 1000, output_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 }] },
        modelUsage: { 'claude-sonnet-4-6': { inputTokens: 1000, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 100, contextWindow: 200_000 } },
        result: 'done' });
      await vi.waitFor(() => expect(observed).toContainEqual(expect.objectContaining({ scope: 'session_final' })));
      await vi.advanceTimersByTimeAsync(1);
      expect(observed).toContainEqual(expect.objectContaining({ scope: 'session_final', context: expect.objectContaining({ usedTokens: expect.any(Number) }) }));
      expect(f.controls).toHaveLength(1); expect(f.reads).toBe(1);
    } finally { f.scheduler.dispose(); subscription.dispose(); await runtime.dispose(); }
  });
  it('replaces U deadlines without reading live work and admits once at the latest due deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(100_000);
    const f = fixture();
    const existingTimers = vi.getTimerCount();
    for (let i = 0; i < 8; i++) f.observe({ lastUseAtMs: Date.now() + i * 100, ttlMs: 1000 });
    expect(vi.getTimerCount() - existingTimers).toBe(1); expect(f.reads).toBe(0);
    await vi.advanceTimersByTimeAsync(1599); expect(f.controls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); expect(f.controls).toHaveLength(1); expect(f.reads).toBe(1);
    expect(f.controls[0]).toMatchObject({ trigger: 'idle', compactionId: expect.any(String) });
    expect(f.controlSignals).toEqual([f.signal]);
    expect(vi.getTimerCount()).toBe(0);
    f.observe(); await vi.advanceTimersByTimeAsync(1000); expect(f.controls).toHaveLength(1);
    f.scheduler.notifyForegroundActivity();
    f.scheduler.observeUsage({ promptCache: { lastUseAtMs: Date.now(), ttlMs: 1000 } });
    await vi.advanceTimersByTimeAsync(900);
    expect(f.controls).toHaveLength(2);
  });
  it.each(['input', 'children', 'attention', 'unknown'] as const)('keeps its timer through %s changes and reads once at fire', async kind => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); const f = fixture(); f.observe();
    if (kind === 'input') f.queue.pushImmediate('hello', 'mode');
    if (kind === 'children') f.setChildren(1);
    if (kind === 'attention') f.setAttention(true);
    if (kind === 'unknown') f.setKnown(false);
    expect(f.reads).toBe(0);
    await vi.advanceTimersByTimeAsync(900);
    expect(f.controls).toHaveLength(0); expect(f.reads).toBe(1);
  });
  it('keeps missing native activity unknown even when the guard categories are settled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const f = fixture({ omitNativeProducer: true });
    expect(await f.consumer.readLiveWork()).toMatchObject({ session: 'settled', input: 'settled', agents: 'settled', attention: 'settled',
      nativeRuntimeActivity: 'unknown', settledAt: expect.any(Number) });
    f.observe(); await vi.advanceTimersByTimeAsync(900);
    expect(f.reads).toBe(1); expect(f.controls).toHaveLength(0);
  });
  it('uses override instead of detected TTL, accepts clock-only, and clears ineligible observations', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); const f = fixture({ cacheWindowOverrideMs: 2000, minContextTokens: 100 });
    f.observe({ lastUseAtMs: Date.now(), ttlMs: 100 });
    await vi.advanceTimersByTimeAsync(900); expect(f.controls).toHaveLength(0);
    f.scheduler.observeUsage({}); expect(vi.getTimerCount()).toBe(1);
    f.observe({ lastUseAtMs: Date.now() }, 99); expect(vi.getTimerCount()).toBe(0);
    f.observe({ lastUseAtMs: Date.now() }, 100);
    await vi.advanceTimersByTimeAsync(1800); expect(f.controls).toHaveLength(1);
  });
  it.each([{ mode: 'native' as const }, { enabled: false }])('creates no timer for unavailable host scheduling %j', options => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); const f = fixture(options);
    const existingTimers = vi.getTimerCount();
    f.observe(); expect(vi.getTimerCount() - existingTimers).toBe(0); expect(f.reads).toBe(0);
  });
  it('pairs request cache and result context across observations and consumes the cache fact even when busy', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const f = fixture({ minContextTokens: 100 });
    const existingTimers = vi.getTimerCount();
    f.scheduler.observeUsage({ promptCache: { lastUseAtMs: Date.now(), ttlMs: 1000 } });
    expect(vi.getTimerCount() - existingTimers).toBe(0);
    f.scheduler.observeUsage({ context: { usedTokens: 100 } });
    expect(vi.getTimerCount() - existingTimers).toBe(1);
    f.scheduler.observeUsage({});
    expect(vi.getTimerCount() - existingTimers).toBe(1); expect(f.reads).toBe(0);
    f.scheduler.observeUsage({ context: { usedTokens: 99 } });
    expect(vi.getTimerCount() - existingTimers).toBe(0);
    f.scheduler.observeUsage({ context: { usedTokens: 100 } });
    f.setChildren(1); await vi.advanceTimersByTimeAsync(900);
    expect(f.controls).toHaveLength(0); expect(f.reads).toBe(1);
    f.setChildren(0); f.scheduler.observeUsage({ context: { usedTokens: 101 } });
    await vi.advanceTimersByTimeAsync(1000); expect(f.reads).toBe(1);
    f.scheduler.observeUsage({ promptCache: { lastUseAtMs: Date.now(), ttlMs: 1000 } });
    await vi.advanceTimersByTimeAsync(900); expect(f.controls).toHaveLength(1);
  });
  it('skips more than 60 seconds late without live reads, but admits the exact boundary', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(100_000);
    const late = fixture(); late.observe({ lastUseAtMs: 39_099, ttlMs: 1000 });
    await vi.advanceTimersByTimeAsync(1); expect(late.reads).toBe(0); expect(late.controls).toHaveLength(0);
    const due = fixture(); due.observe({ lastUseAtMs: Date.now() - 60_900, ttlMs: 1000 });
    await vi.advanceTimersByTimeAsync(0); expect(due.controls).toHaveLength(1);
  });
  it('does not overflow the platform maximum override into an immediate timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); const f = fixture({ cacheWindowOverrideMs: 2147483647 });
    const existingTimers = vi.getTimerCount(); f.observe();
    await vi.advanceTimersByTimeAsync(1); expect(f.controls).toHaveLength(0); expect(vi.getTimerCount() - existingTimers).toBe(1);
    f.scheduler.dispose(); expect(vi.getTimerCount() - existingTimers).toBe(0);
  });
  it('prevents admission across the asynchronous disposal boundary', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); const f = fixture(); const pending = createDeferred<Awaited<ReturnType<typeof f.consumer.readLiveWork>>>();
    const controls: unknown[] = [];
    const scheduler = createSessionIdleCompactionScheduler({ mode: 'host', preference: { enabled: true },
      signal: new AbortController().signal,
      readLiveWork: () => pending.promise, compact: async request => { controls.push(request); return { status: 'admitted' }; } });
    scheduler.observeUsage({ promptCache: { lastUseAtMs: Date.now(), ttlMs: 1000 }, context: {
      usedTokens: 0,
    } });
    await vi.advanceTimersByTimeAsync(900); scheduler.dispose(); pending.resolve(await f.consumer.readLiveWork());
    await Promise.resolve(); expect(controls).toHaveLength(0);
  });
});
