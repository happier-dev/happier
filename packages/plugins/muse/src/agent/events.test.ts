import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { resolveUsageTokenCategories } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createAgentSessionRuntimeHarness } from '@happier-dev/plugin-sdk/testing';
import { openMuseMsp } from './msp.js';
import { createMuseMspProcessFixture } from './testkit/mspProcess.js';
import { createMuseEventProjection, readMuseRecord } from './events.js';

const recording = JSON.parse(readFileSync(new URL('./testkit/fixtures/login-smoke.json', import.meta.url), 'utf8')) as {
  rows: Array<{ direction: string; message: { method?: string; params?: JsonValue; result?: JsonValue } }>;
};
const nativeTurnId = '01a1bf87-e037-7cc3-ad73-d6ffffa47b13';

describe('Muse event projection', () => {
  it('reconciles native user echo with host input while retaining unowned native messages', () => {
    const user = recording.rows.find(row => row.direction === 'recv' && row.message.method === 'item/completed')?.message;
    if (!user?.method) throw new Error('The native recording must contain its user message');
    const owned = createMuseEventProjection({ sessionId: 'host-session' });
    const unowned = createMuseEventProjection({ sessionId: 'host-session' });
    const ownedEvents: AgentSessionRuntimeEvent[] = [];
    const unownedEvents: AgentSessionRuntimeEvent[] = [];
    owned.watch(event => ownedEvents.push(event));
    unowned.watch(event => unownedEvents.push(event));
    owned.admit({ inputIds: ['host-input'], input: { text: 'Reply with exactly PEBBLE. Do not use tools.' },
      delivery: { kind: 'newTurn', turnId: 'host-turn' } }, nativeTurnId);
    // An echo can follow its acknowledgment; its native command identity must survive that boundary.
    owned.accept(nativeTurnId, { status: 'accepted', disposition: 'started', turnId: nativeTurnId });
    owned.observe({ method: user.method, params: user.params });
    unowned.observe({ method: user.method, params: user.params });
    expect(ownedEvents.filter(event => event.kind === 'transcript-message-committed' && event.role === 'user')).toHaveLength(0);
    expect(unownedEvents.filter(event => event.kind === 'transcript-message-committed' && event.role === 'user')).toMatchObject([
      { text: 'Reply with exactly PEBBLE. Do not use tools.' },
    ]);
  });

  it('projects the recorded reply once and waits for its owning native terminal', () => {
    const projection = createMuseEventProjection({ sessionId: 'host-session' });
    const first: AgentSessionRuntimeEvent[] = [];
    const second: AgentSessionRuntimeEvent[] = [];
    projection.watch(event => first.push(event));
    projection.watch(event => second.push(event));
    projection.admit({ inputIds: ['input-1'], input: { text: 'Reply with exactly PEBBLE. Do not use tools.' }, delivery: { kind: 'newTurn', turnId: 'host-turn' } }, nativeTurnId);
    projection.accept(nativeTurnId, { status: 'accepted', disposition: 'started', turnId: nativeTurnId });
    for (const row of recording.rows) {
      if (row.direction !== 'recv' || !row.message.method || row.message.method === 'session/closed') continue;
      projection.observe({ method: row.message.method, params: row.message.params });
      if (row.message.method === 'turn/foregroundCompleted') {
        expect(first.filter(event => event.kind === 'turn-complete')).toHaveLength(0);
      }
    }
    expect(first.filter(event => event.kind === 'message-delta').map(event => event.text).join('')).toBe('PEBBLE');
    expect(first.filter(event => event.kind === 'transcript-message-committed' && event.role === 'assistant')).toMatchObject([{ messageId: 'bbeccc34-d46b-4a8e-a7d7-39cee6ebce1a', text: 'PEBBLE', turnId: 'host-turn' }]);
    expect(first.filter(event => event.kind === 'turn-complete')).toMatchObject([{ turnId: 'host-turn', agentTurnId: nativeTurnId }]);
    expect(second).toHaveLength(first.length);
    expect(second.every((event, index) => event === first[index])).toBe(true);
    expect(first.map(event => event.sequence)).toEqual(first.map((_, index) => index + 1));
    for (const event of first) expect(AgentSessionRuntimeEventV1Schema.safeParse(event).success).toBe(true);
  });
});


