import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { createEventsFixture, createPluginContextFixture, createSdkExecFixture, createTerminalHostFixture } from '../../engine.testkit.js';
import { createClaudeNativeSessionRuntimeFromOperations } from '../../nativeRuntime.js';
import { createClaudeAgentSdkTurnOperations } from './session.js';

describe('Claude SDK live prompt cache evidence', () => {
  it('matches main-chain message-start clocks, replaces tool-loop evidence and excludes replay, sidechains, mismatches and aggregates', async () => {
    let clock = 100;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, { exec: exec.service });
    const operations = createClaudeAgentSdkTurnOperations({ ctx, directory: '/tmp/claude-cache', launchEnv: {},
      permissionMode: 'default', happierSessionId: 'happy-cache', initialProviderSessionId: 'native-cache', publishSdkMessages: true });
    // Host service registration is the external boundary; usage production and the native facade stay real.
    const context = { session: { services: { activeInput: { bind: () => ({ dispose() {} }) },
      models: { bind: () => ({ dispose() {} }) } } } } as unknown as AgentSessionRuntimeContext;
    const runtime = createClaudeNativeSessionRuntimeFromOperations(operations,
      { kind: 'create', sessionId: 'happy-cache', cwd: '/tmp/claude-cache' }, context);
    const usage: Extract<AgentSessionRuntimeEvent, { kind: 'usage-observed' }>[] = [];
    const subscription = runtime.watch(event => {
      AgentSessionRuntimeEventSchema.parse(event);
      if (event.kind === 'usage-observed') usage.push(event);
    });
    const start = (id: string, extra = {}) => exec.emit({ type: 'stream_event', session_id: 'native-cache',
      event: { type: 'message_start', message: { id } }, ...extra });
    const assistant = (id: string, long = true, extra = {}) => exec.emit({ type: 'assistant', uuid: `row-${usage.length}`,
      session_id: 'native-cache', message: { id, role: 'assistant', content: [], model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 30,
          cache_creation: { ephemeral_1h_input_tokens: long ? 20 : 0, ephemeral_5m_input_tokens: long ? 10 : 30 } } }, ...extra });
    try {
      operations.beginProviderTurn('turn-cache');
      await operations.sendProviderTurnPrompt('Hello');
      await assistant('no-start');
      await start('request-1');
      clock = 900;
      await assistant('request-1');
      clock = 1_000;
      await start('request-2');
      await start('ignored-replay', { isReplay: true });
      await start('ignored-child', { parent_tool_use_id: 'child-tool' });
      await assistant('request-1');
      await assistant('request-2', true, { isReplay: true });
      await assistant('request-2', true, { parent_tool_use_id: 'child-tool' });
      await assistant('request-2', true, { session_id: 'different-native-session' });
      clock = 1_900;
      await assistant('request-2', false);
      await vi.waitFor(() => expect(usage).toHaveLength(7));
      expect(usage.map(event => event.promptCache)).toEqual([
        undefined, { lastUseAtMs: 100, ttlMs: 3_600_000 }, undefined, undefined,
        undefined, undefined, { lastUseAtMs: 1_000 },
      ]);
      expect(usage[1]?.tokens.cacheWrite).toBe(30);
      await exec.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-cache',
        usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 30 },
        modelUsage: { 'claude-sonnet-4-6': { inputTokens: 10, outputTokens: 2,
          cacheReadInputTokens: 0, cacheCreationInputTokens: 30 } } });
      await vi.waitFor(() => expect(usage.some(event => event.scope === 'session_final')).toBe(true));
      expect(usage.filter(event => event.scope === 'session_final').every(event => event.promptCache === undefined)).toBe(true);
    } finally { subscription.dispose(); await runtime.dispose(); now.mockRestore(); }
  });
});
