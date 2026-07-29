import type { PluginInstallationReview } from '@/plugins/daemon/changeContract';

export function createPluginInstallationReviewFixture(
  overrides: Partial<PluginInstallationReview> = {},
): PluginInstallationReview {
  return {
    pluginId: 'acme.example',
    displayName: 'Example',
    version: '1.0.0',
    packageIdentity: { name: null, version: '1.0.0' },
    publisherIdentity: { status: 'unavailable' },
    source: { kind: 'path', locator: '/tmp/example' },
    updateChannel: { kind: 'path', locator: '/tmp/example', development: false },
    integrity: {
      packageDigest: `sha256:${'a'.repeat(64)}`,
      manifestDigest: `sha256:${'b'.repeat(64)}`,
      uiArtifactDigest: `sha256:${'c'.repeat(64)}`,
    },
    signature: { status: 'notProvided' },
    provenance: { status: 'notProvided' },
    curation: { status: 'notApplicable' },
    executableRealms: ['daemon'],
    contributions: [],
    uiArtifacts: { status: 'none', contributionIds: [] },
    requiredHostAccess: [],
    optionalHostAccess: [],
    compatibility: { happier: '^0.2.0', runtimeApiVersion: 1 },
    updatePolicy: 'manual',
    ...overrides,
  };
}
