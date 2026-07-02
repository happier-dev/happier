import { definePluginManifest, type PluginManifestV2 } from '@happier-dev/plugin-sdk';

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.scm.hosting.gitlab',
  version: '0.0.0',
  displayName: 'GitLab SCM hosting provider',
  description: 'Detects GitLab remotes and builds compare URLs.',
  source: {
    kind: 'package',
    locator: '@happier-dev/plugins-scm-gitlab',
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
        id: 'scm.gitlab',
        kind: 'gitlab',
        displayName: 'GitLab',
        baseUrl: 'https://gitlab.com',
        remoteHostMatchers: {
          exactHosts: ['gitlab.com', 'gitlab.company.com', 'code.internal.test'],
        },
        urlSafety: {
          allowedSchemes: ['https:'],
          allowedBaseUrls: ['https://gitlab.com', 'https://gitlab.company.com', 'https://code.internal.test'],
          allowedOrigins: ['https://gitlab.com', 'https://gitlab.company.com', 'https://code.internal.test'],
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
        },
      },
    ],
  },
} satisfies PluginManifestV2);
