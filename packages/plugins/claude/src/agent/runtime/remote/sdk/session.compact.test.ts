import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { createEventsFixture, createPluginContextFixture, createSdkExecFixture, createTerminalHostFixture } from '../../engine.testkit.js';
import { createClaudeAgentSdkTurnOperations } from './session.js';
import { createClaudeNativeSessionRuntimeFromOperations } from '../../nativeRuntime.js';

function fixture() {
  const exec = createSdkExecFixture();
  const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, { exec: exec.service });
  const operations = createClaudeAgentSdkTurnOperations({ ctx, directory: '/tmp/claude-compact', launchEnv: {},
    permissionMode: 'default', initialProviderSessionId: 'native-compact', happierSessionId: 'happy-compact',
    publishSdkMessages: true });
  const events: AgentSessionRuntimeEvent[] = [];
  // Host service registration is the external boundary; the compact facade and event bridge stay real.
  const context = { session: { services: { activeInput: { bind: () => ({ dispose() {} }) },
    models: { bind: () => ({ dispose() {} }) } } } } as unknown as AgentSessionRuntimeContext;
  const runtime = createClaudeNativeSessionRuntimeFromOperations(operations,
    { kind: 'create', sessionId: 'happy-compact', cwd: '/tmp/claude-compact' }, context);
  runtime.watch(event => { AgentSessionRuntimeEventSchema.parse(event); events.push(event); });
  const providerEvents: unknown[] = [];
  operations.subscribeProviderEvents(event => providerEvents.push(event));
  const compact = (request: Parameters<NonNullable<AgentSessionRuntime['compact']>>[0], signal?: AbortSignal) => {
    const control = runtime.compact;
    if (!control) throw new Error('SDK compact control is missing');
    return control(request, { signal });
  };
  return { exec, operations, events, providerEvents, compact, runtime };
}

describe('Claude SDK compact control', () => {
  it('retires an interrupted reusable query so the next prompt resumes the compacted conversation', async () => {
    const f = fixture();
    try {
      f.operations.beginProviderTurn('interrupted');
      await f.operations.sendProviderTurnPrompt('Before compact');
      await f.operations.cancelProviderTurn('interrupted');
      await f.exec.processes[0]!.emit({ type: 'result', subtype: 'error_during_execution',
        is_error: true, session_id: 'native-compact', errors: ['Interrupted by user'] });
      await vi.waitFor(() => expect(f.operations.isTurnInFlight()).toBe(false));
      await f.compact({ compactionId: 'after-interrupt', trigger: 'manual' });
      await f.exec.processes[1]!.emit({ type: 'system', subtype: 'compact_boundary', session_id: 'native-compact' });
      await f.exec.processes[1]!.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-compact' });
      f.operations.beginProviderTurn('following-compact');
      await f.operations.sendProviderTurnPrompt('After compact');
      expect(f.exec.processes).toHaveLength(3);
      expect(f.exec.processes[0]!.written).not.toContainEqual(expect.objectContaining({ type: 'user',
        message: { role: 'user', content: 'After compact' } }));
    } finally { await f.runtime.dispose(); }
  });

  it('rejects a second compact and a cancelled admission without opening another process', async () => {
    const f = fixture();
    try {
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(f.compact({ compactionId: 'cancelled', trigger: 'idle' }, cancelled.signal))
        .resolves.toMatchObject({ status: 'rejected', retryable: false });
      expect(f.exec.processes).toHaveLength(0);
      await f.compact({ compactionId: 'active', trigger: 'idle' });
      await expect(f.compact({ compactionId: 'duplicate', trigger: 'manual' }))
        .resolves.toMatchObject({ status: 'rejected', retryable: true });
      expect(f.exec.processes).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  it.each(['idle', 'manual'] as const)('owns one resumed %s query, measured boundary and following prompt without a foreground turn', async trigger => {
    const f = fixture();
    try {
      await expect(f.compact({ compactionId: 'compact-1', trigger, ...(trigger === 'manual' ? { instructions: 'Keep decisions' } : {}) }))
        .resolves.toEqual({ status: 'admitted' });
      expect(f.operations.isTurnInFlight?.()).toBe(false);
      expect(f.exec.processes).toHaveLength(1);
      expect(f.exec.spawnClient.mock.calls[0]![0].launch.args).toEqual(expect.arrayContaining(['--resume', 'native-compact']));
      expect(f.exec.written).toContainEqual(expect.objectContaining({ type: 'user',
        message: { role: 'user', content: trigger === 'manual' ? '/compact Keep decisions' : '/compact' } }));
      const process = f.exec.processes[0]!;
      await process.emit({ type: 'system', subtype: 'compact_boundary', session_id: 'native-compact',
        compact_metadata: { trigger: 'manual', pre_tokens: 220_000, post_tokens: 3_000 } });
      await process.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-compact' });
      await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ kind: 'context-compaction',
        compactionId: 'compact-1', trigger, phase: 'completed', tokenCountBefore: 220_000, tokenCountAfter: 3_000, tokenCountSource: 'providerReported' })));
      expect(f.events.filter(e => e.kind === 'context-compaction').map(e => e.phase)).toEqual(['started', 'completed']);
      expect(f.providerEvents).toEqual([]);
      expect(f.events.filter(e => e.kind === 'runtime-activity-snapshot')).toMatchObject([{ state: 'idle' }]);
      f.operations.beginProviderTurn('next-turn');
      await expect(f.operations.sendProviderTurnPrompt('Continue normally')).resolves.toEqual({ kind: 'accepted' });
      expect(f.exec.processes).toHaveLength(2);
    } finally { await f.runtime.dispose(); }
  });

  it.each(['failure', 'exit', 'abort', 'dispose', 'empty-success'] as const)('settles %s from native evidence and never invents a completed boundary', async outcome => {
    const f = fixture();
    const abort = new AbortController();
    try {
      await f.compact({ compactionId: 'compact-outcome', trigger: 'idle' }, abort.signal);
      const process = f.exec.processes[0]!;
      if (outcome === 'failure') await process.emit({ type: 'result', subtype: 'error_during_execution', is_error: true });
      if (outcome === 'empty-success') await process.emit({ type: 'result', subtype: 'success', is_error: false });
      if (outcome === 'exit') await process.exitWith({ exitCode: 1, signal: null });
      if (outcome === 'abort') abort.abort();
      if (outcome === 'dispose') await f.operations.disposeProviderSession();
      const phase = outcome === 'abort' || outcome === 'dispose' ? 'cancelled' : 'failed';
      await vi.waitFor(() => expect(f.events.filter(e => e.kind === 'context-compaction').map(e => e.phase))
        .toEqual(['started', phase]));
      expect(f.providerEvents).toEqual([]);
    } finally { await f.runtime.dispose(); }
  });
});
