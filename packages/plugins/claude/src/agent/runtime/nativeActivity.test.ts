import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeEvent } from '@happier-dev/protocol/runtime';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import {
  createEventsFixture,
  createPluginContextFixture,
  createSdkExecFixture,
  createTerminalHostFixture,
} from './engine.testkit.js';
import { createClaudeNativeSessionRuntimeFromOperations } from './nativeRuntime.js';
import { createClaudeAgentSdkTurnOperations } from './remote/sdk/session.js';

// Host services are the plugin's external boundary; the native runtime and event adapter stay real.
const runtimeContext = () => ({ session: { services: {
  activeInput: { bind: () => ({ dispose() {} }) }, models: { bind: () => ({ dispose() {} }) },
} } }) as unknown as AgentSessionRuntimeContext;

describe('Claude native turn admission', () => {
  it('keeps the current turn while a steer awaits its native echo', async () => {
    const exec = createSdkExecFixture({ providerExitOwnership: 'direct', acknowledgePrompts: false });
    const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, { exec: exec.service });
    const operations = createClaudeAgentSdkTurnOperations({ ctx, directory: '/tmp/claude-project', launchEnv: {},
      happierSessionId: 'sdk-native-admission', permissionMode: 'default' });
    const runtime = createClaudeNativeSessionRuntimeFromOperations(operations,
      { kind: 'create', sessionId: 'sdk-native-admission', cwd: '/tmp/claude-project' }, runtimeContext());
    const events: AgentSessionRuntimeEvent[] = [];
    const subscription = runtime.watch(event => events.push(event));
    const latestPrompt = () => exec.written.filter((record): record is Record<string, unknown> =>
      typeof record === 'object' && record !== null && Reflect.get(record, 'type') === 'user').at(-1)!;
    try {
      const initial = runtime.send({ inputIds: ['initial'], input: { text: 'Initial work' }, delivery: { kind: 'newTurn', turnId: 'admitted-turn' } });
      await vi.waitFor(() => expect(latestPrompt()).toBeDefined());
      await exec.emit({ type: 'system', subtype: 'init', session_id: 'native-admitted' });
      expect(events.some(event => event.kind === 'turn-start')).toBe(false);
      await exec.emit({ ...latestPrompt(), session_id: 'native-admitted', isReplay: true });
      await expect(initial).resolves.toEqual({ status: 'admitted' });
      expect(events).toContainEqual(expect.objectContaining({ kind: 'turn-start', turnId: 'admitted-turn' }));
      const steer = runtime.send({ inputIds: ['steer'], input: { text: 'Steer work' }, delivery: { kind: 'steer', turnId: 'admitted-turn' } });
      await vi.waitFor(() => expect(exec.written.filter(record => typeof record === 'object' && record !== null && Reflect.get(record, 'type') === 'user')).toHaveLength(2));
      let settled = false;
      void steer.then(() => { settled = true; });
      await exec.emit({ type: 'stream_event', session_id: 'native-admitted', parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"still":"working' } } });
      expect(settled).toBe(false);
      await exec.emit({ ...latestPrompt(), session_id: 'native-admitted', isReplay: true });
      await expect(steer).resolves.toEqual({ status: 'admitted' });
      await exec.emit({ type: 'result', subtype: 'success', session_id: 'native-admitted', result: 'Done' });
      await operations.waitForProviderTurnCompletion();
    } finally {
      subscription.dispose();
      await runtime.dispose();
    }
  });


  it('keeps receipt-time identity establishment ahead of queued SDK projection without rewinding it', async () => {
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, { exec: exec.service });
    const operations = createClaudeAgentSdkTurnOperations({ ctx, directory: '/tmp/claude-project', launchEnv: {},
      happierSessionId: 'native-sdk-rekey', permissionMode: 'default' });
    const runtime = createClaudeNativeSessionRuntimeFromOperations(operations,
      { kind: 'create', sessionId: 'native-sdk-rekey', cwd: '/tmp/claude-project' }, runtimeContext());
    const events: AgentSessionRuntimeEvent[] = [];
    const subscription = runtime.watch(event => events.push(event));
    try {
      operations.beginProviderTurn('rekey-turn');
      await operations.sendProviderTurnPrompt('Work');
      // The OS boundary delivers a stdout burst before the async iterator can project its first row.
      const burst = [
        exec.emit({ type: 'system', subtype: 'init', session_id: 'before-compact' }),
        exec.emit({ type: 'system', subtype: 'compact_boundary', session_id: 'after-compact' }),
        exec.emit({ type: 'rate_limit_event', session_id: 'after-compact', rate_limit_info: { status: 'allowed' } }),
      ];
      await Promise.all(burst);
      await exec.emit({ type: 'result', subtype: 'success', session_id: 'after-compact', result: 'Done' });
      await operations.waitForProviderTurnCompletion();
      const identities = events.filter(event => event.kind === 'provider-session-id').map(event => event.providerSessionId);
      expect(identities).toEqual(['before-compact', 'after-compact', 'after-compact']);
    } finally {
      subscription.dispose();
      await runtime.dispose();
    }
  });

});
