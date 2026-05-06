import type { PluginManifestV2 } from '@happier-dev/protocol';

export const PLUGIN_MANIFEST: PluginManifestV2 = {
  schemaVersion: 2,
  id: 'scm-azure-devops',
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
  runtime: { apiVersion: 1, capabilities: ['scmHostingProviders'] },
  targets: {},
  capabilities: { permissions: [] },
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
            list: false,
            get: false,
            create: false,
            checkout: false,
            prepareWorktree: false,
            runStacked: false,
          },
          repositoryProvisioning: {
            describeTargets: false,
            createRepository: false,
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
};
