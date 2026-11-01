import { describe, expect, it, vi } from 'vitest';
import { AgentSessionRuntimeEventSchema, PROMPT_CACHE_DURATIONS, type AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type { DisposableCodexAppServerClient } from './client.js';
import { createCodexNativeEventFixture } from './client.test-support.js';
import { createCodexNativeAppServerSessionRuntime } from './native.js';
import { createCodexAppServerRuntime, startCodexAppServerRuntime } from './runtime.js';
import { PLUGIN_MANIFEST } from '../../../manifest.js';

// Only the native JSON-RPC transport is replaced; facade, lifecycle and schema are real.
function fixture(options: { compactFailure?: boolean; beforeCompactAck?: () => Promise<void>;
  authType?: string; modelId?: string; modelProvider?: string } = {}) {
  const handlers = new Map<string, (params: unknown) => void | Promise<void>>();
  const receipts = createCodexNativeEventFixture();
  const requests: Array<{ method: string; params: unknown }> = [];
  const events: AgentSessionRuntimeEvent[] = [];
  const client: DisposableCodexAppServerClient = {
    onNativeEvent: receipts.onNativeEvent,
    launchFeatures: { realtimeConversationAdvertised: false },
    async request(method, params) {
      requests.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'main' }, model: options.modelId, modelProvider: options.modelProvider };
      if (method === 'account/read') return { account: { type: options.authType } };
      if (method === 'turn/start') return { turn: { id: 'next-turn' } };
      if (method === 'thread/compact/start') {
        await options.beforeCompactAck?.();
        if (options.compactFailure) throw new Error('Native compact refused');
      }
      return {};
    },
    notify: async () => {},
    registerNotificationHandler(method, handler) { handlers.set(method, handler); return () => handlers.delete(method); },
    registerRequestHandler: () => () => {}, onExit: () => () => {}, dispose: async () => {},
  };
  const core = createCodexAppServerRuntime({ happierSessionId: 'session', directory: '/workspace',
    host: { baseProcessEnv: {}, logger: { debug: vi.fn(), warn: vi.fn() }, createClient: async () => client } });
  const runtime = createCodexNativeAppServerSessionRuntime(core, 'session');
  runtime.watch(event => events.push(AgentSessionRuntimeEventSchema.parse(event)));
  return { core, runtime, events, requests, async notify(method: string, params: unknown) {
    receipts.publish(method, params);
    await handlers.get(method)?.(params);
  } };
}

const nativeUsage = { threadId: 'main', turnId: 'live-turn', tokenUsage: {
  total: { inputTokens: 180_000, cachedInputTokens: 100_000, outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 180_050 },
  last: { inputTokens: 180_000, cachedInputTokens: 100_000, outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 180_050 },
  modelContextWindow: 200_000,
} };

