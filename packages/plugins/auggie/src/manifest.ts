import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { AGENT_DEFINITION } from './agent/definition.js';
import { createAuggieAgentRuntime } from './agent/runtime/factory.js';
import { AUGGIE_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

const {
  id: AUGGIE_AGENT_SETTINGS_CONTRIBUTION_ID,
  ...AUGGIE_AGENT_SETTINGS_DECLARATION
} = AUGGIE_AGENT_SETTINGS_CONTRIBUTION;

export const AUGGIE_PLUGIN = definePlugin({
  id: 'happier.agent.auggie',
  version: '0.0.0',
  displayName: 'Auggie',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'auggie-process',
      capability: 'process',
      reason: 'Run the declared Auggie CLI executable.',
      scope: { executables: [{ kind: 'systemTool', id: 'auggie-cli' }] },
    }],
    optional: [],
  },
  agents: {
    auggie: {
      declaration: {
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
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'steer', 'followUp'],
            cancel: true,
          },
        }),
      },
      factory: createAuggieAgentRuntime,
      sessionRunnerFactory: {
        module: './agent/runtime/factory',
        export: 'createAuggieAgentRuntime',
        runtimeApiVersion: 1,
      },
    },
  },
  systemTools: {
    'auggie-cli': {
      title: 'Auggie CLI',
      executableNames: ['auggie'],
    },
  },
  settings: {
    [AUGGIE_AGENT_SETTINGS_CONTRIBUTION_ID]: AUGGIE_AGENT_SETTINGS_DECLARATION,
  },
});

export const PLUGIN_MANIFEST = AUGGIE_PLUGIN.manifest;
