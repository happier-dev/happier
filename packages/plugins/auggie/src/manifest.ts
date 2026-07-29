import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { AUGGIE_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.agent.auggie',
  version: '0.0.0',
  displayName: 'Auggie',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: 'auggie-process',
      capability: 'process',
      reason: 'Run the declared Auggie CLI executable.',
      scope: { executables: [{ kind: 'systemTool', id: 'auggie-cli' }] },
    }],
    optional: [],
  },
  contributes: {
    agents: [{
      id: 'auggie',
      title: 'Auggie',
      runtime: { kind: 'custom' },
      cli: {
        displayName: 'Auggie CLI',
        executable: {
          binaryName: 'auggie',
          knownUserBinDirSuffixes: null,
          sourcePreference: 'system-first',
        },
        install: {
          managed: {
            kind: 'managed_package',
            packageName: '@augmentcode/auggie',
            binaryName: 'auggie',
          },
          manual: { kind: 'command' },
          docsUrl: 'https://augmentcode.com',
        },
        auth: {
          support: 'login_terminal',
          probe: { parser: 'unknown', backgroundChecks: 'safe', statusArgs: null },
          loginLaunches: [{ kind: 'primary', args: ['login'] }],
        },
      },
      primary: 'sessions',
      capabilities: {
        sessions: {
          open: ['create', 'resume'],
          delivery: ['newTurn', 'steer', 'followUp'],
          cancel: true,
        },
      },
    }],
    systemTools: [{
      id: 'auggie-cli',
      title: 'Auggie CLI',
      executableNames: ['auggie'],
    }],
    settings: [AUGGIE_AGENT_SETTINGS_CONTRIBUTION],
  },
} satisfies PluginManifest;
