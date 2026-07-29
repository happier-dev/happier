import { describe, expect, it } from 'vitest';

import { KILO_ACP_RUNTIME_DEFINITION } from './definition.js';

describe('Kilo ACP runtime definition', () => {
  it('preserves Kilo-owned model, timeout, inference, stderr, and MCP policy', () => {
    expect(KILO_ACP_RUNTIME_DEFINITION).toMatchObject({
      modelConfigOptionId: 'model',
      timeouts: expect.any(Object),
      toolNameInference: {
        hintInputFields: ['tool_name', 'toolName', 'name', 'title', 'description'],
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
    expect(KILO_ACP_RUNTIME_DEFINITION).not.toHaveProperty('permissionOptionSelection');
  });
});
