import { getConnectedAccountDescriptor, type PluginManifestV2 } from '@happier-dev/protocol';

const githubConnectedAccountDescriptor = getConnectedAccountDescriptor('github');
if (!githubConnectedAccountDescriptor) {
  throw new Error('Missing GitHub connected-account descriptor');
}

export const PLUGIN_MANIFEST: PluginManifestV2 = {
  schemaVersion: 2,
  id: 'happier.scm.hosting.github',
  version: '0.0.0',
  displayName: 'GitHub SCM hosting provider',
  description: 'Detects GitHub remotes and builds compare URLs.',
  source: {
    kind: 'package',
    locator: '@happier-dev/plugins-scm-github',
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
      reason: 'Register GitHub connected-account materialization hook',
    }],
  },
  contributes: {
    scmHostingProviders: [
      {
        id: 'scm.github',
        kind: 'github',
        displayName: 'GitHub',
        baseUrl: 'https://github.com',
        remoteHostMatchers: {
          exactHosts: ['github.com', 'github.company.com', 'ghe.internal.test'],
        },
        urlSafety: {
          allowedSchemes: ['https:'],
          allowedBaseUrls: ['https://github.com', 'https://github.company.com', 'https://ghe.internal.test'],
          allowedOrigins: ['https://github.com', 'https://github.company.com', 'https://ghe.internal.test'],
        },
        capabilities: {
          compareUrl: true,
          openUrl: true,
          pullRequests: {
            list: true,
            get: true,
            create: true,
            checkout: false,
            prepareWorktree: false,
            runStacked: false,
          },
          repositoryProvisioning: {
            describeTargets: true,
            createRepository: true,
            publish: false,
          },
        },
      },
    ],
    hooks: [{
      id: 'connectedServices.materialization.githubScmHostingToken',
      hookApiVersion: 1,
      category: 'integration',
      scope: 'plugin',
      executionKind: 'integrate',
      handler: {
        target: 'plugin',
        exportName: 'materializeGithubScmHostingToken',
      },
    }],
    connectedAccountDescriptors: [githubConnectedAccountDescriptor],
  },
};
