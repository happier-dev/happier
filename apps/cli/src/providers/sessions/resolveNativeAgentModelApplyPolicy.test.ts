import { describe, expect, it } from 'vitest';

import { resolveNativeAgentModelApplyPolicy } from './resolveNativeAgentModelApplyPolicy';

describe('resolveNativeAgentModelApplyPolicy', () => {
  it.each([
    [{ supportsSelection: false, nonAcpApplyScope: 'next_prompt' }, 'unsupported'],
    [{ supportsSelection: true, nonAcpApplyScope: 'spawn_only' }, 'restart_session'],
    [{
      supportsSelection: true,
      nonAcpApplyScope: 'next_prompt',
      acpApplyBehavior: 'restart_session',
    }, 'restart_session'],
    [{
      supportsSelection: true,
      nonAcpApplyScope: 'next_prompt',
      acpApplyBehavior: 'set_model',
    }, 'live'],
  ] as const)('maps native Agent model capability %o to %s', (modelConfig, expected) => {
    expect(resolveNativeAgentModelApplyPolicy(modelConfig)).toBe(expected);
  });
});
