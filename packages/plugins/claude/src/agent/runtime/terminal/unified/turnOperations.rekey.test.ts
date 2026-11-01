import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

import { createEventsFixture, createPluginContextFixture, createTerminalHostFixture } from '../../engine.testkit.js';
import { createClaudeNativeSessionRuntimeFromOperations } from '../../nativeRuntime.js';
import { createClaudeUnifiedTerminalTurnOperations } from './turnOperations.js';

describe('Claude native rekey lifecycle', () => {
  it('keeps the host alive across clear and accepts the next turn under the new native identity', async () => {
    const terminal = createTerminalHostFixture();
    const ctx = createPluginContextFixture(terminal.service, createEventsFixture().service);
    // Native transcript files and terminal processes are the external boundaries.
    vi.mocked(ctx.agentRuntime.transcripts.fileFollow.follow).mockResolvedValue({
      id: 'rekey-follow', drainNow: async () => {}, close: async () => {},
    });
    const operations = createClaudeUnifiedTerminalTurnOperations({
      ctx, directory: '/tmp/claude-project', happierSessionId: 'rekey-session',
      hostPreference: 'zellij', launchEnv: {}, permissionMode: 'default',
    });
    const session = createClaudeNativeSessionRuntimeFromOperations(operations, {
      kind: 'create', sessionId: 'rekey-session', cwd: '/tmp/claude-project',
    }, { session: { services: {
      activeInput: { bind: () => ({ dispose() {} }) }, models: { bind: () => ({ dispose() {} }) },
    } } } as unknown as AgentSessionRuntimeContext);
    const events: AgentSessionRuntimeEvent[] = [];
    session.watch(event => events.push(event));
    try {
      await operations.startProviderSession();
      const hook = vi.mocked(ctx.agentRuntime.sessionHooks.startServer).mock.calls[0]?.[0].onSessionHook;
      if (!hook || !session.observeSourceTranscript) throw new Error('Native hooks/transcript were not bound');
      await hook('native-a', { hook_event_name: 'SessionStart', session_id: 'native-a',
        transcript_path: '/tmp/native-a.jsonl', source: 'startup' });
      await hook('native-a', { hook_event_name: 'SessionEnd', session_id: 'native-a', reason: 'clear' });
      await hook('native-b', { hook_event_name: 'SessionStart', session_id: 'native-b',
        transcript_path: '/tmp/native-b.jsonl', source: 'clear' });
      expect(events.filter(event => event.kind === 'turn-failed')).toEqual([]);

      await expect(session.send({ inputIds: ['after-clear'], input: { text: 'Reply B' },
        delivery: { kind: 'newTurn', turnId: 'after-clear-turn' } })).resolves.toEqual({ status: 'admitted' });
      await hook('native-b', { hook_event_name: 'UserPromptSubmit', session_id: 'native-b', prompt: 'Reply B' });
      await session.observeSourceTranscript({ providerSessionId: 'native-b', sourceId: 'native-b-answer', row: {
        type: 'assistant', uuid: 'native-b-answer', sessionId: 'native-b', session_id: 'native-a',
        message: { role: 'assistant', content: [{ type: 'text', text: 'B' }], stop_reason: 'end_turn' },
      } });
      await hook('native-b', { hook_event_name: 'Stop', session_id: 'native-b' });
      expect(events.filter(event => event.kind === 'turn-failed')).toEqual([]);
      expect(events.filter(event => event.kind === 'turn-complete')).toEqual([
        expect.objectContaining({ turnId: 'after-clear-turn' }),
      ]);
    } finally {
      await session.dispose();
    }
  });
});
