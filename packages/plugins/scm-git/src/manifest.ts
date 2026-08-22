import { definePlugin } from '@happier-dev/plugin-sdk';
import type { ScmBackendContribution } from '@happier-dev/plugin-sdk/scm/backend';

import { createGitScmBackendRuntimeRegistration } from './backend.js';
import { GIT_INSTALLABLE_DEP_ID, GIT_INSTALLABLE_DESCRIPTOR } from './installables/gitInstallable.js';

export const GIT_SCM_BACKEND_CONTRIBUTION = Object.freeze({
  id: 'git',
  title: 'Git',
  description: 'Local Git repository backend.',
  kind: 'git',
  capabilities: ['detect', 'clone', 'fetch', 'status', 'diff', 'commit', 'push', 'pullRequest'],
} satisfies ScmBackendContribution);

const gitScmBackendRegistration = createGitScmBackendRuntimeRegistration();

export const GIT_PLUGIN = definePlugin({
  id: 'happier.scm.backend.git',
  version: '0.0.0',
  displayName: 'Git SCM backend',
  description: 'First-party local Git SCM backend.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'git-process',
      capability: 'process',
      reason: 'Run the declared Git executable for local source-control operations.',
      scope: { executables: [{ kind: 'managedDependency', id: GIT_INSTALLABLE_DEP_ID }] },
    }],
    optional: [],
  },
  managedDependencies: {
    [GIT_INSTALLABLE_DEP_ID]: GIT_INSTALLABLE_DESCRIPTOR,
  },
  scmBackends: {
    git: {
      declaration: GIT_SCM_BACKEND_CONTRIBUTION,
      runtime: {
        runtime: gitScmBackendRegistration.runtime,
        handlers: gitScmBackendRegistration.handlers,
      },
    },
  },
});

export const PLUGIN_MANIFEST = GIT_PLUGIN.manifest;
