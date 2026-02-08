import { describe, expect, it } from 'vitest';

import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/providerSpecs';
import { resolveProviderAuthOverlay } from '../../src/testkit/providers/providerAuthOverlay';
import { resolveScenariosForProvider } from '../../src/testkit/providers/harness';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

describe('providers: scenario selection (from cli specs)', () => {
  it('resolves scenarios for each provider tier using the provider registries', async () => {
    const providers = await loadProvidersFromCliSpecs();
    expect(providers.length).toBeGreaterThan(0);

    for (const provider of providers) {
      const baseEnv: Record<string, string | undefined> = {
        ...process.env,
        ...(provider.cli.env ?? {}),
        ...Object.fromEntries(
          Object.entries(provider.cli.envFrom ?? {}).flatMap(([dest, src]) => {
            const value = typeof process.env[src] === 'string' ? process.env[src]!.trim() : '';
            return value ? [[dest, value]] : [];
          }),
        ),
      };

      const authEnvAnyOf = provider.auth?.env?.requiredAnyOf ?? [];
      const hasHostOverlay = Boolean(provider.auth?.host);
      if (!hasHostOverlay && authEnvAnyOf.length > 0) {
        const firstBucket = authEnvAnyOf[0] ?? [];
        for (const key of firstBucket) {
          if (!baseEnv[key]) baseEnv[key] = 'test-key';
        }
      }
      const { mode } = resolveProviderAuthOverlay({ auth: provider.auth, baseEnv });

      const registryWithAuthModes = provider.scenarioRegistry as ProviderUnderTest['scenarioRegistry'] & {
        tiersByAuthMode?: {
          host?: { smoke?: string[]; extended?: string[] };
          env?: { smoke?: string[]; extended?: string[] };
        };
      };
      const expectedSmoke = registryWithAuthModes.tiersByAuthMode?.[mode]?.smoke ?? provider.scenarioRegistry.tiers.smoke ?? [];
      const expectedExtended =
        registryWithAuthModes.tiersByAuthMode?.[mode]?.extended ?? provider.scenarioRegistry.tiers.extended ?? [];

      const smoke = resolveScenariosForProvider({ provider, tier: 'smoke' });
      expect(smoke.map((s) => s.id)).toEqual(expectedSmoke);

      const extended = resolveScenariosForProvider({ provider, tier: 'extended' });
      expect(extended.map((s) => s.id)).toEqual(expectedExtended);
    }
  });
});
