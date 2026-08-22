import { describe, expect, it } from 'vitest';

import { buildAgentProbeCacheKey } from './buildAgentProbeCacheKey';

describe('buildAgentProbeCacheKey', () => {
  it('keys cold probes only by their non-secret runtime inputs', () => {
    expect(buildAgentProbeCacheKey({
      agentId: 'codex' as const,
      cwd: '/workspace',
      variant: 'appServer',
    })).toBe('agent:codex:target:none:cwd:/workspace:v:appServer');
  });
});
