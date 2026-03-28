import { describe, expect, it } from 'vitest';

import { readServerEnabledBit } from '../serverEnabledBit.js';
import { FeaturesResponseSchema } from './featuresResponseSchema.js';

describe('FeatureGatesSchema', () => {
  it('preserves channel bridge gates', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        channelBridges: {
          enabled: true,
          telegram: { enabled: true },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'channelBridges')).toBe(true);
    expect(readServerEnabledBit(parsed, 'channelBridges.telegram')).toBe(true);
  });
});
