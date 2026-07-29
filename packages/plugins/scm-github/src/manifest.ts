import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.scm.hosting.github',
  version: '0.0.0',
  displayName: 'GitHub SCM hosting provider',
  description: 'Detects GitHub remotes and provides GitHub repository operations.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: 'github-api',
      capability: 'network',
      reason: 'Access the GitHub origin selected from the SCM provider and connected account.',
      scope: {
        targets: [
          { kind: 'fixedOrigin', origin: 'https://api.github.com' },
          { kind: 'scmProviderOrigin', provider: 'github' },
          { kind: 'connectedAccountOrigin', service: 'github-account' },
        ],
        methods: ['GET', 'POST'],
      },
    }, {
      id: 'github-cli-process',
      capability: 'process',
      reason: 'Run the declared GitHub CLI when a repository operation uses the CLI fallback.',
      scope: { executables: [{ kind: 'systemTool', id: 'github-cli' }] },
    }],
    optional: [],
  },
  contributes: {
    scmHostingProviders: [{
      id: 'github',
      title: 'GitHub',
      description: 'GitHub Cloud and configured GitHub Enterprise repositories.',
      kind: 'github',
      capabilities: ['detect', 'clone', 'fetch', 'push', 'pullRequest'],
      authService: 'github-account',
    }],
    connectedAccountDescriptors: [{
      id: 'github-account',
      title: 'GitHub account',
      description: 'GitHub account used for repository and pull-request operations.',
      authentication: {
        defaultModeId: 'fine-grained-pat',
        modes: [{
          id: 'fine-grained-pat',
          kind: 'manual',
          title: 'Fine-grained personal access token',
          outcomeReconciliation: 'none',
          fields: [{
            id: 'token',
            title: 'Fine-grained personal access token',
            description: 'A GitHub fine-grained personal access token with access to the repositories you use in Happier.',
            schema: { type: 'string', minLength: 1 },
            secret: true,
          }],
        }],
      },
      capabilities: ['scmHostingToken'],
    }],
    systemTools: [{
      id: 'github-cli',
      title: 'GitHub CLI',
      description: 'GitHub command line client used as an authenticated repository-operation fallback.',
      executableNames: ['gh'],
    }],
  },
} satisfies PluginManifest;
