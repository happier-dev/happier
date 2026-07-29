import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { KILO_OPENCODE_PERMISSION_ENV } from './agent/permissions/opencodePermissionPolicy.js';
import { KILO_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.agent.kilo',
  version: '0.0.0',
  displayName: 'Kilo',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: 'kilo-process',
      capability: 'process',
      reason: 'Run the declared Kilo CLI executable.',
      scope: {
        executables: [{ kind: 'systemTool', id: 'kilo-cli' }],
        envKeys: [KILO_OPENCODE_PERMISSION_ENV],
      },
    }],
    optional: [],
  },
  contributes: {
    agents: [{
      id: 'kilo',
      title: 'Kilo',
      runtime: { kind: 'custom' },
      cli: {
        displayName: 'Kilo CLI',
        executable: {
          binaryName: 'kilo',
          knownUserBinDirSuffixes: null,
          sourcePreference: 'system-first',
        },
        install: {
          managed: {
            kind: 'managed_package',
            packageName: '@kilocode/cli',
            binaryName: 'kilo',
          },
          manual: { kind: 'command' },
          guideUrl: null,
          docsUrl: 'https://kilo.ai/docs/cli',
        },
        auth: {
          support: 'login_terminal',
          probe: { parser: 'unknown', backgroundChecks: 'safe', statusArgs: null },
          loginLaunches: [{ kind: 'primary', args: [], initialInput: '/connect\r' }],
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
    systemTools: [{ id: 'kilo-cli', title: 'Kilo CLI', executableNames: ['kilo'] }],
    settings: [KILO_AGENT_SETTINGS_CONTRIBUTION],
  },
} satisfies PluginManifest;
