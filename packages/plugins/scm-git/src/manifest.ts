import { definePluginManifest, type PluginManifestV2, type ScmBackendContribution } from '@happier-dev/plugin-sdk';

import { GIT_SCM_BACKEND_CAPABILITIES } from './capabilities.js';

export const GIT_SCM_BACKEND_CONTRIBUTION = Object.freeze({
  id: 'git',
  displayName: 'Git',
  description: 'Local Git repository backend.',
  repoModes: ['.git'],
  detection: {
    rootMarkers: ['.git'],
  },
  capabilities: GIT_SCM_BACKEND_CAPABILITIES,
  installableDependencies: ['dep.git'],
  tooling: {
    commands: [{ installableKey: 'dep.git', command: 'git' }],
    systemFirst: true,
    managedFallback: false,
  },
  safetyConstraints: {
    mutatesWorkingTree: true,
    requiresUserConfirmationForDestructiveWrites: true,
  },
} satisfies ScmBackendContribution);

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.scm.backend.git',
  version: '0.0.0',
  displayName: 'Git SCM backend',
  description: 'First-party local Git SCM backend.',
  source: {
    kind: 'package',
    locator: '@happier-dev/plugins-scm-git',
    trustPolicy: 'local_trusted',
    installPolicy: 'link',
    resolvedVersion: '0.0.0',
  },
  engines: { happier: '^0.0.0' },
  activationEvents: ['onScmProvider:git'],
  uses: ['scmBackends'],
  entrypoints: { main: './dist/index.js' },
  permissions: { required: [], optional: [] },
  contributes: {
    managedDependencies: [{
      id: 'dep.git',
      key: 'dep.git',
      kind: 'dep',
      version: '1',
      capabilityId: 'dep.git',
      display: {
        name: 'Git',
        subtitle: 'System Git executable',
      },
      description: 'Git command line executable used for local source-control operations.',
      source: {
        kind: 'manual_only',
        setupUrl: 'https://git-scm.com/downloads',
      },
      binary: {
        commands: ['git'],
        systemFirst: true,
        managedFallback: false,
      },
      defaultPolicy: {
        autoInstallWhenNeeded: false,
        autoUpdateMode: 'off',
      },
      consent: {
        install: 'required',
        update: 'required',
        commandsPreviewRequired: true,
      },
      ui: {
        setupUrl: 'https://git-scm.com/downloads',
        iconName: 'git-branch',
      },
      stability: {
        experimental: false,
        supported: true,
      },
    }],
    scmBackends: [GIT_SCM_BACKEND_CONTRIBUTION],
  },
} satisfies PluginManifestV2);
