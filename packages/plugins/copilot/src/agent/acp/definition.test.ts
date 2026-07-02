import { describe, expect, it } from 'vitest';

import { COPILOT_ACP_BACKEND_SPEC } from './definition.js';

describe('Copilot ACP backend definition', () => {
  it('uses the final agent-cli ACP seam and plugin-owned argv callback', () => {
    expect(COPILOT_ACP_BACKEND_SPEC).toMatchObject({
      backendId: 'copilot',
      transport: {
        kind: 'stdio',
        launch: { kind: 'agent-cli', agentId: 'copilot', args: ['--acp'] },
      },
      capabilities: {
        supportsPermissionRequests: true,
        supportsLoadSession: true,
      },
      sessionIdHeaderName: 'copilotSessionId',
      toolNameInference: {
        shellBridgeHint: true,
        hintInputFields: ['tool_name', 'toolName', 'name'],
        investigationToolIdPatterns: ['task'],
        investigationToolKinds: ['task'],
      },
      stderrRules: {
        statusErrors: expect.arrayContaining([
          expect.objectContaining({
            includes: ['authentication'],
            detail: 'Authentication error. Run `copilot login` to authenticate with GitHub.',
          }),
        ]),
      },
      mcp: { policy: 'pass_through' },
    });
    expect(COPILOT_ACP_BACKEND_SPEC.callbacks).toHaveProperty('argvBuilder');
    expect(COPILOT_ACP_BACKEND_SPEC.callbacks).not.toHaveProperty('permissionDecision');
  });
});
