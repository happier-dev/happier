import {
  BITBUCKET_CONNECTED_ACCOUNT_DESCRIPTOR,
} from '@happier-dev/protocol';
import { definePluginManifest, type PluginManifestV2 } from '@happier-dev/plugin-sdk';

export const PLUGIN_MANIFEST = definePluginManifest({
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
  runtime: { apiVersion: 1, capabilities: ['scmHostingProviders', 'connectedAccountDescriptors'] },
  targets: {},
  capabilities: {},
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
  },
} satisfies PluginManifestV2);
