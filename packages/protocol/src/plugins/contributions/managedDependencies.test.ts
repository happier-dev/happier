import { describe, expect, it } from 'vitest';

import { PluginManagedDependencyContributionV2Schema } from './managedDependencies.js';

describe('PluginManagedDependencyContributionV2Schema', () => {
  it.each([
    { kind: 'githubRelease', repository: 'acme/tool', assetPattern: 'tool-*' },
    { kind: 'npmArtifact', package: '@acme/tool', range: '^1' },
  ])('rejects unsupported executable source kind $kind at ingress', (source) => {
    expect(PluginManagedDependencyContributionV2Schema.safeParse({
      id: 'tool',
      title: 'Tool',
      executable: 'tool',
      sources: [source],
    }).success).toBe(false);
  });
});
