import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { ScmBackendContribution } from '@happier-dev/plugin-sdk/scm/backend';

import { GIT_INSTALLABLE_DEP_ID, GIT_INSTALLABLE_DESCRIPTOR } from './installables/gitInstallable.js';

export const GIT_SCM_BACKEND_CONTRIBUTION = Object.freeze({
  id: 'git',
  title: 'Git',
  description: 'Local Git repository backend.',
  kind: 'git',
  capabilities: ['detect', 'clone', 'fetch', 'status', 'diff', 'commit', 'push', 'pullRequest'],
} satisfies ScmBackendContribution);

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.scm.backend.git',
  version: '0.0.0',
  displayName: 'Git SCM backend',
  description: 'First-party local Git SCM backend.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: 'git-process',
      capability: 'process',
      reason: 'Run the declared Git executable for local source-control operations.',
      scope: { executables: [{ kind: 'managedDependency', id: GIT_INSTALLABLE_DEP_ID }] },
    }],
    optional: [],
  },
  contributes: {
    managedDependencies: [GIT_INSTALLABLE_DESCRIPTOR],
    scmBackends: [GIT_SCM_BACKEND_CONTRIBUTION],
  },
} satisfies PluginManifest;
