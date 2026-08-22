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
    signature: { status: 'notProvided' },
    provenance: { status: 'notProvided' },
    curation: { status: 'notApplicable' },
    executableRealms: ['daemon'],
    contributions: [],
    requestInterceptors: [],
    uiArtifacts: { status: 'none', contributionIds: [] },
    requiredHostAccess: [],
    optionalHostAccess: [],
    rawCredentialAccess: [],
    compatibility: { happier: '^0.2.0', runtimeApiVersion: 1 },
    updatePolicy: 'manual',
    ...overrides,
  };
}
