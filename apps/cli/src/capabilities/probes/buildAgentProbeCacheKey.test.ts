import { describe, expect, it } from 'vitest';

import { buildAgentProbeCacheKey } from './buildAgentProbeCacheKey';

describe('buildAgentProbeCacheKey', () => {
  it('partitions probe cache entries by connected-service auth scope', () => {
    const base = {
      agentId: 'codex' as const,
      cwd: '/workspace',
      variant: 'appServer',
    };

    const first = buildAgentProbeCacheKey({
      ...base,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    });
    const second = buildAgentProbeCacheKey({
      ...base,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'personal' },
        },
      },
    });

    expect(first).not.toBe(second);
    expect(first).toBe(buildAgentProbeCacheKey({
      ...base,
      connectedServices: {
        bindingsByServiceId: {
          'openai-codex': { profileId: 'work', selection: 'profile', source: 'connected' },
        },
        v: 1,
      },
    }));
  });
});
