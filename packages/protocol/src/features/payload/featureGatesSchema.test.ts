import { describe, expect, it } from 'vitest';

import { DEFAULT_BUG_REPORTS_CAPABILITIES } from './capabilities/bugReportsCapabilities.js';
import { readServerEnabledBit } from '../serverEnabledBit.js';
import { FeaturesResponseSchema } from './featuresResponseSchema.js';

describe('FeatureGatesSchema', () => {
  it('preserves pets companion and sync gates', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        pets: {
          companion: { enabled: true },
          sync: { enabled: true },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'pets.companion' as never)).toBe(true);
    expect(readServerEnabledBit(parsed, 'pets.sync' as never)).toBe(true);
  });

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

  it('preserves peer mediation gate namespace and keeps rpc server-routed absent', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        machines: {
          enabled: true,
          tunnel: {
            enabled: true,
            directPeer: { enabled: true },
            serverRouted: { enabled: false },
          },
          liveStream: {
            enabled: true,
            directPeer: { enabled: true },
            serverRouted: { enabled: false },
          },
          rpc: {
            enabled: true,
            directPeer: { enabled: true },
            serverRouted: { enabled: true },
          },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'machines.tunnel.directPeer' as never)).toBe(true);
    expect(readServerEnabledBit(parsed, 'machines.tunnel.serverRouted' as never)).toBe(false);
    expect(readServerEnabledBit(parsed, 'machines.liveStream.directPeer' as never)).toBe(true);
    expect(readServerEnabledBit(parsed, 'machines.liveStream.serverRouted' as never)).toBe(false);
    expect(readServerEnabledBit(parsed, 'machines.rpc.directPeer' as never)).toBe(true);
    expect((parsed.features.machines as unknown as { rpc?: { serverRouted?: unknown } }).rpc?.serverRouted).toBeUndefined();
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