async function withNativeProjection(name: string, inspect: (fixture: Readonly<{ events: ReturnType<typeof createAgentSessionRuntimeHarness>; workflowCompleted: Promise<void> }>) => Promise<void>,
  transformRecording?: (recording: JsonValue) => JsonValue) {
  const projection = createMuseEventProjection({ sessionId: 'host-tools' });
  const events = createAgentSessionRuntimeHarness();
  projection.watch(events.recordRuntimeEvent);
  const captured: JsonValue = JSON.parse(readFileSync(new URL(`./testkit/fixtures/${name}.json`, import.meta.url), 'utf8'));
  const recording = transformRecording ? transformRecording(captured) : captured;
  const rows = readMuseRecord(recording).rows;
  // Replay one captured turn; later independent turns belong to their own admission.
  const nativeRows = (Array.isArray(rows) ? rows : []).map(readMuseRecord);
  const firstTurn = nativeRows.findIndex(row => row.direction === 'send' && readMuseRecord(row.message).method === 'turn/start');
  const nextTurn = nativeRows.findIndex((row, index) => index > firstTurn && row.direction === 'send'
    && readMuseRecord(row.message).method === 'turn/start');
  const sentTurn = (Array.isArray(rows) ? rows : []).map(readMuseRecord)
    .filter(row => row.direction === 'send').map(row => readMuseRecord(row.message))
    .find(message => message.method === 'turn/start');
  const input = readMuseRecord(sentTurn?.params).input;
  const text = (Array.isArray(input) ? input : []).map(readMuseRecord)
    .filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
  if (!text) throw new Error('Native capture must contain its text input');
  const { launch, ...boundary } = await createMuseMspProcessFixture({ recording: nextTurn < 0 ? recording
    : { ...readMuseRecord(recording), rows: nativeRows.slice(0, nextTurn) } });
  const signal = new AbortController().signal;
  const exec = createStablePluginExecService({ ...boundary, signal, isOccurrenceCurrent: () => true });
  let finishWorkflow!: () => void;
  const workflowCompleted = new Promise<void>(resolve => { finishWorkflow = resolve; });
  const msp = await openMuseMsp({ exec, launch, onNotification: async message => {
    await projection.observe(message);
    const item = readMuseRecord(readMuseRecord(message.params).item);
    if (message.method === 'item/completed' && item.kind === 'workflow') finishWorkflow();
  } });
  try {
    const opened = await msp.command('session/start', { workspaceRoot: process.cwd() });
    const session = opened && typeof opened === 'object' && !Array.isArray(opened) ? opened.session : undefined;
    if (!session || typeof session !== 'object' || Array.isArray(session) || typeof session.sessionId !== 'string') {
      throw new Error('Native capture must return its Session identity');
    }
    const request = { inputIds: ['native-tools'], input: { text },
      delivery: { kind: 'newTurn' as const, turnId: 'host-tools-turn' } };
    let commandId = '';
    const result = await msp.command('turn/start', { sessionId: session.sessionId,
      input: [{ type: 'text', text: request.input.text }] }, { onCommandId(id) { commandId = id; projection.admit(request, id); } });
    projection.accept(commandId, result);
    await events.until('turn-complete');
    await inspect({ events, workflowCompleted });
  } finally {
    await msp.dispose();
    projection.dispose();
    events.dispose();
  }
}

it('projects native process tool and inference usage observations', async () => {
  await withNativeProjection('mcp', async ({ events }) => {
    events.expectAllEventsValidated();
    events.expectExactlyOneTerminalEvent({ turnId: 'host-tools-turn' });
    expect(events.canonicalEvents().filter(event => event.kind === 'tool-call' && event.toolName === 'mcp__probe__pebble')).toMatchObject([
      { toolCallId: 'call_01a1bf8c580c759e8fc223725db81940', toolName: 'mcp__probe__pebble', input: {}, turnId: 'host-tools-turn' },
    ]);
    expect(events.canonicalEvents().filter(event => event.kind === 'tool-result' && event.toolCallId === 'call_01a1bf8c580c759e8fc223725db81940')).toMatchObject([
      { toolCallId: 'call_01a1bf8c580c759e8fc223725db81940', output: 'PEBBLE', isError: false, turnId: 'host-tools-turn' },
    ]);
    expect(events.canonicalEvents().filter(event => event.kind === 'usage-observed' && event.tokens)).toMatchObject([
      { scope: 'turn_delta', tokens: { input: 28274, output: 90, reasoning: 33, cacheRead: 0, total: 28364 } },
      { scope: 'turn_delta', tokens: { input: 28397, output: 20, reasoning: 8, cacheRead: 28148, total: 28417 } },
    ]);
  });
});

