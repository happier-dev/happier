import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { getVoiceActionFunctionTool } from '@happier-dev/protocol/voice/actions';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { withCodexNativeAttachFixture } from './runtime.nativeAttach.test-support.js';

describe('Codex native host function tools', () => {
  it.each([undefined, { allowedTools: [], unlistedTools: 'deny' as const }])('advertises directly callable host functions independently of native tool restrictions (%j)', async (toolRestriction) => {
    const calls: JsonValue[] = [];
    const descriptor = getVoiceActionFunctionTool();
    const action = { t: getActionSpec('servers.list').bindings?.voiceClientToolName, args: {} };
    await withCodexNativeAttachFixture(async fixture => {
      const session = await fixture.openConfiguredSession();
      expect(fixture.requests.find(request => request.method === 'thread/start')?.params.dynamicTools).toEqual([
        { type: 'namespace', name: 'happier_host', description: expect.any(String), tools: [{ type: 'function', ...descriptor }] },
      ]);
      expect(session.functionToolsDelivered).toBe(true);
      expect(fixture.nativeLaunches.some(argv => argv.includes(
        'features.code_mode.direct_only_tool_namespaces=["happier_host"]',
      ))).toBe(true);
      const response = await fixture.requestNativeTool({ threadId: 'fresh-thread', turnId: 'turn-1',
        callId: 'call-1', namespace: 'happier_host', tool: descriptor.name, arguments: action });
      expect(calls).toEqual([action]);
      expect(response.result).toEqual({ contentItems: [{ type: 'inputText', text: '{"ok":true,"sessionId":"created"}' }], success: true });
      for (const invalid of [
        { threadId: 'another-thread', tool: descriptor.name, namespace: 'happier_host' },
        { threadId: 'fresh-thread', tool: 'unknown', namespace: 'happier_host' },
        { threadId: 'fresh-thread', tool: descriptor.name, namespace: 'other' },
        { threadId: 'fresh-thread', tool: descriptor.name, namespace: null },
      ]) {
        const rejected = await fixture.requestNativeTool({ ...invalid, turnId: 'turn-1', callId: 'call-2', arguments: {} });
        expect(rejected.result).toMatchObject({ success: false });
      }
      expect(calls).toHaveLength(1);
    }, { toolRestriction, functionTools: [{ ...descriptor,
      async call(input) { calls.push(input); return { ok: true, sessionId: 'created' }; } }] });
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
        callId: 'call-1', namespace: 'happier_host', tool: 'voice_action', arguments: null });
      expect(response.result).toMatchObject({ success: false });
      expect(JSON.stringify(response)).not.toContain('PRIVATE_HOST_ERROR');
    }, { functionTools: [{ name: 'voice_action', description: 'Apply a Voice output', inputSchema: { type: 'object' },
      async call() { throw new Error('PRIVATE_HOST_ERROR'); } }] });
  });
});
