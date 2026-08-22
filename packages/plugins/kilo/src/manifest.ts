import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { AGENT_DEFINITION } from './agent/definition.js';
import { KILO_OPENCODE_PERMISSION_ENV } from './agent/permissions/opencodePermissionPolicy.js';
import { createKiloAgentRuntime } from './agent/runtime/factory.js';
import { KILO_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

const {
  id: KILO_AGENT_SETTINGS_CONTRIBUTION_ID,
  ...KILO_AGENT_SETTINGS_DECLARATION
} = KILO_AGENT_SETTINGS_CONTRIBUTION;

export const KILO_PLUGIN = definePlugin({
  id: 'happier.agent.kilo',
  version: '0.0.0',
  displayName: 'Kilo',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
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
  agents: {
    kilo: {
      declaration: {
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
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'steer', 'followUp'],
            cancel: true,
          },
        }),
      },
      factory: createKiloAgentRuntime,
      sessionRunnerFactory: {
        module: './agent/runtime/factory',
        export: 'createKiloAgentRuntime',
        runtimeApiVersion: 1,
      },
    },
  },
  systemTools: {
    'kilo-cli': { title: 'Kilo CLI', executableNames: ['kilo'] },
  },
  settings: {
    [KILO_AGENT_SETTINGS_CONTRIBUTION_ID]: KILO_AGENT_SETTINGS_DECLARATION,
  },
});

export const PLUGIN_MANIFEST = KILO_PLUGIN.manifest;
