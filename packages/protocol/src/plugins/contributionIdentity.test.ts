import { describe, expect, it } from 'vitest';

import {
  PluginContributionIdentityV1Schema,
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
} from './contributionIdentity.js';

describe('plugin contribution identity', () => {
  it('keeps plugin owner identity separate from domain-local contribution ids', () => {
    const identity = createPluginContributionIdentity({
      pluginId: 'happier.scm.hosting.github',
      family: 'scmHostingProviders',
      contributionId: 'scm.github',
      provenance: 'first_party',
    });

    expect(identity).toEqual({
      pluginId: 'happier.scm.hosting.github',
      family: 'scmHostingProviders',
      contributionId: 'scm.github',
      provenance: 'first_party',
    });
    expect(buildQualifiedPluginContributionKey(identity)).toBe(
      'happier.scm.hosting.github:scmHostingProviders:scm.github',
    );
  });

  it('rejects invalid plugin ids while preserving family-local id syntax', () => {
    expect(PluginContributionIdentityV1Schema.safeParse({
      pluginId: 'codex',
      family: 'agents',
      contributionId: 'codex',
      provenance: 'first_party',
    }).success).toBe(false);

    expect(createPluginContributionIdentity({
      pluginId: 'happier.agent.codex',
      family: 'agents',
      contributionId: 'codex',
      provenance: 'first_party',
    }).contributionId).toBe('codex');
  });

  it('keeps projection identity strict so manifest passthrough fields cannot enter dedupe keys', () => {
    expect(PluginContributionIdentityV1Schema.safeParse({
      pluginId: 'happier.agent.codex',
      family: 'agents',
      contributionId: 'codex',
      provenance: 'first_party',
      xFutureManifestRoot: { preservedByManifestSchema: true },
    }).success).toBe(false);

    const identity = createPluginContributionIdentity({
      pluginId: 'happier.agent.codex',
      family: 'agents',
      contributionId: 'codex',
      provenance: 'first_party',
    });

    expect(buildQualifiedPluginContributionKey(identity)).toBe('happier.agent.codex:agents:codex');
  });
});
