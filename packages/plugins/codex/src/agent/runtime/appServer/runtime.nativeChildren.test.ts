import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeEvent, AgentSessionSubagentObservation, AgentSessionSubagentObservationPublisher } from '@happier-dev/plugin-sdk/agents/runtime';
import type { DisposableCodexAppServerClient } from './client.js';
import type { CodexAppServerEvent } from './core.js';
import { createCodexNativeAppServerSessionRuntime } from './native.js';
import { createCodexAppServerRuntime, startCodexAppServerRuntime, waitForCodexAppServerRuntimeTurnCompletion } from './runtime.js';

// Codex 0.160.0's generated v2 schema: thread provenance and turn status/error.
// Only the provider JSON-RPC transport and host publication boundary are replaced.
function fixture() {
  const handlers = new Map<string, (params: unknown) => void | Promise<void>>();
  const observations: AgentSessionSubagentObservation[] = [];
  const events: CodexAppServerEvent[] = [];
  const nativeEvents: AgentSessionRuntimeEvent[] = [];
  const client: DisposableCodexAppServerClient = {
    launchFeatures: { realtimeConversationAdvertised: false },
    async request(method) {
      if (method === 'thread/start') return { thread: { id: 'parent' } };
      if (method === 'turn/start') return { turn: { id: 'parent-turn' } };
      return {};
    },
    notify: async () => {},
    registerNotificationHandler(method, handler) { handlers.set(method, handler); return () => handlers.delete(method); },
    registerRequestHandler: () => () => {}, onExit: () => () => {}, dispose: async () => {},
  };
  const subagents = { observe: vi.fn(async (input: AgentSessionSubagentObservation) => {
    observations.push(input);
    return { id: input.observationId, parentSessionId: 'session', status: input.status, updatedAtMs: 1 };
  }) } satisfies AgentSessionSubagentObservationPublisher;
  const runtime = createCodexAppServerRuntime({
    happierSessionId: 'session', directory: '/workspace',
    processEnv: { HAPPIER_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS: '0' },
    host: { baseProcessEnv: {}, logger: { debug: vi.fn(), warn: vi.fn() }, createClient: async () => client, subagents },
  });
  runtime.events.subscribe((event) => events.push(event));
  createCodexNativeAppServerSessionRuntime(runtime, 'session').watch((event) => nativeEvents.push(event));
  return { runtime, events, nativeEvents, observations, async notify(method: string, params: unknown) { await handlers.get(method)?.(params); } };
}