it('keeps the recorded rejected tool identity when its output arrives after completion', async () => {
  await withNativeProjection('advanced', async ({ events }) => {
    events.expectAllEventsValidated();
    events.expectExactlyOneTerminalEvent({ turnId: 'host-tools-turn' });
    const observed = events.canonicalEvents();
    const nativeTool = observed.find(event => event.kind === 'tool-call' && event.toolName === 'Bash');
    if (!nativeTool || nativeTool.kind !== 'tool-call') throw new Error('Expected the captured rejected Bash tool');
    const sameTool = observed.filter(event => 'toolCallId' in event && event.toolCallId === nativeTool.toolCallId);
    expect(sameTool.filter(event => event.kind === 'tool-call')).toHaveLength(1);
    expect(sameTool.filter(event => event.kind === 'tool-result')).toMatchObject([
      { isError: true },
      { output: expect.stringContaining('tool denied: approval aborted'), isError: true },
    ]);
  });
});

it('retains readable native fallback items without creating a foreground terminal', async () => {
  await withNativeProjection('advanced', async ({ events }) => {
    const observed = events.canonicalEvents();
    const fallbacks = observed.filter(event => event.kind === 'tool-call' && event.toolName === 'reminderChild');
    // This turn contains three distinct native reminder children, each with its own item identity.
    expect(fallbacks).toHaveLength(3);
    expect(fallbacks.every(event => event.kind === 'tool-call' && readMuseRecord(event.input).text === 'Reminder child session')).toBe(true);
    const fallback = observed.find(event => event.kind === 'tool-call' && event.toolName === 'reminderChild');
    if (!fallback || fallback.kind !== 'tool-call') throw new Error('Expected native fallback item');
    expect(observed.filter(event => event.kind === 'tool-result' && event.toolCallId === fallback.toolCallId))
      .toMatchObject([{ output: 'Reminder child session', isError: false }]);
    events.expectExactlyOneTerminalEvent({ turnId: 'host-tools-turn' });
    events.expectAllEventsValidated();
  });
});

it('settles an in-flight native fallback when the runtime ends', () => {
  const projection = createMuseEventProjection({ sessionId: 'host-tools' });
  const observed: AgentSessionRuntimeEvent[] = [];
  projection.watch(event => observed.push(event));
  projection.observe({ method: 'item/started', params: { item: {
    itemId: 'reminder-01', kind: 'reminderChild', fallbackText: 'Reminder child session', status: 'inProgress',
  } } });
  projection.publish({ kind: 'runtime-ended', cause: 'processExited', retryable: true });
  expect(observed).toContainEqual(expect.objectContaining({ kind: 'tool-call', toolCallId: 'reminder-01', toolName: 'reminderChild' }));
  expect(observed).toContainEqual(expect.objectContaining({ kind: 'tool-result', toolCallId: 'reminder-01', isError: true }));
  projection.dispose();
});

