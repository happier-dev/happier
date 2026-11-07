import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentSessionRuntimeEvent } from '@happier-dev/protocol/runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';

import { createEventsFixture, createPluginContextFixture, createTerminalHostFixture } from '../../engine.testkit.js';
import { createClaudeNativeSessionRuntimeFromOperations } from '../../nativeRuntime.js';
import { createClaudeUnifiedTerminalTurnOperations } from './turnOperations.js';

async function createFixture() {
  const terminal = createTerminalHostFixture();
  let exit: Parameters<NonNullable<typeof terminal.service.subscribeExit>>[1] | undefined;
  terminal.service.subscribeExit = vi.fn(async (_handle, listener) => {
    exit = listener;
    return { dispose() {} };
  });
  const ctx = createPluginContextFixture(terminal.service, createEventsFixture().service);
  // Native transcript files and terminal process are the external boundaries.
  vi.mocked(ctx.agentRuntime.transcripts.fileFollow.follow).mockResolvedValue({
    id: 'terminal-settlement-follow', drainNow: async () => {}, close: async () => {},
  });
  const operations = createClaudeUnifiedTerminalTurnOperations({
    ctx, directory: '/tmp/claude-project', happierSessionId: 'terminal-settlement',
    hostPreference: 'zellij', launchEnv: {}, permissionMode: 'default',
  });
  const session = createClaudeNativeSessionRuntimeFromOperations(operations, {
    kind: 'create', sessionId: 'terminal-settlement', cwd: '/tmp/claude-project',
  }, { session: { services: {
    activeInput: { bind: () => ({ dispose() {} }) }, models: { bind: () => ({ dispose() {} }) },
  } } } as unknown as AgentSessionRuntimeContext);
  const events: AgentSessionRuntimeEvent[] = [];
  session.watch(event => events.push(event));
  await operations.startProviderSession();
  const hook = vi.mocked(ctx.agentRuntime.sessionHooks.startServer).mock.calls[0]?.[0].onSessionHook;
  if (!hook || !session.observeSourceTranscript) throw new Error('Native hooks/transcript were not bound');
  await hook('claude-native', { hook_event_name: 'SessionStart', session_id: 'claude-native',
    transcript_path: '/tmp/claude-native.jsonl', source: 'startup' });
  let sequence = 0;
  const row = async (value: Record<string, JsonValue>) => {
    const nativeRow = { ...value, sessionId: 'claude-native' };
    const follow = vi.mocked(ctx.agentRuntime.transcripts.fileFollow.follow).mock.calls[0]?.[0];
    if (!follow) throw new Error('Native file follower was not bound');
    await follow.onLine({ line: JSON.stringify(nativeRow), sourcePath: '/tmp/claude-native.jsonl', sequence: ++sequence });
    await session.observeSourceTranscript!({ providerSessionId: 'claude-native',
      sourceId: `source:${value.uuid}`, row: nativeRow });
  };
  const user = () => row({ type: 'user', uuid: 'native-user',
    message: { role: 'user', content: 'explain the change' } });
  const send = () => session.send({ inputIds: ['input-1'], input: { text: 'explain the change' },
    delivery: { kind: 'newTurn', turnId: 'host-turn' } });
  return { terminal, session, operations, events, hook, row, user, send, exit: () => exit };
}

