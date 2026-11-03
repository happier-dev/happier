import { describe, expect, it, vi } from 'vitest';
import type { AgentAcpProviderTurnSourceHost, AgentSessionRuntimeEvent, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { writeProviderTurnAgent } from '../../testkit/providerTurnAgent';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';

describe('public ACP provider continuation', () => {
  it('retains the originating authority after a later turn and publishes lifecycle/output/terminal in order', async () => {
    await withTempDir('public-provider-turn-', async directory => {
      let host: AgentAcpProviderTurnSourceHost | undefined;
      const events: AgentSessionRuntimeEvent[] = [];
      const requestInteraction = vi.fn(async () => ({ status: 'approved' as const }));
      const script = writeProviderTurnAgent(directory);
      const dependencies: PublicAcpComposerDependencies = {
        pluginId: 'fixture', agentId: 'fixture', signal: new AbortController().signal, isCurrent: () => true,
        systemTools: { resolve: async () => ({ toolId: 'fixture', launch: {
          kind: 'binary', executablePath: process.execPath, args: [script],
        } }) },
        interactions: { request: requestInteraction },
        media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
        models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
      };
      const runtime = await createPublicAcpSession({ kind: 'create', sessionId: 'public', cwd: directory }, {
        transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture' } },
        definition: { mcp: { policy: 'pass_through' } },
        providerTurnSource: async value => { host = value; return { catchUp: async () => {}, dispose() {} }; },
      }, dependencies);
      const subscription = runtime.watch(event => events.push(event));
      const terminal = (turnId: string) => events.some(event => event.kind === 'turn-complete' && event.turnId === turnId);
      try {
        expect(runtime.runtimeCapabilities?.providerContinuations).toEqual({ supported: true });
        expect(host).toBeDefined();
        await runtime.send({ inputIds: ['input-1'], input: { text: 'first' }, delivery: { kind: 'newTurn', turnId: 'parent' },
          causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } });
        await expect.poll(() => terminal('parent')).toBe(true);
        await runtime.send({ inputIds: ['input-2'], input: { text: 'second' }, delivery: { kind: 'newTurn', turnId: 'later' },
          causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' } });
        await expect.poll(() => terminal('later')).toBe(true);
        expect(host!.registerContinuation({ id: 'task', parentToolCallId: '0:background' })).toBe(true);
        const sink = host!.beginContinuation({ id: 'task', turnId: '2' });
        expect(sink).not.toBeNull();
        await sink!.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'BACKGROUND' } });
        await sink!.update({ sessionUpdate: 'plan', entries: [
          { content: 'Check background result', status: 'in_progress', priority: 'high' },
        ] });
        const permission = await runtime.requestExtension('test/permission', { toolCallId: '2:execute' });
        expect(permission).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
        expect(requestInteraction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
          permissionContext: expect.objectContaining({ causalPermissionAuthority: {
            kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default',
          } }),
        }));
        await sink!.finish({ kind: 'completed' });
        const started = events.find(event => event.kind === 'turn-start' && event.startedBy === 'provider');
        expect(started).toMatchObject({ causedByTurnId: 'parent', continuationId: 'task', agentTurnId: '2' });
        if (!started || started.kind !== 'turn-start') throw new Error('Missing continuation start');
        await expect.poll(() => terminal(started.turnId)).toBe(true);
        expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', turnId: started.turnId, text: 'BACKGROUND' }));
        expect(events).toContainEqual(expect.objectContaining({ kind: 'provider-continuation-registered', parentTurnId: 'parent', parentToolCallId: '0:background' }));
        expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-call', turnId: started.turnId,
          toolName: 'TodoWrite', input: { todos: [{ content: 'Check background result', status: 'in_progress', priority: 'high' }] },
        }));
        host!.releaseToolCalls(['0:background']);
        expect(host!.registerContinuation({ id: 'other', parentToolCallId: '0:background' })).toBe(false);
        expect(host!.beginContinuation({ id: 'task', turnId: '3' })).toBeNull();
      } finally { subscription.dispose(); await runtime.dispose(); }
    });
  });
});

