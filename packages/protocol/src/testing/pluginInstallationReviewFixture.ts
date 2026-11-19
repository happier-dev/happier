import type { PluginInstallationReview } from '../marketplace/pluginInstallationReviewV1.js';

/**
 * The canonical serialized installation-review fixture.
 *
 * It lives beside the cross-process review schema it satisfies so the CLI
 * daemon tests and the client UI tests parse and present the exact same
 * "real CLI-projected review" value instead of drifting into per-package
 * copies that silently omit newer review facts.
 */
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
    compatibility: { happier: '^0.3.0', runtimeApiVersion: 1 },
    updatePolicy: 'allowed',
    ...overrides,
  };
}