describe('Claude terminal native settlement', () => {
  it('keeps Stop → SessionEnd → ordered answer completed without inventing a process failure', async () => {
    const f = await createFixture();
    try {
      await f.send();
      await f.user();
      await f.hook('claude-native', { hook_event_name: 'Stop', session_id: 'claude-native', last_assistant_message: 'The answer' });
      await f.hook('claude-native', { hook_event_name: 'SessionEnd', session_id: 'claude-native', reason: 'prompt_input_exit' });
      await f.row({ type: 'assistant', uuid: 'native-answer', message: { role: 'assistant',
        content: [{ type: 'text', text: 'The answer' }], stop_reason: 'end_turn' } });
      expect(f.events.filter(event => event.kind === 'turn-failed')).toEqual([]);
      expect(f.events.filter(event => event.kind === 'turn-complete')).toEqual([
        expect.objectContaining({ turnId: 'host-turn' }),
      ]);
      expect(f.events.findIndex(event => event.kind === 'transcript-message-committed'))
        .toBeLessThan(f.events.findIndex(event => event.kind === 'turn-complete'));
    } finally { await f.session.dispose(); }
  });

  it('preserves the real process exit after SessionEnd while a turn has no completion evidence', async () => {
    const f = await createFixture();
    try {
      await f.send();
      await f.user();
      await f.hook('claude-native', { hook_event_name: 'SessionEnd', session_id: 'claude-native' });
      f.exit()?.({ code: 137, signal: 'SIGKILL', nativeExited: true });
      await vi.waitFor(() => expect(f.events.filter(event => event.kind === 'turn-failed')).toHaveLength(1));
      expect(f.events.find(event => event.kind === 'turn-failed')).toMatchObject({
        turnId: 'host-turn', diagnostic: { code: 'claude.process_exited', message: expect.stringContaining('code 137 signal SIGKILL') },
      });
    } finally { await f.session.dispose(); }
  });

  it.each([
    { timing: 'after injection', kind: 'structured 429' },
    { timing: 'during injection', kind: 'structured 429' },
    { timing: 'after injection', kind: 'RUN89 weekly limit' },
    { timing: 'during injection', kind: 'RUN89 weekly limit' },
  ] as const)('settles a native $kind with acceptance and a typed usage failure $timing', async ({ timing, kind }) => {
    const f = await createFixture();
    const fail = async () => {
      await f.user();
      await f.row(kind === 'RUN89 weekly limit' ? {
        type: 'assistant', uuid: 'native-api-error', isApiErrorMessage: true, isSidechain: false, error: 'rate_limit',
        message: { role: 'assistant', stop_reason: 'stop_sequence',
          content: [{ type: 'text', text: "You've hit your weekly limit · resets Nov 9, 4pm (Europe/Amsterdam)" }] },
      } : { type: 'assistant', uuid: 'native-api-error', isApiErrorMessage: true,
        apiError: 'long_context_credits_required', apiErrorStatus: 429, error: 'rate_limit',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Usage credits are required for long context requests.' }] } });
    };
    if (timing === 'during injection') {
      vi.mocked(f.terminal.service.injectUserPrompt).mockImplementationOnce(async (_handle, input) => {
        await fail();
        return { status: 'injected', injectedAt: 123, bytesWritten: input.text.length,
          hostKind: f.terminal.handle.kind, hostSessionName: f.terminal.handle.sessionName };
      });
    }
    try {
      await expect(f.send()).resolves.toEqual({ status: 'admitted' });
      if (timing === 'after injection') await fail();
      expect(f.events.filter(event => ['input-accepted', 'turn-start', 'turn-failed'].includes(event.kind)))
        .toEqual([
          expect.objectContaining({ kind: 'input-accepted', inputIds: ['input-1'] }),
          expect.objectContaining({ kind: 'turn-start', turnId: 'host-turn' }),
          expect.objectContaining({ kind: 'turn-failed', turnId: 'host-turn', diagnostic: {
            code: 'claude.usage_limit', severity: 'error', message: expect.any(String),
            details: expect.objectContaining({ source: 'usage_limit', usageLimit: expect.objectContaining({
              limitCategory: kind === 'RUN89 weekly limit' ? 'usage_limit' : 'rate_limit',
            }) }),
          } }),
        ]);
      expect(f.events.filter(event => event.kind === 'input-custody-unknown')).toEqual([]);
      expect(f.events.filter(event => event.kind === 'turn-complete')).toEqual([]);
      expect(f.terminal.service.injectUserPrompt).toHaveBeenCalledTimes(1);
    } finally { await f.session.dispose(); }
  });
});
