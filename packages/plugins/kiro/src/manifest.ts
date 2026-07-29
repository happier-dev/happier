import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { KIRO_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.agent.kiro',
  version: '0.0.0',
  displayName: 'Kiro',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: 'kiro-process',
      capability: 'process',
      reason: 'Run the declared Kiro CLI executable.',
      scope: { executables: [{ kind: 'systemTool', id: 'kiro-cli' }] },
    }],
    optional: [],
  },
  contributes: {
    agents: [{
      id: 'kiro',
      title: 'Kiro',
      runtime: { kind: 'custom' },
      cli: {
        displayName: 'Kiro CLI',
        executable: {
          binaryName: 'kiro-cli',
          knownUserBinDirSuffixes: null,
          sourcePreference: 'system-first',
        },
        install: {
          managed: null,
          manual: { kind: 'command' },
          docsUrl: 'https://kiro.dev/docs/cli/acp/',
        },
        auth: {
          support: 'login_terminal',
          probe: {
            parser: 'kiroWhoamiJson',
            backgroundChecks: 'manual_only',
            statusArgs: ['whoami', '--format', 'json'],
          },
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
    systemTools: [{ id: 'kiro-cli', title: 'Kiro CLI', executableNames: ['kiro-cli'] }],
    settings: [KIRO_AGENT_SETTINGS_CONTRIBUTION],
  },
} satisfies PluginManifest;
