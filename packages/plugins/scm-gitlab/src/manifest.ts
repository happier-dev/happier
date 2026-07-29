import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.scm.hosting.gitlab',
  version: '0.0.0',
  displayName: 'GitLab SCM hosting provider',
  description: 'Detects GitLab remotes and provides GitLab repository operations.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: 'gitlab-api',
      capability: 'network',
      reason: 'Access the configured GitLab SCM provider origin.',
      scope: {
        targets: [{ kind: 'scmProviderOrigin', provider: 'gitlab' }],
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
      },
    }, {
      id: 'gitlab-cli-process',
      capability: 'process',
      reason: 'Run the declared GitLab CLI for pull-request operations.',
      scope: { executables: [{ kind: 'systemTool', id: 'gitlab-cli' }] },
    }],
    optional: [],
  },
  contributes: {
    scmHostingProviders: [{
      id: 'gitlab',
      title: 'GitLab',
      description: 'GitLab.com and configured self-managed GitLab repositories.',
      kind: 'gitlab',
      capabilities: ['detect', 'clone', 'fetch', 'push', 'pullRequest'],
    }],
    systemTools: [{
      id: 'gitlab-cli',
      title: 'GitLab CLI',
      description: 'GitLab command line client used for authenticated merge-request operations.',
      executableNames: ['glab'],
    }],
  },
} satisfies PluginManifest;
