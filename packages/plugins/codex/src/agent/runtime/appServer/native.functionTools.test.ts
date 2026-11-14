import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { getVoiceActionFunctionTool } from '@happier-dev/protocol/voice/actions';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { withCodexNativeAttachFixture } from './runtime.nativeAttach.test-support.js';
import { createCodexAgentRuntime } from '../engine.js';

describe('Codex native host function tools', () => {
  it('delivers fresh host functions through the factory despite an ACP coding preference', async () => {
    const runtime = await createCodexAgentRuntime({
      plugin: { id: 'happier.agent.codex', version: '0.0.0' },
      agent: { id: 'codex' }, signal: new AbortController().signal,
    });
    const sessions = runtime.sessions;
    if (!sessions) throw new Error('Codex Session factory is unavailable');
    await withCodexNativeAttachFixture(async fixture => {
      const session = await fixture.openConfiguredSession();
      expect(session.functionToolsDelivered).toBe(true);
      expect(fixture.requests.find(request => request.method === 'thread/start')?.params.dynamicTools)
        .toEqual([{ type: 'function', ...getVoiceActionFunctionTool() }]);
    }, {
      startupInstructions: null,
      processEnv: { HAPPIER_CODEX_BACKEND_MODE: 'acp' },
      configuration: {
        mode: { value: null, updatedAtMs: 0 }, model: { value: 'fixture-model', updatedAtMs: 1 },
        permissionIntent: { value: 'read-only', updatedAtMs: 1 },
        options: { codexBackendMode: { value: 'acp', updatedAtMs: 1 } },
      },
      sessionFactory: { open: (request, context) => sessions.open(request, {
        ...context,
        // The host ACP adapter is an external protocol boundary; the native factory stays real.
        protocols: { acp: { open: async () => { throw new Error('ACP cannot deliver native host functions'); } } } as AgentSessionRuntimeContext['protocols'],
      }) },
      functionTools: [{ ...getVoiceActionFunctionTool(), async call() { return { ok: true }; } }],
    });
  });
  it.each([undefined, { allowedTools: [], unlistedTools: 'deny' as const }])('advertises directly callable host functions independently of native tool restrictions (%j)', async (toolRestriction) => {
    const calls: Array<{ input: JsonValue; context: unknown }> = [];
    const descriptor = getVoiceActionFunctionTool();
    const namespace = toolRestriction?.unlistedTools === 'deny' ? 'happier_host' : null;
    const action = { t: getActionSpec('servers.list').bindings?.voiceClientToolName, args: {} };
    await withCodexNativeAttachFixture(async fixture => {
      const session = await fixture.openConfiguredSession();
      expect(fixture.requests.find(request => request.method === 'thread/start')?.params.dynamicTools).toEqual(namespace ? [{
        type: 'namespace', name: namespace, description: 'Host functions supplied for this conversation.',
        tools: [{ type: 'function', ...descriptor }],
      }] : [{ type: 'function', ...descriptor }]);
      expect(session.functionToolsDelivered).toBe(true);
      expect(fixture.nativeLaunches.some(argv => argv.includes(
        `features.code_mode.direct_only_tool_namespaces=["${namespace ?? 'functions'}"]`,
      ))).toBe(true);
      const response = await fixture.requestNativeTool({ threadId: 'fresh-thread', turnId: 'turn-1',
        callId: 'call-1', namespace, tool: descriptor.name, arguments: action });
      expect(calls).toEqual([{ input: action, context: { callId: 'call-1' } }]);
      expect(response.result).toEqual({ contentItems: [{ type: 'inputText', text: '{"ok":true,"sessionId":"created"}' }], success: true });
      for (const invalid of [
        { threadId: 'another-thread', tool: descriptor.name, namespace },
        { threadId: 'fresh-thread', tool: 'unknown', namespace },
        { threadId: 'fresh-thread', tool: descriptor.name, namespace: 'other' },
        { threadId: 'fresh-thread', tool: descriptor.name, namespace: namespace ? null : 'happier_host' },
        { threadId: 'fresh-thread', tool: descriptor.name, namespace, callId: '' },
      ]) {
        const rejected = await fixture.requestNativeTool({ turnId: 'turn-1', callId: 'call-2', ...invalid, arguments: {} });
        expect(rejected.result).toMatchObject({ success: false });
      }
      expect(calls).toHaveLength(1);
    }, { toolRestriction, functionTools: [{ ...descriptor,
      async call(input, context) { calls.push({ input, context }); return { ok: true, sessionId: 'created' }; } }] });
  });

  it('refuses an unconfined direct-mode model for a native-only host function recipe', async () => {
    await withCodexNativeAttachFixture(async fixture => {
      await expect(fixture.openConfiguredSession()).rejects.toMatchObject({ code: 'codex_tool_restriction_unsupported_model' });
      expect(fixture.requests.some(request => request.method === 'turn/start')).toBe(false);
    }, { nativeToolMode: 'direct', toolRestriction: { allowedTools: [], unlistedTools: 'deny' },
      functionTools: [{ ...getVoiceActionFunctionTool(), async call() { return { queued: true }; } }] });
  });

  it('does not claim new declarations were delivered on a cold resume', async () => {
    await withCodexNativeAttachFixture(async fixture => {
      const session = await fixture.openConfiguredSession('retained-thread');
      expect(session.functionToolsDelivered).toBe(false);
      expect(fixture.requests.find(request => request.method === 'thread/resume')?.params).not.toHaveProperty('dynamicTools');
    }, { functionTools: [{ name: 'voice_action', description: 'Apply a Voice output', inputSchema: { type: 'object' },
      async call() { return { ok: true }; } }] });
  });

  it('returns native failure without exposing a thrown host error', async () => {
    await withCodexNativeAttachFixture(async fixture => {
      await fixture.openConfiguredSession();
      const response = await fixture.requestNativeTool({ threadId: 'fresh-thread', turnId: 'turn-1',
        callId: 'call-1', namespace: null, tool: 'voice_action', arguments: null });
      expect(response.result).toMatchObject({ success: false });
      expect(JSON.stringify(response)).not.toContain('PRIVATE_HOST_ERROR');
    }, { functionTools: [{ name: 'voice_action', description: 'Apply a Voice output', inputSchema: { type: 'object' },
      async call() { throw new Error('PRIVATE_HOST_ERROR'); } }] });
  });
});
