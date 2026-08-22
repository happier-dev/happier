import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { AGENT_DEFINITION } from './agent/definition.js';
import { createCopilotAgentRuntime } from './agent/runtime/factory.js';
import { COPILOT_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { COPILOT_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

const COPILOT_AUTH_ENV_KEYS = [
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;

const {
  id: COPILOT_AGENT_SETTINGS_CONTRIBUTION_ID,
  ...COPILOT_AGENT_SETTINGS_DECLARATION
} = COPILOT_AGENT_SETTINGS_CONTRIBUTION;

export const COPILOT_PLUGIN = definePlugin({
  id: 'happier.agent.copilot',
  version: '0.0.0',
  displayName: 'GitHub Copilot',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'copilot-process',
      capability: 'process',
      reason: 'Run the declared GitHub Copilot CLI executable.',
      scope: {
        executables: [{ kind: 'systemTool', id: 'copilot-cli' }],
        envKeys: [...COPILOT_AUTH_ENV_KEYS],
      },
    }],
    optional: [],
  },
  agents: {
    copilot: {
      declaration: {
        title: 'GitHub Copilot',
        runtime: { kind: 'custom' },
        cli: {
          displayName: 'GitHub Copilot CLI',
          executable: {
            binaryName: 'copilot',
            knownUserBinDirSuffixes: null,
            sourcePreference: 'system-first',
          },
          install: {
            managed: {
              kind: 'managed_package',
              packageName: '@github/copilot',
              binaryName: 'copilot',
            },
            manual: { kind: 'command' },
            guideUrl: null,
            docsUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli',
          },
          auth: {
            support: 'login_terminal',
            probe: {
              parser: 'copilotGhAuth',
              backgroundChecks: 'safe',
              statusArgs: null,
              envVars: [...COPILOT_AUTH_ENV_KEYS],
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
      factory: createCopilotAgentRuntime,
      sessionRunnerFactory: {
        module: './agent/runtime/factory',
        export: 'createCopilotAgentRuntime',
        runtimeApiVersion: 1,
      },
    },
  },
  systemTools: {
    'copilot-cli': {
      title: 'GitHub Copilot CLI',
      executableNames: ['copilot'],
    },
  },
  ui: {
    translations: COPILOT_UI_TRANSLATION_BUNDLES,
  },
  settings: {
    [COPILOT_AGENT_SETTINGS_CONTRIBUTION_ID]: COPILOT_AGENT_SETTINGS_DECLARATION,
  },
});

export const PLUGIN_MANIFEST = COPILOT_PLUGIN.manifest;
