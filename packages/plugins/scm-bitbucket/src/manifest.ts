import {
  BITBUCKET_CONNECTED_ACCOUNT_DESCRIPTOR,
  type PluginManifestV2,
} from '@happier-dev/protocol';

export const PLUGIN_MANIFEST: PluginManifestV2 = {
  schemaVersion: 2,
  id: 'happier.scm.hosting.bitbucket',
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
  runtime: { apiVersion: 1, capabilities: ['scmHostingProviders', 'connectedAccountDescriptors', 'hooks'] },
  targets: {},
  capabilities: {
    permissions: [{
      capability: 'hooks.register',
      reason: 'Register Bitbucket connected-account materialization hook',
    }],
  },
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
          pullRequests: {
            list: true,
            get: true,
            create: true,
            checkout: true,
            prepareWorktree: false,
            runStacked: false,
          },
          repositoryProvisioning: {
            describeTargets: true,
            createRepository: true,
            publish: false,
          },
          reviewThreads: {
            read: false,
            write: false,
          },
        },
        auth: {
          materializationKinds: ['scm_hosting_basic_auth'],
          credentialPayloadKind: 'bitbucket_basic_auth',
          cloudOnly: true,
        },
      },
    ],
    connectedAccountDescriptors: [BITBUCKET_CONNECTED_ACCOUNT_DESCRIPTOR],
    hooks: [{
      id: 'connectedServices.materialization.bitbucketScmHostingBasicAuth',
      hookApiVersion: 1,
      category: 'integration',
      scope: 'plugin',
      executionKind: 'integrate',
      handler: {
        target: 'plugin',
        exportName: 'materializeBitbucketScmHostingBasicAuth',
      },
    }],
  },
};
