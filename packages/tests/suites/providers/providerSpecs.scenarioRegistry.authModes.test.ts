import { describe, expect, it } from 'vitest';

import { E2eCliProviderScenarioRegistryV1Schema } from '@happier-dev/protocol';

describe('providers: cli provider scenario registry (auth modes)', () => {
  it('preserves tiersByAuthMode when provided', () => {
    const parsed = E2eCliProviderScenarioRegistryV1Schema.safeParse({
      v: 1,
      tiers: {
        smoke: ['a'],
        extended: ['b'],
      },
      tiersByAuthMode: {
        host: {
          smoke: ['host_smoke'],
          extended: ['host_extended'],
        },
        env: {
          smoke: ['env_smoke'],
          extended: ['env_extended'],
        },
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // The schema should *not* strip auth-mode tier overrides.
    const data = parsed.data as Record<string, unknown>;
    const tiersByAuthMode =
      data.tiersByAuthMode && typeof data.tiersByAuthMode === 'object'
        ? (data.tiersByAuthMode as Record<string, unknown>)
        : null;
    const host = tiersByAuthMode?.host && typeof tiersByAuthMode.host === 'object'
      ? (tiersByAuthMode.host as Record<string, unknown>)
      : null;
    const env = tiersByAuthMode?.env && typeof tiersByAuthMode.env === 'object'
      ? (tiersByAuthMode.env as Record<string, unknown>)
      : null;

    expect(tiersByAuthMode).toBeTruthy();
    expect(host?.smoke).toEqual(['host_smoke']);
    expect(env?.extended).toEqual(['env_extended']);
  });
});
