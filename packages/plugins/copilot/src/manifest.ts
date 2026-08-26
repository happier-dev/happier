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
        executables: [
          { kind: 'systemTool', id: 'copilot-cli' },
          { kind: 'systemTool', id: 'github-cli' },
        ],
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
            environmentVariables: [...COPILOT_AUTH_ENV_KEYS],
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
      factory: createCopilotAgentRuntime,
      cliAuth: {
        detectAuthStatus: async ({ runDeclaredSystemToolCommand }) => {
          const result = await runDeclaredSystemToolCommand({
            toolId: 'github-cli',
            args: ['auth', 'status'],
            timeoutMs: 1_500,
          });
          return result.ok
            ? { state: 'logged_in', method: 'oauth_cli', source: 'command' }
            : result.exitCode === null
              ? { state: 'unknown', reason: 'probe_failed', source: 'command' }
              : { state: 'logged_out', reason: 'missing_credentials', source: 'command' };
        },
      },
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
    'github-cli': {
      title: 'GitHub CLI',
      executableNames: ['gh'],
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
