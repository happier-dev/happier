import { describe, expect, it } from 'vitest';

import { KILO_ACP_BACKEND_SPEC } from './definition.js';

describe('Kilo ACP backend definition', () => {
  it('uses the final agent-cli ACP seam and plugin-owned callbacks', () => {
    expect(KILO_ACP_BACKEND_SPEC).toMatchObject({
      backendId: 'kilo',
      transport: {
        kind: 'stdio',
        launch: { kind: 'agent-cli', agentId: 'kilo', args: ['acp'] },
      },
      capabilities: {
        supportsPermissionRequests: true,
        supportsLoadSession: true,
      },
      sessionIdHeaderName: 'kiloSessionId',
      toolNameInference: {
        hintInputFields: ['tool_name', 'toolName', 'name'],
        investigationToolIdPatterns: ['task'],
        investigationToolKinds: ['task'],
      },
      stderrRules: {
        statusErrors: expect.arrayContaining([
          expect.objectContaining({
            includes: ['failed to install', 'plugin'],
            detail: 'Kilo failed to install required plugins. Re-run `kilo` from your terminal to complete setup, then retry.',
          }),
        ]),
      },
      mcp: { policy: 'pass_through' },
    });
    expect(KILO_ACP_BACKEND_SPEC.callbacks).toHaveProperty('envBuilder');
    expect(KILO_ACP_BACKEND_SPEC.callbacks).not.toHaveProperty('permissionDecision');
  });
});