async function withPublicContinuation(run: (fixture: {
  runtime: AgentSessionRuntime;
  host: AgentAcpProviderTurnSourceHost;
  events: AgentSessionRuntimeEvent[];
  requestInteraction: ReturnType<typeof vi.fn>;
  setCatchUp(handler: () => Promise<void>): void;
  listen(handler: (event: AgentSessionRuntimeEvent) => Promise<void>): void;
}) => Promise<void>) {
  await withTempDir('public-continuation-lifetime-', async directory => {
    let host: AgentAcpProviderTurnSourceHost | undefined;
    let catchUp = async () => {};
    const events: AgentSessionRuntimeEvent[] = [];
    let listener: ((event: AgentSessionRuntimeEvent) => Promise<void>) | undefined;
    const requestInteraction = vi.fn(async () => ({ status: 'approved' as const }));
    const runtime = await createPublicAcpSession({ kind: 'create', sessionId: 'public', cwd: directory }, {
      transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture' } },
      providerTurnSource: async value => { host = value; return { catchUp: () => catchUp(), dispose() {} }; },
    }, {
      pluginId: 'fixture', agentId: 'fixture', signal: new AbortController().signal, isCurrent: () => true,
      systemTools: { resolve: async () => ({ toolId: 'fixture', launch: {
        kind: 'binary', executablePath: process.execPath, args: [writeProviderTurnAgent(directory)],
      } }) }, interactions: { request: requestInteraction },
      media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    });
    const subscription = runtime.watch(async event => { await listener?.(event); events.push(event); });
    try {
      await runtime.send({ inputIds: ['input-parent'], input: { text: 'first' }, delivery: { kind: 'newTurn', turnId: 'parent' },
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } });
      await expect.poll(() => events.some(event => event.kind === 'turn-complete' && event.turnId === 'parent')).toBe(true);
      expect(host!.registerContinuation({ id: 'task', parentToolCallId: '0:background' })).toBe(true);
      await run({ runtime, host: host!, events, requestInteraction, setCatchUp: handler => { catchUp = handler; }, listen: handler => { listener = handler; } });
    } finally { subscription.dispose(); await runtime.dispose(); }
  });
}

it('does not overwrite a provider turn admitted while a foreground prompt is being projected', async () => {
  await withPublicContinuation(async ({ runtime, host, events }) => {
    const pending = runtime.send({ inputIds: ['racing-input'], input: { text: 'Racing foreground' },
      delivery: { kind: 'newTurn', turnId: 'racing-turn' } });
    const sink = host.beginContinuation({ id: 'task', turnId: '1' });
    expect(sink).not.toBeNull();
    expect(await pending).toMatchObject({ status: 'rejected', retryable: true,
      diagnostic: { code: 'acp_turn_already_active' } });
    await sink!.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'KEPT' } });
    await sink!.finish({ kind: 'completed' });
    await expect.poll(() => events.some(event => event.kind === 'message-delta' && event.text === 'KEPT')).toBe(true);
    const start = events.find(event => event.kind === 'turn-start' && event.startedBy === 'provider');
    if (!start || start.kind !== 'turn-start') throw new Error('Missing provider turn');
    await expect.poll(() => events.some(event => event.kind === 'turn-complete' && event.turnId === start.turnId)).toBe(true);
    expect(events.some(event => 'turnId' in event && event.turnId === 'racing-turn')).toBe(false);
  });
});

it.each(['permission', 'elicitation'] as const)('waits for the host to admit the provider start before %s', async interaction => {
  await withPublicContinuation(async ({ runtime, host, requestInteraction, listen }) => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    listen(async event => {
      if (event.kind === 'turn-start' && event.startedBy === 'provider') { entered(); await gate; }
    });
    const sink = host.beginContinuation({ id: 'task', turnId: '1' });
    expect(sink).not.toBeNull();
    const permission = runtime.requestExtension!(`test/${interaction}`, { toolCallId: '1:execute' });
    try {
      await started;
      await runtime.requestExtension!('test/status', {});
      expect(requestInteraction).not.toHaveBeenCalled();
    } finally { release(); }
    expect(await permission).toMatchObject(interaction === 'permission'
      ? { outcome: { outcome: 'selected', optionId: 'allow' } } : { action: 'accept' });
    await sink!.finish({ kind: 'completed' });
  });
});