it('preserves the native user-shell environment failure without inventing a turn', () => {
  const captured = JSON.parse(readFileSync(new URL('./testkit/fixtures/isolated-read-only-shell-unavailable.json', import.meta.url), 'utf8')) as typeof recording;
  const projection = createMuseEventProjection({ sessionId: 'host-shell' });
  const events = createAgentSessionRuntimeHarness();
  projection.watch(events.recordRuntimeEvent);
  for (const row of captured.rows) {
    if (row.direction !== 'recv' || !row.message.method) continue;
    projection.observe({ method: row.message.method, params: row.message.params });
    // The same full native revision may be delivered again; it remains one tool row/result.
    if (row.message.method.startsWith('item/')) projection.observe({ method: row.message.method, params: row.message.params });
  }
  const observed = events.canonicalEvents();
  expect(observed.filter(event => event.kind === 'tool-call')).toMatchObject([{ toolName: 'Bash' }]);
  expect(observed.filter(event => event.kind === 'tool-result')).toMatchObject([
    { output: expect.stringContaining('managed shell sandbox is unavailable'), isError: true },
  ]);
  expect(observed.filter(event => event.kind === 'turn-start' || event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled')).toHaveLength(0);
  events.expectAllEventsValidated();
  events.dispose();
  projection.dispose();
});

it('keeps counted prompt, reasoning, cache and context observations separate', () => {
  const projection = createMuseEventProjection({ sessionId: 'host-usage' });
  const observed: AgentSessionRuntimeEvent[] = [];
  projection.watch(event => observed.push(event));
  for (const row of recording.rows) {
    if (row.direction === 'recv' && row.message.method) projection.observe({ method: row.message.method, params: row.message.params });
  }
  const usage = observed.filter(event => event.kind === 'usage-observed');
  expect(usage.filter(event => event.tokens)).toMatchObject([
    { scope: 'turn_delta', tokens: { input: 28177, output: 22, reasoning: 10, cacheRead: 0, cacheWrite: 0, total: 28199 } },
  ]);
  expect(usage.filter(event => event.context)).toMatchObject([
    { context: { usedTokens: 28446, windowTokens: 1007997 } },
  ]);
  const inference = usage.find(event => event.tokens);
  if (!inference?.tokens) throw new Error('Expected native inference usage');
  expect(resolveUsageTokenCategories(inference.tokens, inference.accounting)).toMatchObject({ input: 28177, output: 12, reasoning: 10, total: 28199 });
  const cached = JSON.parse(readFileSync(new URL('./testkit/fixtures/mcp.json', import.meta.url), 'utf8')) as typeof recording;
  for (const row of cached.rows) {
    if (row.direction === 'recv' && row.message.method === 'session/tokenUsage') projection.observe({ method: row.message.method, params: row.message.params });
  }
  const cachedInference = observed.find(event => event.kind === 'usage-observed' && event.tokens?.cacheRead === 28148);
  if (!cachedInference || cachedInference.kind !== 'usage-observed' || !cachedInference.tokens) throw new Error('Expected captured cached inference');
  expect(resolveUsageTokenCategories(cachedInference.tokens, cachedInference.accounting))
    .toMatchObject({ input: 249, output: 12, reasoning: 8, cacheRead: 28148, total: 28417 });
});

it('retains native accounting identity when optional cache split counters are absent', async () => {
  await withNativeProjection('login-smoke', async ({ events }) => {
    const observations = events.canonicalEvents().filter(event => event.kind === 'usage-observed' && !event.context);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ scope: 'turn_delta', source: 'muse-native-accounting',
      accounting: { nativeSessionId: '01a1bf87-da7f-7ce0-a4ff-bab34925049f', inferenceId: expect.any(String) } });
    if (observations[0]?.kind !== 'usage-observed') throw new Error('Expected native accounting evidence');
    expect(observations[0].tokens).toBeUndefined();
    expect(observations[0].accounting?.inputIncludesCache).toBeUndefined();
    expect(observations[0].accounting?.outputIncludesReasoning).toBeUndefined();
    events.expectAllEventsValidated();
  }, captured => {
    const rows = readMuseRecord(captured).rows;
    if (!Array.isArray(rows)) throw new Error('Expected native recording rows');
    return { ...readMuseRecord(captured), rows: rows.map(row => {
      const message = readMuseRecord(readMuseRecord(row).message);
      if (message.method !== 'session/tokenUsage') return row;
      const params = readMuseRecord(message.params);
      const { cacheReadTokens: _read, cacheWriteTokens: _write, ...usage } = readMuseRecord(params.usage);
      // Schema-derived omission: TokenUsage makes the split counters optional.
      return { ...readMuseRecord(row), message: { ...message, params: { ...params, usage } } };
    }) };
  });
});

