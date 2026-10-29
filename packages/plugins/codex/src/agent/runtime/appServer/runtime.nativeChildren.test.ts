import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeEvent, AgentSessionSubagentObservation, AgentSessionSubagentObservationPublisher } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import type { DisposableCodexAppServerClient } from './client.js';
import { createCodexNativeEventFixture } from './client.test-support.js';
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
  const nativeReceipts = createCodexNativeEventFixture();
  const client: DisposableCodexAppServerClient = {
    onNativeEvent: nativeReceipts.onNativeEvent,
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
  createCodexNativeAppServerSessionRuntime(runtime, 'session').watch((event) => nativeEvents.push(AgentSessionRuntimeEventSchema.parse(event)));
  return { runtime, events, nativeEvents, observations, async notify(method: string, params: unknown) { nativeReceipts.publish(method, params); await handlers.get(method)?.(params); } };
}

describe('managed Codex native children', () => {
  it.each([
    { child: false, failureFirst: true },
    { child: false, failureFirst: false },
    { child: true, failureFirst: true },
    { child: true, failureFirst: false },
    { child: false, failureFirst: false, yielded: true },
    { child: true, failureFirst: false, yielded: true },
    { child: false, failureFirst: false, yielded: true, nativeBeforeYield: true },
    { child: true, failureFirst: false, yielded: true, nativeBeforeYield: true },
  ])('retains an independent script failure (child=$child, failureFirst=$failureFirst, yielded=$yielded, nativeBeforeYield=$nativeBeforeYield)', async ({ child, failureFirst, yielded, nativeBeforeYield }) => {
    const f = fixture();
    try {
      await startCodexAppServerRuntime(f.runtime);
      await f.runtime.send({ text: 'Execute two scripts' }, { turnId: 'host-turn' });
      if (child) {
        await f.notify('thread/started', { thread: { id: 'child', parentThreadId: 'parent' } });
        await f.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
      }
      const scope = { threadId: child ? 'child' : 'parent', turnId: child ? 'child-turn' : 'parent-turn' };
      const notify = (item: unknown, method = 'rawResponseItem/completed') => f.notify(method, { ...scope, item });
      const failedScript = async () => {
        await notify({ type: 'custom_tool_call', call_id: 'failed-script', name: 'exec', input: 'throw new Error("failed before dispatch")' });
        await notify({ type: 'custom_tool_call_output', call_id: 'failed-script', output: 'Script failed before a native command existed' });
      };
      const nativeScript = async () => {
        await notify({ type: 'custom_tool_call', call_id: 'successful-script', name: 'exec', input: 'await tools.exec_command({cmd:"pwd"});' });
        if (nativeBeforeYield) {
          await notify({ type: 'function_call', call_id: 'native-command', name: 'exec_command', arguments: '{"cmd":"pwd"}' });
        }
        if (yielded) {
          // rust-v0.162.1 execute_handler.rs keeps a yielded cell running;
          // delegate.rs dispatches its native tool independently of the next exec.
          await notify({ type: 'custom_tool_call_output', call_id: 'successful-script', output: [
            { type: 'input_text', text: 'Script running with cell ID 1\nWall time 0.1 seconds\nOutput:\n' },
          ] });
          await notify({ type: 'custom_tool_call', call_id: 'failed-script', name: 'exec', input: 'throw new Error("failed before dispatch")' });
        }
        await notify({ type: 'function_call', call_id: 'native-command', name: 'exec_command', arguments: '{"cmd":"pwd"}' });
        await notify({ type: 'commandExecution', id: 'native-command', command: 'pwd' }, 'item/started');
        await notify({ type: 'function_call_output', call_id: 'native-command', output: '{"exit_code":0,"output":"/workspace"}' });
        await notify({ type: 'commandExecution', id: 'native-command', command: 'pwd', exitCode: 0 }, 'item/completed');
        if (yielded) {
          await notify({ type: 'custom_tool_call_output', call_id: 'failed-script', output: 'Script failed before a native command existed' });
        } else {
          await notify({ type: 'custom_tool_call_output', call_id: 'successful-script', output: 'Script completed' });
        }
      };
      if (yielded) await nativeScript();
      else if (failureFirst) { await failedScript(); await nativeScript(); }
      else { await nativeScript(); await failedScript(); }
      await f.notify('turn/completed', { threadId: scope.threadId, turn: { id: scope.turnId, status: 'completed' } });
      if (!child) await waitForCodexAppServerRuntimeTurnCompletion(f.runtime);
      const tools = f.nativeEvents.filter(event => (event.kind === 'tool-call' || event.kind === 'tool-result')
        && (child ? event.sidechainId === 'child' : !event.sidechainId));
      expect(tools).toEqual([
        expect.objectContaining({ kind: 'tool-call', toolCallId: 'native-command', toolName: 'Bash' }),
        expect.objectContaining({ kind: 'tool-result', toolCallId: 'native-command', output: { exit_code: 0, output: '/workspace' } }),
        // The native stream has no originating exec id. Ambiguous wrappers
        // remain visible rather than losing the independent failure.
        ...(yielded && !nativeBeforeYield ? [
          expect.objectContaining({ kind: 'tool-call', toolCallId: 'successful-script', toolName: 'exec' }),
          expect.objectContaining({ kind: 'tool-result', toolCallId: 'successful-script', output: expect.any(Array) }),
        ] : []),
        expect.objectContaining({ kind: 'tool-call', toolCallId: 'failed-script', toolName: 'exec' }),
        expect.objectContaining({ kind: 'tool-result', toolCallId: 'failed-script', output: 'Script failed before a native command existed' }),
      ]);
    } finally { await f.runtime.dispose(); }
  });
  it('retains raw-only child tools without orphan results or typed/raw duplicates', async () => {
    const f = fixture();
    try {
      await startCodexAppServerRuntime(f.runtime);
      await f.runtime.send({ text: 'Delegate' }, { turnId: 'host-turn' });
      await f.notify('thread/started', { thread: { id: 'child', parentThreadId: 'parent' } });
      await f.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
      const notify = (item: unknown, method = 'rawResponseItem/completed') => f.notify(method, {
        threadId: 'child', turnId: 'child-turn', item,
      });
      await notify({ type: 'function_call_output', call_id: 'hidden', output: 'private internal result' });
      await notify({ type: 'custom_tool_call', call_id: 'code-wrapper', name: 'exec', input: 'await tools.exec_command({cmd:"pwd"});' });
      await notify({ type: 'function_call', call_id: 'call-pwd', name: 'exec_command', arguments: '{"cmd":"pwd"}' });
      await notify({ type: 'function_call_output', call_id: 'call-pwd', output: '{"exit_code":101,"output":"bubblewrap is unavailable"}' });
      await notify({ type: 'commandExecution', id: 'call-pwd', command: 'pwd' }, 'item/started');
      await notify({ type: 'commandExecution', id: 'call-pwd', command: 'pwd', exitCode: 101 }, 'item/completed');
      await notify({ type: 'custom_tool_call_output', call_id: 'code-wrapper', output: 'Script completed' });
      await f.notify('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } });
      const tools = f.nativeEvents.filter((event) => (event.kind === 'tool-call' || event.kind === 'tool-result') && event.sidechainId === 'child');
      expect(tools).toEqual([
        expect.objectContaining({ kind: 'tool-call', toolCallId: 'call-pwd', toolName: 'Bash', input: expect.objectContaining({ cmd: 'pwd' }) }),
        expect.objectContaining({ kind: 'tool-result', toolCallId: 'call-pwd', output: { exit_code: 101, output: 'bubblewrap is unavailable' } }),
      ]);
      expect(tools.every((event) => !('turnId' in event))).toBe(true);
    } finally { await f.runtime.dispose(); }
  });
  it.each([
    { channel: 'assistant', nativeRetry: false },
    { channel: 'reasoning', nativeRetry: false },
    { channel: 'assistant', nativeRetry: true },
  ] as const)('settles a child $channel draft and retains the next message (nativeRetry=$nativeRetry)', async ({ channel, nativeRetry }) => {
    const f = fixture();
    try {
      await startCodexAppServerRuntime(f.runtime);
      await f.runtime.send({ text: 'Delegate' }, { turnId: 'host-turn' });
      await f.notify('thread/started', { thread: { id: 'child', parentThreadId: 'parent' } });
      await f.notify('error', { threadId: 'child', turnId: 'unobserved-turn', willRetry: true, error: { message: 'diagnostic' } });
      expect(f.observations).toEqual([]);
      await f.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
      await f.notify('item/completed', { threadId: 'child', turnId: 'child-turn', item: { id: 'no-output', type: 'agentMessage', text: '' } });
      await f.notify(channel === 'assistant' ? 'item/agentMessage/delta' : 'item/reasoning/textDelta', {
        threadId: 'child', turnId: 'child-turn', itemId: 'removed', delta: 'Removed child draft',
      });
      if (nativeRetry) {
        await f.notify('error', { threadId: 'child', turnId: 'child-turn', willRetry: true, error: { message: 'stream failed' } });
      } else {
        await f.notify('item/completed', { threadId: 'child', turnId: 'child-turn',
          item: { id: 'removed', type: channel === 'assistant' ? 'agentMessage' : 'reasoning', text: '' },
        });
      }
      await f.notify('item/agentMessage/delta', { threadId: 'child', turnId: 'child-turn', itemId: 'retained', delta: 'Retained child answer' });
      await f.notify('item/completed', { threadId: 'child', turnId: 'child-turn', item: { id: 'retained', type: 'agentMessage', text: 'Retained child answer' } });
      await f.notify('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } });
      const childOutput = f.nativeEvents.filter((event) => 'sidechainId' in event && event.sidechainId === 'child');
      const draft = childOutput.find((event) => event.kind === 'message-delta' && event.text === 'Removed child draft');
      if (draft?.kind !== 'message-delta' || !draft.messageId) throw new Error('Missing child draft identity');
      expect(childOutput.filter((event) => event.kind === 'transcript-message-committed')).toMatchObject([
        { role: channel, messageId: draft.messageId, text: '' },
        { role: 'assistant', text: 'Retained child answer' },
      ]);
      expect(childOutput.filter((event) => event.kind === 'message-delta').map((event) => event.text)).toEqual([
        'Removed child draft', 'Retained child answer',
      ]);
      expect(childOutput.every((event) => !('turnId' in event))).toBe(true);
    } finally { await f.runtime.dispose(); }
  });

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
