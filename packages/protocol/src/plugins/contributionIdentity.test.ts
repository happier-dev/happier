import { describe, expect, it } from 'vitest';

import {
  PluginContributionIdentityV1Schema,
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
  readPersistedAgentContributionIdentityV1,
  writePersistedAgentContributionIdentityV1,
} from './contributionIdentity.js';

describe('plugin contribution identity', () => {
  it('keeps plugin owner identity separate from domain-local contribution ids', () => {
    const identity = createPluginContributionIdentity({
      pluginId: 'happier.scm.hosting.github',
      localId: 'scm/github',
    });

    expect(identity).toEqual({
      pluginId: 'happier.scm.hosting.github',
      localId: 'scm/github',
    });
    expect(buildQualifiedPluginContributionKey(identity)).toBe(
      'happier.scm.hosting.github/scm/github',
    );
  });

  it('rejects invalid plugin ids while preserving family-local id syntax', () => {
    expect(PluginContributionIdentityV1Schema.safeParse({
      pluginId: 'codex',
      localId: 'codex',
    }).success).toBe(false);

    expect(createPluginContributionIdentity({
      pluginId: 'happier.agent.codex',
      localId: 'codex',
    }).localId).toBe('codex');

    expect(PluginContributionIdentityV1Schema.safeParse({
      pluginId: 'happier.agent.ohmypi',
      localId: 'ohMyPi',
    }).success).toBe(false);
  });

  it('keeps projection identity strict so manifest passthrough fields cannot enter dedupe keys', () => {
    expect(PluginContributionIdentityV1Schema.safeParse({
      pluginId: 'happier.agent.codex',
      localId: 'codex',
      xFutureManifestRoot: { preservedByManifestSchema: true },
    }).success).toBe(false);

    const identity = createPluginContributionIdentity({
      pluginId: 'happier.agent.codex',
      localId: 'codex',
    });

    expect(buildQualifiedPluginContributionKey(identity)).toBe('happier.agent.codex/codex');
  });

  it('imports the durable flat Oh My Pi predecessor exactly once and writes only structured identity', () => {
    const expected = {
      pluginId: 'happier.agent.ohmypi',
      localId: 'ohmypi',
    };

    expect(readPersistedAgentContributionIdentityV1('ohMyPi')).toEqual(expected);
    expect(readPersistedAgentContributionIdentityV1(expected)).toEqual(expected);
    expect(readPersistedAgentContributionIdentityV1('ohmypi')).toBeNull();
    expect(readPersistedAgentContributionIdentityV1('codex')).toBeNull();

    expect(writePersistedAgentContributionIdentityV1(expected)).toEqual(expected);
    expect(() => writePersistedAgentContributionIdentityV1('ohMyPi' as never)).toThrow();
  });
});