describe('managed Codex native children', () => {
  it('admits another native turn on the same retained child without replaying terminal progress', async () => {
    const f = fixture();
    try {
      await startCodexAppServerRuntime(f.runtime);
      await f.runtime.send({ text: 'Delegate' }, { turnId: 'host-turn' });
      await f.notify('item/completed', { threadId: 'parent', turnId: 'parent-turn', item: {
        id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', senderThreadId: 'parent', receiverThreadIds: ['child'], agentsStates: {}, status: 'completed',
      } });
      await f.notify('turn/started', { threadId: 'child', turn: { id: 'first' } });
      await f.notify('turn/completed', { threadId: 'child', turn: { id: 'first', status: 'completed' } });
      await f.notify('item/agentMessage/delta', { threadId: 'child', turnId: 'first', itemId: 'stale', delta: 'Stale' });
      expect(f.events.filter((event) => event.kind === 'turn-complete')).toHaveLength(0);
      await f.notify('turn/started', { threadId: 'child', turn: { id: 'resumed' } });
      await f.notify('item/completed', { threadId: 'child', turnId: 'resumed', item: { id: 'result', type: 'agentMessage', text: 'New result' } });
      await f.notify('turn/completed', { threadId: 'child', turn: { id: 'resumed', status: 'completed' } });
      expect(f.observations.map((input) => input.status)).toEqual(['running', 'completed', 'running', 'completed']);
      expect(f.observations[0]?.observationId).not.toEqual(f.observations[2]?.observationId);
      expect(f.events.some((event) => event.kind === 'message-delta' && JSON.stringify(event.delta).includes('Stale'))).toBe(false);
      expect(f.events.filter((event) => event.kind === 'turn-start')).toHaveLength(1);
      const roots = f.nativeEvents.filter((event) => event.kind === 'tool-call' && event.toolName === 'SubAgent');
      expect(roots).toHaveLength(2);
      expect(roots).toEqual(expect.arrayContaining([
        expect.objectContaining({ toolCallId: JSON.stringify(['child', 'first']), input: expect.objectContaining({ sidechainId: 'child' }) }),
        expect.objectContaining({ toolCallId: JSON.stringify(['child', 'resumed']), input: expect.objectContaining({ sidechainId: 'child' }) }),
      ]));
    } finally { await f.runtime.dispose(); }
  });

  it.each(['completed', 'failed', 'interrupted'] as const)('keeps late child %s output and lifecycle separate from the primary', async (status) => {
    const f = fixture();
    try {
      await startCodexAppServerRuntime(f.runtime);
      await f.runtime.send({ text: 'Delegate' }, { turnId: 'host-turn' });
      await f.notify('thread/started', { thread: { id: 'unrelated', parentThreadId: 'other-parent' } });
      await f.notify('turn/started', { threadId: 'unrelated', turn: { id: 'foreign-turn' } });
      await f.notify('thread/started', { thread: { id: 'child', parentThreadId: 'parent', source: { subAgent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } } } });
      await f.notify('turn/started', { threadId: 'child' });
      await f.notify('item/agentMessage/delta', { threadId: 'child', itemId: 'idless', delta: 'Uncorrelated' });
      expect(f.observations).toHaveLength(0);
      await f.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
      await f.notify('item/agentMessage/delta', { threadId: 'child', turnId: 'child-turn', itemId: 'message', delta: 'Child ' });
      await f.notify('item/started', { threadId: 'child', turnId: 'child-turn', item: { id: 'cmd', type: 'commandExecution', command: 'pwd', cwd: '/child' } });
      expect(f.observations).toEqual([expect.objectContaining({ status: 'running', detail: expect.objectContaining({ vendorRef: { agentSessionId: 'child', vendorSource: 'codex' }, transcript: { sidechainId: 'child' } }) })]);
      expect(f.events.filter((event) => event.kind === 'turn-complete')).toHaveLength(0);
      await f.notify('turn/completed', { threadId: 'parent', turn: { id: 'parent-turn', status: 'completed' } });
      await waitForCodexAppServerRuntimeTurnCompletion(f.runtime);
      await f.notify('item/agentMessage/delta', { threadId: 'child', turnId: 'child-turn', itemId: 'late-message', delta: 'Late child ' });
      await f.notify('item/completed', { threadId: 'child', turnId: 'child-turn', item: { id: 'late-message', type: 'agentMessage', text: 'Late child final' } });
      await f.notify('item/completed', { threadId: 'child', turnId: 'child-turn', item: { id: 'cmd', type: 'commandExecution', stdout: '/child', exitCode: 0 } });
      await f.notify('item/completed', { threadId: 'child', turnId: 'child-turn', item: { id: 'message', type: 'agentMessage', text: 'Child final' } });
      const terminal = { threadId: 'child', turn: { id: 'child-turn', status, error: status === 'failed' ? { message: 'Child failed', additionalDetails: 'failure detail' } : null } };
      await f.notify('turn/completed', terminal);
      await f.notify('turn/completed', terminal);
      expect(f.observations).toHaveLength(2);
      expect(f.observations.at(-1)).toEqual(expect.objectContaining({ status: status === 'interrupted' ? 'aborted' : status,
        ...(status === 'failed' ? { detail: expect.objectContaining({ error: expect.any(String) }) } : {}),
      }));
      expect(f.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'tool-call', toolCallId: 'cmd', sidechainId: 'child' }),
        expect.objectContaining({ kind: 'tool-result', toolCallId: 'cmd', sidechainId: 'child' }),
        expect.objectContaining({ kind: 'transcript-agent-message-committed', sidechainId: 'child', body: { type: 'message', message: 'Child final' } }),
      ]));
      expect(f.nativeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'message-delta', sidechainId: 'child', text: 'Child ' }),
        expect.objectContaining({ kind: 'tool-call', sidechainId: 'child', toolCallId: 'cmd' }),
        expect.objectContaining({ kind: 'tool-result', sidechainId: 'child', toolCallId: 'cmd' }),
        expect.objectContaining({ kind: 'transcript-message-committed', sidechainId: 'child', text: 'Child final' }),
      ]));
      const childDeltas = f.nativeEvents.filter((event) => event.kind === 'message-delta').filter((event) => event.sidechainId === 'child');
      const childMessages = f.nativeEvents.filter((event) => event.kind === 'transcript-message-committed').filter((event) => event.sidechainId === 'child');
      expect(new Set(childDeltas.map((event) => event.messageId)).size).toBe(2);
      expect(childMessages).toHaveLength(2);
      for (const committed of childMessages) {
        const deltas = childDeltas.filter((event) => event.messageId === committed.messageId);
        expect(deltas.length).toBeGreaterThan(0);
        expect(deltas.map((event) => event.text).join('')).toBe(committed.text);
      }
      expect(f.events.filter((event) => event.kind === 'turn-start')).toHaveLength(1);
      expect(f.events.filter((event) => event.kind === 'turn-complete')).toHaveLength(1);
      const roots = f.nativeEvents.filter((event) => event.kind === 'tool-call' && event.toolName === 'SubAgent');
      expect(roots).toEqual([expect.objectContaining({
        toolCallId: JSON.stringify(['child', 'child-turn']),
        input: { sidechainId: 'child', threadId: 'child', providerTurnId: 'child-turn', parentThreadId: 'parent' },
      })]);
      expect(roots[0]).not.toHaveProperty('sidechainId');
      expect(roots[0]).not.toHaveProperty('turnId');
      const results = f.nativeEvents.filter((event) => event.kind === 'tool-result' && event.toolCallId === JSON.stringify(['child', 'child-turn']));
      expect(results).toEqual([expect.objectContaining({
        output: expect.objectContaining({ sidechainId: 'child', threadId: 'child', providerTurnId: 'child-turn', status }),
        ...(status === 'failed' ? { isError: true } : {}),
      })]);
      expect(results[0]).not.toHaveProperty('sidechainId');
      expect(results[0]).not.toHaveProperty('turnId');
      for (const event of [...f.events, ...f.nativeEvents].filter((event) => 'sidechainId' in event && event.sidechainId === 'child')) {
        expect(event).not.toHaveProperty('turnId');
      }
      if (status !== 'failed') expect(results[0]).not.toHaveProperty('isError');
    } finally { await f.runtime.dispose(); }
  });
});
