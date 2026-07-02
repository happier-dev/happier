import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from '../definition.js';
import { GEMINI_ACP_BACKEND_SPEC } from './definition.js';

describe('GEMINI_ACP_BACKEND_SPEC', () => {
  it('declares Gemini native ACP launch and transport policy in the plugin leaf', () => {
    expect(GEMINI_ACP_BACKEND_SPEC).toMatchObject({
      backendId: 'gemini',
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'agent-cli',
          agentId: 'gemini',
          args: ['--acp'],
        },
      },
      transportLifecycle: {
        initDelayMs: 3_000,
      },
      mcp: {
        policy: 'pass_through',
      },
      sessionIdHeaderName: 'geminiSessionId',
    });
  });

  it('keeps Gemini permission mode argv mapping provider-owned', () => {
    expect(GEMINI_ACP_BACKEND_SPEC.permissionModeArgv).toEqual({
      flag: '--approval-mode',
      map: expect.objectContaining({
        default: null,
        plan: 'plan',
        acceptEdits: 'auto_edit',
        yolo: 'yolo',
        bypassPermissions: 'yolo',
      }),
    });
  });

  it('uses the canonical Gemini model default for ACP launch metadata', () => {
    expect(GEMINI_ACP_BACKEND_SPEC.ux.defaultModel).toBe(AGENT_DEFINITION.modelConfig.defaultMode);
    expect(AGENT_DEFINITION.modelConfig.allowedModes).toContain(GEMINI_ACP_BACKEND_SPEC.ux.defaultModel);
  });

  it('keeps Gemini stderr and tool-name dialects provider-owned', () => {
    const expectedModelDetail = AGENT_DEFINITION.modelConfig.allowedModes.join(', ');

    expect(GEMINI_ACP_BACKEND_SPEC.stderrRules?.statusErrors).toEqual([
      expect.objectContaining({
        includes: ['status 404', 'code":404'],
        detail: expect.stringContaining('Suggested models:'),
      }),
    ]);
    expect(GEMINI_ACP_BACKEND_SPEC.stderrRules?.statusErrors?.[0]?.detail).toContain(expectedModelDetail);
    expect(GEMINI_ACP_BACKEND_SPEC.toolNameInference).toMatchObject({
      preferLongestPattern: true,
      unknownToolNames: ['other', 'unknown', 'unknown tool', 'Unknown tool'],
      patterns: expect.arrayContaining([
        expect.objectContaining({ name: 'change_title' }),
        expect.objectContaining({ name: 'read' }),
        expect.objectContaining({ name: 'write' }),
        expect.objectContaining({ name: 'execute' }),
      ]),
    });
  });
});
