import { describe, expect, it } from 'vitest';

import { KIRO_ACP_RUNTIME_DEFINITION } from './runtimeDefinition.js';

describe('Kiro custom ACP parity', () => {
  it('owns the static ACP policy consumed by the native runtime leaf', () => {
    expect(KIRO_ACP_RUNTIME_DEFINITION).toEqual({
      modelConfigOptionId: 'model',
      stderrRules: expect.objectContaining({
        suppress: expect.any(Array),
      }),
      mcp: { policy: 'pass_through' },
    });
  });
});
