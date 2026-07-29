import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.scm.hosting.bitbucket',
  version: '0.0.0',
  displayName: 'Bitbucket SCM hosting provider',
  description: 'Detects Bitbucket Cloud remotes and provides repository operations.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: 'bitbucket-api',
      capability: 'network',
      reason: 'Access the Bitbucket origin selected from the SCM provider and connected account.',
      scope: {
        targets: [
          { kind: 'fixedOrigin', origin: 'https://api.bitbucket.org' },
          { kind: 'scmProviderOrigin', provider: 'bitbucket' },
          { kind: 'connectedAccountOrigin', service: 'bitbucket-account' },
        ],
        methods: ['GET', 'POST'],
      },
    }],
    optional: [],
  },
  contributes: {
    scmHostingProviders: [{
      id: 'bitbucket',
      title: 'Bitbucket',
      description: 'Bitbucket Cloud repositories.',
      kind: 'bitbucket',
      capabilities: ['detect', 'clone', 'fetch', 'push', 'pullRequest'],
      authService: 'bitbucket-account',
    }],
    connectedAccountDescriptors: [{
      id: 'bitbucket-account',
      title: 'Bitbucket account',
      description: 'Bitbucket account used for repository and pull-request operations.',
      authentication: {
        defaultModeId: 'manual',
        modes: [{
          id: 'manual',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [
            {
              id: 'identity',
              title: 'Email or username',
              description: 'The email address or username associated with the Bitbucket API token.',
              schema: { type: 'string', minLength: 1 },
            },
            {
              id: 'token',
              title: 'API token',
              description: 'A Bitbucket API token with repository access.',
              schema: { type: 'string', minLength: 1 },
              secret: true,
            },
          ],
        }],
      },
      capabilities: ['scmHostingBasicAuth'],
    }],
  },
} satisfies PluginManifest;
