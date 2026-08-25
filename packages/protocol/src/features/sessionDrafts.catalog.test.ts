import { describe, expect, it } from 'vitest';

import { FEATURE_CATALOG, isFeatureId } from './catalog.js';
import { FeaturesResponseSchema } from './payload/featuresResponseSchema.js';
import { readServerEnabledBit } from './serverEnabledBit.js';

describe('sessions.drafts feature contract', () => {
  it('is a fail-closed server feature dependent on sessions', () => {
    expect(isFeatureId('sessions.drafts')).toBe(true);
    expect(FEATURE_CATALOG['sessions.drafts']).toMatchObject({
      representation: 'server',
      dependencies: ['sessions'],
      defaultFailMode: 'fail_closed',
    });
  });

  it('defaults missing support off and preserves an explicit enabled bit', () => {
    expect(readServerEnabledBit(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }), 'sessions.drafts')).toBe(false);
    const parsed = FeaturesResponseSchema.parse({
      features: { sessions: { enabled: true, drafts: { enabled: true } } },
      capabilities: {},
    });
    expect(readServerEnabledBit(parsed, 'sessions.drafts')).toBe(true);
  });
});
