import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';

describe('OhMyPi agent definition', () => {
  it('advertises Claude subscription credentials as token-only', () => {
    expect(AGENT_DEFINITION.core.connectedServices.supportedKindsByServiceId['claude-subscription']).toEqual(['token']);
  });

  it('advertises Gemini connected-service credentials as token-only', () => {
    expect(AGENT_DEFINITION.core.connectedServices.supportedKindsByServiceId.gemini).toEqual(['token']);
  });
});
