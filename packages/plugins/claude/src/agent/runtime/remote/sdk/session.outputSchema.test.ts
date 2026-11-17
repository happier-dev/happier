import { describe, expect, it, vi } from 'vitest';
import type { PluginJsonSchemaV2 } from '@happier-dev/plugin-sdk/actions';
import type { AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { createEventsFixture, createPluginContextFixture, createSdkExecFixture, createTerminalHostFixture } from '../../engine.testkit.js';
import { createClaudeNativeSessionRuntimeFromOperations } from '../../nativeRuntime.js';
import { createClaudeAgentSdkTurnOperations } from './session.js';

describe('Claude native structured output', () => {
  it('delivers the schema and final structured result, then clears the launch constraint for plain input', async () => {
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, { exec: exec.service });
    const operations = createClaudeAgentSdkTurnOperations({ ctx, directory: '/tmp/claude-project', launchEnv: {},
      happierSessionId: 'structured-output', permissionMode: 'default', publishTranscriptMessages: true });
    // Host service boundary: this test does not exercise the host's model or input subscription owners.
    const context = { session: { services: {
      activeInput: { bind: () => ({ dispose() {} }) }, models: { bind: () => ({ dispose() {} }) },
    } } } as unknown as AgentSessionRuntimeContext;
    const runtime = createClaudeNativeSessionRuntimeFromOperations(operations,
      { kind: 'create', sessionId: 'structured-output', cwd: '/tmp/claude-project' }, context);
    const events: AgentSessionRuntimeEvent[] = [];
    const subscription = runtime.watch(event => events.push(event));
    const outputSchema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false } satisfies PluginJsonSchemaV2;
    const structured = { verdict: 'approve' };
    try {
      await expect(runtime.send({ inputIds: ['schema-input'], input: { text: 'inspect', outputSchema },
        delivery: { kind: 'newTurn', turnId: 'schema-turn' } })).resolves.toMatchObject({ status: 'admitted' });
      const args: readonly string[] = exec.spawnClient.mock.calls[0]?.[0].launch.args ?? [];
      expect(args).toContain('--json-schema');
      expect(JSON.parse(args[args.indexOf('--json-schema') + 1]!)).toEqual(outputSchema);
      await exec.emit({ type: 'assistant', uuid: 'prose', message: { role: 'assistant', content: [{ type: 'text', text: 'Inspecting the changes.' }] } });
      await exec.emit({ type: 'result', subtype: 'success', is_error: false, result: 'Inspection complete.', structured_output: structured,
        session_id: 'native-schema', num_turns: 1, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1 });
      await operations.waitForProviderTurnCompletion();
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ kind: 'transcript-message-committed', text: JSON.stringify(structured) })));
      await runtime.send({ inputIds: ['repair-input'], input: { text: 'inspect again', outputSchema },
        delivery: { kind: 'newTurn', turnId: 'repair-turn' } });
      expect(exec.spawnClient.mock.calls).toHaveLength(1);
      await exec.emit({ type: 'result', subtype: 'success', is_error: false, structured_output: structured,
        session_id: 'native-schema', num_turns: 1, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1 });
      await operations.waitForProviderTurnCompletion();
      await runtime.send({ inputIds: ['plain-input'], input: { text: 'explain' }, delivery: { kind: 'newTurn', turnId: 'plain-turn' } });
      expect(exec.spawnClient.mock.calls).toHaveLength(2);
      expect(exec.spawnClient.mock.calls[1]?.[0].launch.args).not.toContain('--json-schema');
    } finally { subscription.dispose(); await runtime.dispose(); }
  });
});
