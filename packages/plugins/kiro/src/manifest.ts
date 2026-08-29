import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { KIRO_ACP_RUNTIME_DEFINITION } from './agent/acp/runtimeDefinition.js';
import { detectKiroCliAuthStatus } from './agent/auth/status.js';
import { AGENT_DEFINITION } from './agent/definition.js';
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
        runtime: {
          kind: 'acp',
          transport: {
            kind: 'stdio',
            executable: { kind: 'systemTool', id: 'kiro-cli' },
            args: ['acp'],
          },
          definition: KIRO_ACP_RUNTIME_DEFINITION,
        },
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
            nonInteractiveStatusProbe: true,
            loginLaunches: [{ kind: 'primary', args: ['login'] }],
          },
        },
        primary: 'sessions',
        catalog: {
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'steer', 'followUp'],
            cancel: true,
          },
        }),
      },
      cliAuth: {
        detectAuthStatus: async ({ runDeclaredSystemToolCommand }) =>
          await detectKiroCliAuthStatus({
            runCommand: async (args, options) => await runDeclaredSystemToolCommand({
              toolId: 'kiro-cli',
              args,
              ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            }),
          }),
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
