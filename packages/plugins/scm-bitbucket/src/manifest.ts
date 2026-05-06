import type { PluginManifestV2 } from '@happier-dev/protocol';

export const PLUGIN_MANIFEST: PluginManifestV2 = {
  schemaVersion: 2,
  id: 'scm-bitbucket',
  version: '0.0.0',
  displayName: 'Bitbucket SCM hosting provider',
  description: 'Detects Bitbucket Cloud remotes, builds compare URLs, and declares API credential readiness.',
  source: {
    kind: 'package',
    locator: '@happier-dev/plugins-scm-bitbucket',
    trustPolicy: 'local_trusted',
    installPolicy: 'link',
    resolvedVersion: '0.0.0',
  },
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['scmHostingProviders'] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {
    scmHostingProviders: [
      {
        id: 'scm.bitbucket',
        kind: 'bitbucket',
        displayName: 'Bitbucket',
        baseUrl: 'https://bitbucket.org',
        remoteHostMatchers: {
          exactHosts: ['bitbucket.org'],
        },
        urlSafety: {
          allowedSchemes: ['https:'],
          allowedBaseUrls: ['https://bitbucket.org'],
          allowedOrigins: ['https://bitbucket.org'],
        },
        capabilities: {
          compareUrl: true,
          openUrl: true,
        },
        auth: {
          materializationKinds: ['scm_hosting_basic_auth'],
          credentialPayloadKind: 'bitbucket_basic_auth',
          cloudOnly: true,
        },
      },
    ],
  },
};