describe('Codex native compaction control', () => {
  it('declares the consumed native control with opt-in host defaults from one definition', async () => {
    const f = fixture();
    try {
      const capability = { events: true, manual: true,
        idle: { mode: 'host', defaultEnabled: false, defaultMinContextTokens: 180_000 } };
      expect(PLUGIN_MANIFEST.contributes.agents[0]?.capabilities.sessions?.compaction).toEqual(capability);
      expect(f.runtime.runtimeCapabilities).toMatchObject({ sessionCapabilities: { compaction: capability } });
    } finally { await f.runtime.dispose(); }
  });

  it.each([
    { authType: 'chatgpt', modelProvider: 'openai', modelId: 'gpt-5.6-sol', detected: true },
    { authType: 'chatgpt', modelProvider: 'openai', modelId: 'gpt-6.1-sol', detected: true },
    { authType: 'apiKey', modelProvider: 'openai', modelId: 'gpt-6.1-sol', detected: false },
    { authType: 'chatgpt', modelProvider: 'compatible', modelId: 'gpt-6.1-sol', detected: false },
    { authType: 'chatgpt', modelProvider: undefined, modelId: 'gpt-6.1-sol', detected: false },
    { authType: undefined, modelProvider: 'openai', modelId: 'gpt-6.1-sol', detected: false },
    { authType: 'chatgpt', modelProvider: 'openai', modelId: 'gpt-5.5-sol', detected: false },
    { authType: 'chatgpt', modelProvider: 'openai', modelId: 'other-6.1', detected: false },
  ])('reports detected lifetime only for the C7 qualified native route/model ($authType/$modelProvider/$modelId)', async options => {
    const f = fixture(options);
    try {
      await startCodexAppServerRuntime(f.core);
      await f.core.runtimeAuth.readIdentity({ serviceId: 'openai-codex' });
      await f.notify('turn/started', { threadId: 'main', turn: { id: 'live-turn', startedAt: 1 } });
      const requestCount = f.requests.length;
      await f.notify('thread/tokenUsage/updated', nativeUsage);
      const observation = f.events.findLast(event => event.kind === 'usage-observed');
      expect(observation).toMatchObject({ promptCache: { lastUseAtMs: 1_000 } });
      if (options.detected) expect(observation).toMatchObject({ promptCache: { ttlMs: PROMPT_CACHE_DURATIONS.openai.gpt56MinTtlMs } });
      else expect(observation?.kind === 'usage-observed' && observation.promptCache).not.toHaveProperty('ttlMs');
      expect(f.requests.length).toBe(requestCount);
    } finally { await f.runtime.dispose(); }
  });

  it.each(['active', 'settled'])('discards %s request cache evidence after model replacement', async stage => {
    const f = fixture();
    try {
      await startCodexAppServerRuntime(f.core);
      await f.notify('thread/tokenUsage/updated', nativeUsage);
      expect(f.events.findLast(event => event.kind === 'usage-observed')).not.toHaveProperty('promptCache');
      await f.notify('turn/started', { threadId: 'main', turn: { id: 'live-turn', startedAt: 1 } });
      if (stage === 'settled') await f.notify('turn/completed', { threadId: 'main', turn: { id: 'live-turn', status: 'completed' } });
      await f.notify('thread/tokenUsage/updated', nativeUsage);
      expect(f.events.findLast(event => event.kind === 'usage-observed')).toMatchObject({ promptCache: { lastUseAtMs: 1_000 } });
      await f.core.updateConfig({ modelId: 'gpt-6.1-sol' });
      await f.notify('thread/tokenUsage/updated', nativeUsage);
      expect(f.events.findLast(event => event.kind === 'usage-observed')).not.toHaveProperty('promptCache');
    } finally { await f.runtime.dispose(); }
  });

  it('retires request cache evidence when native authentication changes', async () => {
    const f = fixture({ authType: 'chatgpt', modelProvider: 'openai', modelId: 'gpt-6.1-sol' });
    try {
      await startCodexAppServerRuntime(f.core);
      await f.core.runtimeAuth.readIdentity({ serviceId: 'openai-codex' });
      await f.notify('turn/started', { threadId: 'main', turn: { id: 'live-turn', startedAt: 1 } });
      await f.notify('thread/tokenUsage/updated', nativeUsage);
      expect(f.events.findLast(event => event.kind === 'usage-observed')).toMatchObject({
        promptCache: { ttlMs: PROMPT_CACHE_DURATIONS.openai.gpt56MinTtlMs },
      });
      await f.notify('account/updated', { authMode: 'apiKey' });
      await f.notify('thread/tokenUsage/updated', nativeUsage);
      expect(f.events.findLast(event => event.kind === 'usage-observed')).not.toHaveProperty('promptCache');
    } finally { await f.runtime.dispose(); }
  });

  it('does not revive the old prefix clock from delayed usage after native compaction', async () => {
    const f = fixture();
    try {
      await startCodexAppServerRuntime(f.core);
      await f.notify('turn/started', { threadId: 'main', turn: { id: 'live-turn', startedAt: 1 } });
      await f.notify('turn/completed', { threadId: 'main', turn: { id: 'live-turn', status: 'completed' } });
      await f.runtime.compact!({ compactionId: 'prefix-change', trigger: 'manual' });
      await f.notify('turn/started', { threadId: 'main', turn: { id: 'compact-turn' } });
      await f.notify('turn/completed', { threadId: 'main', turn: { id: 'compact-turn', status: 'completed' } });
      await f.notify('thread/tokenUsage/updated', nativeUsage);
      expect(f.events.findLast(event => event.kind === 'usage-observed')).not.toHaveProperty('promptCache');
    } finally { await f.runtime.dispose(); }
  });
  it.each([
    { item: undefined, expected: 1_000 },
    { item: 'commandExecution', expected: 2_000 },
    { item: 'fileChange', expected: 2_000 },
    { item: 'mcpToolCall', expected: 2_000 },
  ])('publishes the live native request clock through attributed usage ($item)', async ({ item, expected }) => {
    const f = fixture();
    try {
      await startCodexAppServerRuntime(f.core);
      await f.notify('turn/started', { threadId: 'main', turn: { id: 'live-turn', startedAt: 1 } });
      if (item) await f.notify('item/completed', { threadId: 'main', turnId: 'live-turn', completedAtMs: 2_000,
        item: { id: 'tool', type: item, status: 'completed' } });
      await f.notify('item/completed', { threadId: 'other', turnId: 'live-turn', completedAtMs: 8_000,
        item: { id: 'foreign', type: 'commandExecution', status: 'completed' } });
      await f.notify('item/completed', { threadId: 'main', turnId: 'old-turn', completedAtMs: 9_000,
        item: { id: 'stale', type: 'commandExecution', status: 'completed' } });
      await f.notify('item/completed', { threadId: 'main', turnId: 'live-turn', completedAtMs: 10_000,
        item: { id: 'answer', type: 'agentMessage', text: 'Done' } });
      await f.notify('thread/tokenUsage/updated', { threadId: 'main', turnId: 'live-turn', tokenUsage: {
        total: { inputTokens: 180_000, cachedInputTokens: 100_000, outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 180_050 },
        last: { inputTokens: 180_000, cachedInputTokens: 100_000, outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 180_050 },
        modelContextWindow: 200_000,
      } });
      const observation = f.events.findLast(event => event.kind === 'usage-observed');
      expect(observation).toMatchObject({ promptCache: { lastUseAtMs: expected } });
      expect(observation?.kind === 'usage-observed' && observation.promptCache).not.toHaveProperty('ttlMs');
      await f.notify('turn/completed', { threadId: 'main', turn: { id: 'live-turn', status: 'completed' } });
    } finally { await f.runtime.dispose(); }
  });

  it.each(['manual', 'idle'] as const)('admits one %s native compact request, settles from correlated native items, and accepts the next prompt', async trigger => {
    const f = fixture();
    try {
      await startCodexAppServerRuntime(f.core);
      const requestsBeforeCompact = f.requests.length;
      expect(await f.runtime.compact!({ compactionId: 'host-compact', trigger })).toEqual({ status: 'admitted' });
      expect(f.requests.slice(requestsBeforeCompact)).toEqual([
        { method: 'thread/compact/start', params: { threadId: 'main' } },
      ]);
      expect(f.requests.filter(request => request.method === 'thread/compact/start')).toEqual([
        { method: 'thread/compact/start', params: { threadId: 'main' } },
      ]);
      expect(f.requests.filter(request => request.method === 'turn/start')).toHaveLength(0);
      expect(f.events.filter(event => event.kind === 'context-compaction' && event.phase === 'completed')).toHaveLength(0);
      await f.notify('item/started', { threadId: 'other', turnId: 'child-turn', item: { id: 'other-item', type: 'contextCompaction' } });
      await f.notify('turn/started', { threadId: 'main', turn: { id: 'compact-turn' } });
      const item = { threadId: 'main', turnId: 'compact-turn', item: { id: 'native-compact', type: 'contextCompaction' } };
      await f.notify('item/started', item);
      await f.notify('item/completed', { ...item, turnId: 'wrong-turn' });
      await f.notify('item/completed', item);
      await f.notify('item/completed', item);
      await f.notify('turn/completed', { threadId: 'main', turn: { id: 'compact-turn', status: 'completed' } });
      expect(f.events.filter(event => event.kind === 'context-compaction')).toMatchObject([
        { compactionId: 'host-compact', trigger, phase: 'started' },
        { compactionId: 'host-compact', trigger, phase: 'completed' },
      ]);
      expect(f.events.some(event => event.kind === 'turn-start' || event.kind === 'turn-complete')).toBe(false);
      expect(await f.runtime.send({ inputIds: ['next'], input: { text: 'Continue' }, delivery: { kind: 'newTurn', turnId: 'next-host' } }))
        .toMatchObject({ status: 'admitted' });
      await f.notify('turn/completed', { threadId: 'main', turn: { id: 'next-turn', status: 'completed' } });
      expect(f.events).toContainEqual(expect.objectContaining({ kind: 'turn-complete', turnId: 'next-host' }));
    } finally { await f.runtime.dispose(); }
  });

  it('retains compaction ownership for notifications before acknowledgement', async () => {
    let release!: () => void;
    const f = fixture({ beforeCompactAck: () => new Promise<void>(resolve => { release = resolve; }) });
    try {
      await startCodexAppServerRuntime(f.core);
      const admitted = f.runtime.compact!({ compactionId: 'early', trigger: 'idle' });
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      await f.notify('turn/started', { threadId: 'main', turn: { id: 'compact-turn' } });
      await f.notify('item/started', { threadId: 'main', turnId: 'compact-turn', item: { id: 'compact', type: 'contextCompaction' } });
      await f.notify('turn/completed', { threadId: 'main', turn: { id: 'compact-turn', status: 'completed' } });
      release();
      expect(await admitted).toEqual({ status: 'admitted' });
      expect(f.events.filter(event => event.kind === 'context-compaction')).toMatchObject([
        { compactionId: 'early', trigger: 'idle', phase: 'started' },
        { compactionId: 'early', trigger: 'idle', phase: 'completed' },
      ]);
      expect(f.events.some(event => event.kind === 'turn-start')).toBe(false);
    } finally { release?.(); await f.runtime.dispose(); }
  });

  it('reports native failure before acknowledgement as admission failure', async () => {
    let release!: () => void;
    const f = fixture({ beforeCompactAck: () => new Promise<void>(resolve => { release = resolve; }) });
    try {
      await startCodexAppServerRuntime(f.core);
      const admitted = f.runtime.compact!({ compactionId: 'early-failure', trigger: 'idle' });
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      await f.notify('turn/started', { threadId: 'main', turn: { id: 'compact-turn' } });
      await f.notify('turn/completed', { threadId: 'main', turn: { id: 'compact-turn', status: 'failed' } });
      release();
      expect(await admitted).toMatchObject({ status: 'rejected', retryable: false });
      expect(f.events.some(event => event.kind === 'turn-failed')).toBe(false);
    } finally { release?.(); await f.runtime.dispose(); }
  });

  it('cancels the native operation through the existing interrupt path', async () => {
    const f = fixture();
    try {
      await startCodexAppServerRuntime(f.core);
      await f.runtime.compact!({ compactionId: 'host-compact', trigger: 'idle' });
      await f.notify('turn/started', { threadId: 'main', turn: { id: 'compact-turn' } });
      const cancelled = f.runtime.cancel!({ turnId: 'host-compact', reason: 'user' });
      await vi.waitFor(() => expect(f.requests.some(request => request.method === 'turn/interrupt')).toBe(true));
      await f.notify('turn/completed', { threadId: 'main', turn: { id: 'compact-turn', status: 'interrupted' } });
      await cancelled;
      expect(f.events.filter(event => event.kind === 'context-compaction').at(-1))
        .toMatchObject({ compactionId: 'host-compact', trigger: 'idle', phase: 'cancelled' });
      expect(f.events.some(event => event.kind === 'turn-cancelled')).toBe(false);
    } finally { await f.runtime.dispose(); }
  });

  it('keeps native automatic compaction in its existing foreground turn', async () => {
    const f = fixture();
    try {
      await startCodexAppServerRuntime(f.core);
      await f.runtime.send({ inputIds: ['input'], input: { text: 'Continue' }, delivery: { kind: 'newTurn', turnId: 'host-turn' } });
      const item = { threadId: 'main', turnId: 'next-turn', item: { id: 'automatic', type: 'contextCompaction' } };
      await f.notify('item/started', item);
      await f.notify('item/completed', item);
      await f.notify('turn/completed', { threadId: 'main', turn: { id: 'next-turn', status: 'completed' } });
      expect(f.events.filter(event => event.kind === 'context-compaction')).toMatchObject([
        { compactionId: 'automatic', turnId: 'host-turn', trigger: 'unknown', phase: 'started' },
        { compactionId: 'automatic', turnId: 'host-turn', trigger: 'unknown', phase: 'completed' },
      ]);
    } finally { await f.runtime.dispose(); }
  });

  it('rejects unsupported instructions without a native effect and reports request refusal as admission failure', async () => {
    const f = fixture({ compactFailure: true });
    try {
      await startCodexAppServerRuntime(f.core);
      expect(await f.runtime.compact!({ compactionId: 'instructions', trigger: 'manual', instructions: 'Keep names' }))
        .toMatchObject({ status: 'unsupported', retryable: false });
      expect(f.requests.filter(request => request.method === 'thread/compact/start')).toHaveLength(0);
      expect(await f.runtime.compact!({ compactionId: 'refused', trigger: 'manual' })).toMatchObject({ status: 'rejected', retryable: false });
      expect(f.events.some(event => event.kind === 'turn-failed')).toBe(false);
    } finally { await f.runtime.dispose(); }
  });

  it.each(['failed', 'interrupted', 'disposed'] as const)('settles admitted %s compaction without a foreground lifecycle', async outcome => {
    const f = fixture();
    try {
      await startCodexAppServerRuntime(f.core);
      await f.runtime.compact!({ compactionId: 'host-compact', trigger: 'manual' });
      await f.notify('turn/started', { threadId: 'main', turn: { id: 'compact-turn' } });
      await f.notify('item/started', { threadId: 'main', turnId: 'compact-turn', item: { id: 'native-compact', type: 'contextCompaction' } });
      if (outcome === 'disposed') await f.runtime.dispose();
      else await f.notify('turn/completed', { threadId: 'main', turn: { id: 'compact-turn', status: outcome } });
      expect(f.events.filter(event => event.kind === 'context-compaction').at(-1))
        .toMatchObject({ compactionId: 'host-compact', phase: outcome === 'failed' ? 'failed' : 'cancelled' });
      expect(f.events.some(event => event.kind === 'turn-start' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled')).toBe(false);
    } finally { await f.runtime.dispose(); }
  });
});