it.each(['completed', 'cancelled', 'failed', 'hostCancel'] as const)(
  'preserves a fast provider terminal while start publication is held (%s)', async outcome => {
    await withPublicContinuation(async ({ runtime, host, events, listen }) => {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const reached = new Promise<void>(resolve => { entered = resolve; });
      let turnId: string | undefined;
      listen(async event => {
        if (event.kind === 'turn-start' && event.startedBy === 'provider') {
          turnId = event.turnId; entered(); await gate;
        }
      });
      const sink = host.beginContinuation({ id: 'task', turnId: '1' });
      expect(sink).not.toBeNull();
      await reached;
      let cancelling: Promise<unknown> | undefined;
      try {
        if (outcome === 'hostCancel') cancelling = runtime.cancel!({ turnId: turnId!, reason: 'user' });
        else await sink!.finish(outcome === 'failed' ? { kind: 'failed', message: 'fixture failure' } : { kind: outcome });
      } finally { release(); }
      await cancelling;
      const kind = outcome === 'completed' ? 'turn-complete' : outcome === 'failed' ? 'turn-failed' : 'turn-cancelled';
      await expect.poll(() => events.some(event => event.kind === kind && event.turnId === turnId)).toBe(true);
      expect(events.filter(event => ['turn-complete', 'turn-failed', 'turn-cancelled'].includes(event.kind)
        && 'turnId' in event && event.turnId === turnId)).toHaveLength(1);
    });
  });

it('rejects unknown parents, reused continuations, foreign requests and sources retired by disposal', async () => {
  await withPublicContinuation(async ({ runtime, host, requestInteraction }) => {
    expect(host.registerContinuation({ id: 'unknown', parentToolCallId: 'missing' })).toBe(false);
    expect(host.registerContinuation({ id: 'task', parentToolCallId: '0:background' })).toBe(false);
    expect(host.beginContinuation({ id: 'unregistered', turnId: '1' })).toBeNull();
    const sink = host.beginContinuation({ id: 'task', turnId: '1' });
    expect(sink).not.toBeNull();
    expect(await runtime.requestExtension!('test/permission', { sessionId: 'foreign', toolCallId: '1:execute' }))
      .toEqual({ outcome: { outcome: 'cancelled' } });
    expect(requestInteraction).not.toHaveBeenCalled();
    await sink!.finish({ kind: 'completed' });
    expect(host.beginContinuation({ id: 'task', turnId: '2' })).toBeNull();
    await runtime.dispose();
    expect(host.signal.aborted).toBe(true);
    expect(host.registerContinuation({ id: 'retired', parentToolCallId: '0:background' })).toBe(false);
    await sink!.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale' } });
  });
});

it('observes a retired source catch-up rejection after a failed terminal', async () => {
  await withPublicContinuation(async ({ runtime, host, events, setCatchUp }) => {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    setCatchUp(async () => { entered(); await gate; });
    const sink = host.beginContinuation({ id: 'task', turnId: '1' });
    try {
      await sink!.finish({ kind: 'failed', message: 'fixture failure' });
      await reached;
      await expect.poll(() => events.filter(event => event.kind === 'turn-failed')).toHaveLength(1);
      await runtime.dispose();
    } finally { release(); }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(events.filter(event => event.kind === 'turn-failed')).toHaveLength(1);
  });
});

it.each(['process exit', 'source failure'] as const)('publishes runtime termination after the failed turn for %s', async failure => {
  await withPublicContinuation(async ({ runtime, host, events, setCatchUp }) => {
    const status = await runtime.requestExtension!('test/status', {});
    if (!status || typeof status !== 'object' || Array.isArray(status) || typeof status.pid !== 'number') {
      throw new Error('Missing fixture process identity');
    }
    setCatchUp(async () => { throw new Error('journal unavailable'); });
    expect(host.beginContinuation({ id: 'task', turnId: '1' })).not.toBeNull();
    await expect.poll(() => events.some(event => event.kind === 'turn-start' && event.startedBy === 'provider')).toBe(true);
    if (failure === 'process exit') process.kill(status.pid, 'SIGTERM');
    else host.fail(new Error('Journal unavailable'));
    await expect.poll(() => events.filter(event => event.kind === 'turn-failed')).toHaveLength(1);
    await expect.poll(() => events.filter(event => event.kind === 'runtime-ended')).toHaveLength(1);
    expect(events.findIndex(event => event.kind === 'turn-failed'))
      .toBeLessThan(events.findIndex(event => event.kind === 'runtime-ended'));
  });
});


