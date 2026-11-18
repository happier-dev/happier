import { describe, expect, it } from 'vitest';
import { getVoiceActionFunctionTool } from '@happier-dev/protocol/voice/actions';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import { withCodexNativeAttachFixture } from './runtime.nativeAttach.test-support.js';

describe('Codex native conversation prompt profile', () => {
  it.each([
    { promptProfile: 'conversation' as const, providerSessionId: undefined },
    { promptProfile: 'conversation' as const, providerSessionId: 'retained-thread' },
    { promptProfile: undefined, providerSessionId: undefined },
    { promptProfile: undefined, providerSessionId: 'retained-thread' },
  ])('applies the profile at thread open without a launch override (%j)', async ({ promptProfile, providerSessionId }) => {
    const descriptor = getVoiceActionFunctionTool();
    const action = { t: getActionSpec('servers.list').bindings?.voiceClientToolName, args: {} };
    await withCodexNativeAttachFixture(async fixture => {
      const session = await fixture.openConfiguredSession(providerSessionId);
      const method = providerSessionId ? 'thread/resume' : 'thread/start';
      const request = fixture.requests.find(entry => entry.method === method)?.params;
      expect(request).toBeDefined();
      expect(request?.developerInstructions).toBe('Actual startup instructions.');
      if (promptProfile === 'conversation') {
        expect(request?.config).toMatchObject({ project_doc_max_bytes: 0, 'skills.include_instructions': false });
        expect(fixture.nativeLaunches.flat()).not.toContain('project_doc_max_bytes=0');
      } else {
        expect(request?.config).not.toHaveProperty('project_doc_max_bytes');
        expect(request?.config).not.toHaveProperty('skills.include_instructions');
        expect(fixture.nativeLaunches.flat()).not.toContain('project_doc_max_bytes=0');
        expect(fixture.nativeLaunches.flat()).not.toContain('skills.include_instructions=false');
      }
      if (!providerSessionId) {
        expect(request?.dynamicTools).toEqual([{ type: 'function', ...descriptor }]);
        expect(session.functionToolsDelivered).toBe(true);
        const response = await fixture.requestNativeTool({ threadId: 'fresh-thread', turnId: 'turn-1',
          callId: 'voice-call', namespace: null, tool: descriptor.name, arguments: action });
        expect(response.result).toMatchObject({ success: true });
      }
    }, { promptProfile, functionTools: [{ ...descriptor, async call() { return { ok: true }; } }] });
  });
});
