import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';

describe('Pi AGENT_DEFINITION', () => {
  it('advertises Claude subscription credentials as OAuth-or-token', () => {
    expect(AGENT_DEFINITION.core.connectedServices.supportedKindsByServiceId['claude-subscription']).toEqual([
      'oauth',
      'token',
    ]);
  });
});