it('publishes observed child accounting identity without guessing transitive token categories', async () => {
  await withNativeProjection('child-follow', async ({ events, workflowCompleted }) => {
    await workflowCompleted;
    const observations = events.canonicalEvents().filter(event => event.kind === 'usage-observed'
      && event.accounting?.nativeSessionId === '57eb5081-f640-7bd6-8b7f-19602770febe');
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ scope: 'session_cumulative', source: 'muse-native-accounting' });
    if (observations[0]?.kind !== 'usage-observed') throw new Error('Expected native child accounting evidence');
    expect(observations[0].tokens).toBeUndefined();
    expect(observations[0].accounting).toEqual({ nativeSessionId: '57eb5081-f640-7bd6-8b7f-19602770febe' });
    expect(observations[0].turnId).toBeUndefined();
    events.expectAllEventsValidated();
  });
});

it.each([0, 1, 3])('normalizes 1000 native arrivals once with %i watchers and fans out the same events', watchers => {
  const native = recording.rows.find(row => row.direction === 'recv' && row.message.method === 'session/tokenUsage')?.message;
  if (!native?.method) throw new Error('Expected native usage capture');
  const projection = createMuseEventProjection({ sessionId: 'host-fanout' });
  const outputs = Array.from({ length: watchers }, () => [] as AgentSessionRuntimeEvent[]);
  for (const output of outputs) projection.watch(event => output.push(event));
  let nativeReads = 0;
  for (let index = 0; index < 1000; index++) {
    projection.observe({ method: native.method, get params() { nativeReads++; return native.params; } });
  }
  if (watchers === 0) {
    const retained: AgentSessionRuntimeEvent[] = [];
    projection.watch(event => retained.push(event));
    outputs.push(retained);
  }
  expect(nativeReads).toBe(1000);
  expect(outputs[0]).toHaveLength(1000);
  expect(new Set(outputs[0].map(event => event.kind === 'usage-observed' ? event.observationId : null)).size).toBe(1);
  expect(outputs[0].map(event => event.sequence)).toEqual(Array.from({ length: 1000 }, (_, index) => index + 1));
  for (const output of outputs) expect(output.every((event, index) => event === outputs[0][index])).toBe(true);
  projection.dispose();
});

it('retains the native workflow continuation and late child after its parent terminal', async () => {
  await withNativeProjection('child-follow', async ({ events, workflowCompleted }) => {
    await workflowCompleted;
    events.expectAllEventsValidated();
    events.expectExactlyOneTerminalEvent({ turnId: 'host-tools-turn' });
    const observed = events.canonicalEvents();
    const workflowRunId = 'workflow-run-model-tool-call_01a1bf905346757f812d3092658adbe9';
    expect(observed.filter(event => event.kind === 'provider-continuation-registered')).toMatchObject([
      { continuationId: workflowRunId, parentTurnId: 'host-tools-turn', parentToolCallId: 'call_01a1bf905346757f812d3092658adbe9' },
    ]);
    expect(observed.filter(event => event.kind === 'provider-continuation-released')).toMatchObject([
      { continuationId: workflowRunId },
    ]);
    const terminalIndex = observed.findIndex(event => event.kind === 'turn-complete');
    const child = observed.find(event => event.kind === 'tool-call' && event.toolCallId === '01a1bf90-5807-7400-8dc6-5c1330a65971');
    expect(child).toMatchObject({ toolName: 'Task' });
    expect(child && observed.indexOf(child)).toBeGreaterThan(terminalIndex);
    expect(observed.filter(event => event.kind === 'tool-call' && event.toolCallId === '01a1bf90-5807-7400-8dc6-5c1330a65971')).toHaveLength(1);
    const childProgress = observed.filter(event => event.kind === 'tool-progress' && event.toolCallId === '01a1bf90-5807-7400-8dc6-5c1330a65971');
    expect(childProgress.some(event => event.kind === 'tool-progress' && readMuseRecord(readMuseRecord(readMuseRecord(event.progress).rawInput).nativeChild).childSessionId === '57eb5081-f640-7bd6-8b7f-19602770febe')).toBe(true);
    expect(observed.filter(event => event.kind === 'tool-result' && event.toolCallId === '01a1bf90-5807-7400-8dc6-5c1330a65971')).toMatchObject([
      { output: expect.objectContaining({ summary: 'CHILD', text: 'CHILD' }), isError: false },
    ]);
  });
});
