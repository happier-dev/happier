import { definePluginManifest, type PluginManifestV2 } from '@happier-dev/plugin-sdk';

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.scm.hosting.azure-devops',
  version: '0.0.0',
  displayName: 'Azure DevOps SCM hosting provider',
  description: 'Detects Azure DevOps remotes and builds compare URLs.',
  source: {
    kind: 'package',
    locator: '@happier-dev/plugins-scm-azure-devops',
    trustPolicy: 'local_trusted',
    installPolicy: 'link',
    resolvedVersion: '0.0.0',
  },
  engines: { happier: '^0.0.0' },
  activationEvents: ['onScmProvider:scm.azure-devops'],
  uses: ['scmHostingProviders'],
  entrypoints: { main: './dist/index.js' },
  permissions: { required: [], optional: [] },
  contributes: {
    scmHostingProviders: [
      {
        id: 'scm.azure-devops',
        kind: 'azure-devops',
        displayName: 'Azure DevOps',
        baseUrl: 'https://dev.azure.com',
        remoteHostMatchers: {
          exactHosts: ['dev.azure.com', 'ssh.dev.azure.com'],
          suffixHosts: ['.visualstudio.com'],
        },
        urlSafety: {
          allowedSchemes: ['https:'],
          allowedBaseUrls: ['https://dev.azure.com'],
          allowedOrigins: ['https://dev.azure.com'],
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
          reviewThreads: {
            read: false,
            write: false,
          },
        },
      },
    ],
  },
} satisfies PluginManifestV2);
