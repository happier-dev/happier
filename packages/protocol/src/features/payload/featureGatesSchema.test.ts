import { describe, expect, it } from 'vitest';

import { DEFAULT_BUG_REPORTS_CAPABILITIES } from './capabilities/bugReportsCapabilities.js';
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

  it('keeps current gate reads stable when the payload carries newer unknown feature fields and malformed bug report capabilities', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        connectedServices: {
          enabled: true,
          quotas: { enabled: true },
        },
        futureBridge: {
          enabled: true,
          experimental: { enabled: true },
        },
      },
      capabilities: {
        bugReports: {
          providerUrl: 'not-a-url',
          defaultIncludeDiagnostics: false,
          maxArtifactBytes: 0,
          acceptedArtifactKinds: [],
          uploadTimeoutMs: 0,
          contextWindowMs: 0,
        },
        futureCapability: {
          enabled: true,
        },
      },
    });

    expect(readServerEnabledBit(parsed, 'connectedServices')).toBe(true);
    expect(readServerEnabledBit(parsed, 'connectedServices.quotas')).toBe(true);
    expect(parsed.capabilities.bugReports).toEqual(DEFAULT_BUG_REPORTS_CAPABILITIES);
    expect((parsed as any).features.futureBridge).toBeUndefined();
    expect((parsed as any).capabilities.futureCapability).toBeUndefined();
  });

  it('treats missing voice enabled bits as disabled (and does not crash parsing)', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        voice: {
          happierVoice: {},
        },
      },
      capabilities: {},
    });

    expect(parsed.features.voice.enabled).toBe(false);
    expect(parsed.features.voice.happierVoice.enabled).toBe(false);
    expect(readServerEnabledBit(parsed, 'voice')).toBe(false);
    expect(readServerEnabledBit(parsed, 'voice.happierVoice')).toBe(false);
  });
});
