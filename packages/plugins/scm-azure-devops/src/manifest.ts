import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.scm.hosting.azure-devops',
  version: '0.0.0',
  displayName: 'Azure DevOps SCM hosting provider',
  description: 'Detects Azure DevOps remotes and provides Azure Repos operations.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: 'azure-devops-api',
      capability: 'network',
      reason: 'Access the configured Azure DevOps SCM provider origin.',
      scope: {
        targets: [{ kind: 'scmProviderOrigin', provider: 'azure-devops' }],
        methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      },
    }, {
      id: 'azure-cli-process',
      capability: 'process',
      reason: 'Run the declared Azure CLI for authenticated Azure DevOps operations.',
      scope: {
        executables: [{ kind: 'systemTool', id: 'azure-cli' }],
        envKeys: ['AZURE_CORE_NO_COLOR', 'AZURE_CORE_ONLY_SHOW_ERRORS'],
      },
    }],
    optional: [],
  },
  contributes: {
    scmHostingProviders: [{
      id: 'azure-devops',
      title: 'Azure DevOps',
      description: 'Azure Repos repositories hosted by Azure DevOps.',
      kind: 'azure-devops',
      capabilities: ['detect', 'clone', 'fetch', 'push', 'pullRequest'],
    }],
    systemTools: [{
      id: 'azure-cli',
      title: 'Azure CLI',
      description: 'Azure command line client used for authenticated Azure DevOps operations.',
      executableNames: ['az'],
    }],
  },
} satisfies PluginManifest;
