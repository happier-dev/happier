import { getConnectedAccountDescriptor } from '@happier-dev/plugin-sdk/experimental/manifest/connectedAccountDescriptors';
import { definePluginManifest, type PluginManifestV2 } from '@happier-dev/plugin-sdk';

const githubConnectedAccountDescriptor = getConnectedAccountDescriptor('github');
if (!githubConnectedAccountDescriptor) {
  throw new Error('Missing GitHub connected-account descriptor');
}

export const PLUGIN_MANIFEST = definePluginManifest({
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
  activationEvents: ['onScmProvider:scm.github'],
  uses: ['scmHostingProviders', 'connectedAccountDescriptors'],
  entrypoints: { main: './dist/index.js' },
  permissions: { required: [], optional: [] },
  contributes: {
    scmHostingProviders: [
      {
        id: 'scm.github',
        kind: 'github',
        displayName: 'GitHub',
        baseUrl: 'https://github.com',
        remoteHostMatchers: {
          exactHosts: ['github.com'],
        },
        urlSafety: {
          allowedSchemes: ['https:'],
          allowedBaseUrls: ['https://github.com'],
          allowedOrigins: ['https://github.com'],
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
    connectedAccountDescriptors: [githubConnectedAccountDescriptor],
  },
} satisfies PluginManifestV2);
