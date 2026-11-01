import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { agentEventAttentionImpact } from '@happier-dev/protocol';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from './input/sessionProviderInputConsumer';
import { createSessionIdleCompactionScheduler } from './createSessionIdleCompactionScheduler';
import { projectRuntimeTranscriptEvent, type RuntimeTranscriptProjectionSession } from './transcripts/projectRuntimeTranscriptEvent';
import { createClaudeAgentSdkTurnOperations } from '../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createClaudeNativeSessionRuntimeFromOperations } from '../../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime';
import { createEventsFixture, createPluginContextFixture, createSdkExecFixture, createTerminalHostFixture } from '../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';

describe('Claude SDK usage → host idle admission → quiet compact', () => {
  it('combines split request/context facts, launches once, projects quiet native counts and accepts the next input', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(100_000);
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, { exec: exec.service });
    const operations = createClaudeAgentSdkTurnOperations({ ctx, directory: '/tmp/claude-composed', launchEnv: {},
      permissionMode: 'default', initialProviderSessionId: 'native-composed', happierSessionId: 'happy-composed', publishSdkMessages: true });
    // Host registration and persisted Session reads/writes are external boundaries; all runtime, admission and projection logic stays real.
    const context = { session: { services: { activeInput: { bind: () => ({ dispose() {} }) },
      models: { bind: () => ({ dispose() {} }) } } } } as unknown as AgentSessionRuntimeContext;
    const runtime = createClaudeNativeSessionRuntimeFromOperations(operations,
      { kind: 'create', sessionId: 'happy-composed', cwd: '/tmp/claude-composed' }, context);
    let activity: Extract<AgentSessionRuntimeEvent, { kind: 'runtime-activity-snapshot' }>['state'] = 'idle';
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: async () => false, getMetadataSnapshot: () => ({}), getAgentStateSnapshot: () => ({}),
      readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }),
      readNativeRuntimeActivitySnapshot: () => ({ state: activity, activeCount: 0 }),
      readRuntimeActivitySnapshotTail: () => ({ sequence: 1, custody: null, settlement: {
        identity: { mutationKey: 'activity', admissionOrder: 1 }, desiredValue: { state: 'idle', activeCount: 0 }, result: 'applied',
        committedProjection: { state: 'idle', activeCount: 0, observedAt: 1, revision: 1 }, committedRevision: 1,
      } }),
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    let admissionReads = 0;
    const scheduler = createSessionIdleCompactionScheduler({ mode: 'host',
      preference: { enabled: true, minContextTokens: 200_000, cacheWindowOverrideMs: 10_000 },
      signal: new AbortController().signal,
      compact: (request, options) => runtime.compact!(request, options),
      readLiveWork: () => { admissionReads++; return consumer.readLiveWork(); },
    });
    const events: AgentSessionRuntimeEvent[] = [];
    const persisted: unknown[] = [];
    const session: RuntimeTranscriptProjectionSession = { sessionId: 'happy-composed',
      enqueueAgentMessageCommitted: async (_provider, body) => {
        if (body.type !== 'event') throw new Error('Expected a compaction event envelope');
        expect(agentEventAttentionImpact(body.data)).toEqual({ affectsUnread: false, affectsMeaningfulActivity: false });
        persisted.push(body);
        return { persisted: true, delivered: true };
      } };
    const writes: Promise<unknown>[] = [];
    const subscription = runtime.watch(event => {
      AgentSessionRuntimeEventSchema.parse(event);
      events.push(event);
      if (event.kind === 'runtime-activity-snapshot') activity = event.state;
      if (event.kind === 'usage-observed') scheduler.observeUsage(event);
      if (event.kind === 'context-compaction') writes.push(projectRuntimeTranscriptEvent({ session, provider: 'claude', event }));
    });
    try {
      operations.beginProviderTurn('foreground-1');
      await operations.sendProviderTurnPrompt('Hello');
      await exec.emit({ type: 'stream_event', session_id: 'native-composed', event: {
        type: 'message_start', message: { id: 'inference-1' } } });
      await exec.emit({ type: 'assistant', uuid: 'assistant-1', session_id: 'native-composed', message: {
        id: 'inference-1', role: 'assistant', content: [], usage: { input_tokens: 10_000, output_tokens: 2,
          cache_creation_input_tokens: 210_000, cache_creation: { ephemeral_1h_input_tokens: 210_000 } } } });
      await vi.waitFor(() => expect(events.some(event => event.kind === 'usage-observed' && event.promptCache)).toBe(true));
      expect(admissionReads).toBe(0);
      expect(exec.processes).toHaveLength(1);
      await exec.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-composed',
        usage: { iterations: [{ type: 'message', input_tokens: 10_000, output_tokens: 2, cache_creation_input_tokens: 210_000 }] },
        modelUsage: { fixture: { inputTokens: 10_000, outputTokens: 2, cacheCreationInputTokens: 210_000, cacheReadInputTokens: 0 } } });
      await operations.waitForProviderTurnCompletion({ timeoutMs: null });
      const beforeCompact = events.length;
      await vi.advanceTimersByTimeAsync(9_000);
      await vi.waitFor(() => expect(exec.processes).toHaveLength(2));
      expect(admissionReads).toBe(1);
      await exec.processes[1]!.emit({ type: 'system', subtype: 'compact_boundary', session_id: 'native-composed',
        compact_metadata: { trigger: 'manual', pre_tokens: 220_002, post_tokens: 3_000 } });
      await exec.processes[1]!.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-composed' });
      await vi.waitFor(() => expect(events.some(event => event.kind === 'context-compaction' && event.phase === 'completed')).toBe(true));
      await Promise.all(writes);
      expect(persisted.length).toBeGreaterThan(0);
      expect(events.slice(beforeCompact).every(event => event.kind === 'context-compaction' || event.kind === 'runtime-activity-snapshot')).toBe(true);
      expect(events.filter(event => event.kind === 'context-compaction')).toMatchObject([
        { phase: 'started', trigger: 'idle' }, { phase: 'completed', trigger: 'idle', tokenCountSource: 'providerReported', tokenCountBefore: 220_002, tokenCountAfter: 3_000 },
      ]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(exec.processes).toHaveLength(2);
      operations.beginProviderTurn('foreground-2');
      await expect(operations.sendProviderTurnPrompt('Continue')).resolves.toEqual({ kind: 'accepted' });
      expect(exec.processes).toHaveLength(3);
    } finally { scheduler.dispose(); subscription.dispose(); await runtime.dispose(); vi.useRealTimers(); }
  });
});
