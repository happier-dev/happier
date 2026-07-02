import { describe, expect, it } from 'vitest';

import { summarizePiConnectedServiceActiveProfiles } from './piConnectedServiceActiveProfiles';

describe('summarizePiConnectedServiceActiveProfiles', () => {
  it('keeps active connected-service profiles independent per service', () => {
    expect(summarizePiConnectedServiceActiveProfiles({
      openaiCodexProfileId: 'codex-p2',
      anthropicProfileId: 'anthropic-p1',
      openaiProfileId: null,
      claudeSubscriptionProfileId: null,
    })).toEqual({
      'openai-codex': 'codex-p2',
      anthropic: 'anthropic-p1',
    });
  });
});