it('keeps the public runtime usable after restarting a peer that never answers native close', async () => {
  await withPublicContinuation(async ({ runtime, host, events }) => {
    expect(host.beginContinuation({ id: 'task', turnId: '1' })).not.toBeNull();
    await expect.poll(() => events.some(event => event.kind === 'turn-start' && event.startedBy === 'provider')).toBe(true);
    const turn = events.find((event): event is Extract<AgentSessionRuntimeEvent, { kind: 'turn-start' }> =>
      event.kind === 'turn-start' && event.startedBy === 'provider');
    if (!turn) throw new Error('Missing continuation');
    await runtime.requestExtension!('test/hold-close', {});
    await expect(runtime.cancel!({ turnId: turn.turnId, reason: 'user' })).resolves.toMatchObject({ status: 'requested' });
    await expect.poll(() => events.some(event => event.kind === 'turn-cancelled' && event.turnId === turn.turnId)).toBe(true);
    expect(await runtime.send({ inputIds: ['next'], input: { text: 'Successor.' }, delivery: { kind: 'newTurn', turnId: 'next' },
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
    })).toEqual({ status: 'admitted' });
    await expect.poll(() => events.some(event => event.kind === 'turn-complete' && event.turnId === 'next')).toBe(true);
  });
}, 10_000);

it.each(['Connection aborted', 'Upstream cancelled the request'])(
  'retains an ordinary provider failure containing cancellation words: %s', async message => {
    await withPublicContinuation(async ({ host, events }) => {
      const sink = host.beginContinuation({ id: 'task', turnId: '1' });
      expect(sink).not.toBeNull();
      await sink!.finish({ kind: 'failed', message });
      await expect.poll(() => events.some(event => event.kind === 'turn-failed')).toBe(true);
      expect(events.some(event => event.kind === 'turn-cancelled')).toBe(false);
    });
  });

it('preserves independent step usage identities and totals across continuations and resumed publication', async () => {
  const snapshots: Array<Array<{ observationId: string; total: number }>> = [];
  for (let attachment = 0; attachment < 2; attachment += 1) {
    await withPublicContinuation(async ({ host, events }) => {
      for (let turn = 0; turn < 2; turn += 1) {
        if (turn > 0) expect(host.registerContinuation({ id: 'next', parentToolCallId: '0:background' })).toBe(true);
        const sink = host.beginContinuation({ id: turn === 0 ? 'task' : 'next', turnId: String(turn + 1) });
        expect(sink).not.toBeNull();
        for (const step of [0, 1, 0]) {
          await sink!.update({ sessionUpdate: 'usage_update', key: `native-step-${turn}-${step}`, scope: 'turn_delta',
            inputTokens: 150, outputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 20, totalTokens: 160 });
        }
        await sink!.finish({ kind: 'completed' });
        await expect.poll(() => events.filter(event => event.kind === 'turn-complete')).toHaveLength(turn + 2);
      }
      const usage = events.filter((event): event is Extract<AgentSessionRuntimeEvent, { kind: 'usage-observed' }> => event.kind === 'usage-observed');
      expect(usage.map(event => event.scope)).toEqual(Array(6).fill('turn_delta'));
      expect(usage.map(event => event.tokens?.total)).toEqual(Array(6).fill(160));
      expect(usage.map(event => event.observationId)).toEqual([
        'native-step-0-0', 'native-step-0-1', 'native-step-0-0', 'native-step-1-0', 'native-step-1-1', 'native-step-1-0',
      ]);
      snapshots.push(usage.map(event => ({ observationId: event.observationId, total: event.tokens!.total })));
    });
  }
  expect(snapshots[1]).toEqual(snapshots[0]);
});
