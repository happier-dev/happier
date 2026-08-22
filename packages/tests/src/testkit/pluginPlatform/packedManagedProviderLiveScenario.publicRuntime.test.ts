import { describe, expect, it, vi } from 'vitest';

import {
  createPackedManagedProviderLiveScenario,
  type PackedManagedProviderLiveSystem,
} from '../../plugin-platform/packedManagedProviderLiveScenario';

describe('packed managed Provider public runtime scenario', () => {
  it('rejects packaged conformance that did not traverse explicit-start and catalog public activations', async () => {
    const system: PackedManagedProviderLiveSystem = {
      probePackagedWrapper: vi.fn(async () => ({
        publicActivationReasons: [
          'catalogProbe',
          'explicitStartLocal',
        ] as const,
        explicitStartContributionKey:
          'happier.provider.cliproxyapi/cliproxyapi',
        explicitStartPhase: 'running' as const,
        catalogConnectionId: 'pc_packed_cliproxyapi',
        catalogModelIds: ['gpt-5.5'],
        catalogRequestFingerprint: 'provider-probe-request:v1:test',
        catalogOwnerReleased: true,
        publicObservationContainsCredential: false,
        providerAttemptedBeforeSessionDemand: false,
        credentialSentinelObserved: false,
      })),
      probeFreshManagedSpawn: vi.fn(async () => {
        throw new Error('not reached');
      }),
      probeActivationFailureCleanup: vi.fn(async () => {
        throw new Error('not reached');
      }),
      cleanup: vi.fn(async () => undefined),
    };
    const scenario = createPackedManagedProviderLiveScenario(system);

    await expect(scenario.runPackagedWrapperConformance({
      prepared: {
        candidate: { cli: { version: '0.2.10' } },
      },
    } as never)).rejects.toThrow(
      'packed_managed_provider_public_activation_reasons_mismatch',
    );
  });
});
