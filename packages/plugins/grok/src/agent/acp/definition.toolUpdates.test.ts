import { describe, expect, it } from 'vitest';

import { buildGrokAcpRuntimeDefinition } from './definition.js';

describe('Grok ACP tool update policy', () => {
  it('declares the provider pressure bounds for the session-scoped host owner', () => {
    expect(buildGrokAcpRuntimeDefinition({}).toolUpdates).toEqual({
      minInProgressIntervalMs: 250,
      maxStringChars: 8_192,
    });
  });
});
