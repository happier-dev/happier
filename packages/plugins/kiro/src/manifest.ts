import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { AGENT_DEFINITION } from './agent/definition.js';
import { createKiroAgentRuntime } from './agent/runtime/factory.js';
import { KIRO_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

const {
  id: KIRO_AGENT_SETTINGS_CONTRIBUTION_ID,
  ...KIRO_AGENT_SETTINGS_DECLARATION
} = KIRO_AGENT_SETTINGS_CONTRIBUTION;

export const KIRO_PLUGIN = definePlugin({
  id: 'happier.agent.kiro',
  version: '0.0.0',
  displayName: 'Kiro',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'kiro-process',
      capability: 'process',
      reason: 'Run the declared Kiro CLI executable.',
      scope: { executables: [{ kind: 'systemTool', id: 'kiro-cli' }] },
    }],
    optional: [],
  },
  agents: {
    kiro: {
      declaration: {
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
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'steer', 'followUp'],
            cancel: true,
          },
        }),
      },
      factory: createKiroAgentRuntime,
      sessionRunnerFactory: {
        module: './agent/runtime/factory',
        export: 'createKiroAgentRuntime',
        runtimeApiVersion: 1,
      },
    },
  },
  systemTools: {
    'kiro-cli': { title: 'Kiro CLI', executableNames: ['kiro-cli'] },
  },
  settings: {
    [KIRO_AGENT_SETTINGS_CONTRIBUTION_ID]: KIRO_AGENT_SETTINGS_DECLARATION,
  },
});

export const PLUGIN_MANIFEST = KIRO_PLUGIN.manifest;
