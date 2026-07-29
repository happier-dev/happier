import { describe, expect, it } from 'vitest';

import { COPILOT_ACP_RUNTIME_DEFINITION } from './definition.js';

describe('Copilot ACP backend definition', () => {
  it('owns the static ACP policy consumed by the native runtime leaf', () => {
    expect(COPILOT_ACP_RUNTIME_DEFINITION).toMatchObject({
      modelConfigOptionId: 'model',
      toolNameInference: {
        shellBridgeHint: true,
        hintInputFields: ['tool_name', 'toolName', 'name', 'title', 'description'],
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
  });
});
