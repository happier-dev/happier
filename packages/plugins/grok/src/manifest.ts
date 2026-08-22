import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { AGENT_DEFINITION } from './agent/definition.js';
import { createGrokAgentRuntime } from './agent/runtime/factory.js';
import { GROK_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

const installScript = 'curl -fsSL https://x.ai/cli/install.sh | bash';

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.agent.grok',
  version: '0.0.0',
  displayName: 'Grok',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'grok-process',
      capability: 'process',
      reason: 'Run the declared Grok CLI executable with its declared xAI API-key environment.',
      scope: {
        executables: [{ kind: 'systemTool', id: 'grok-cli' }],
        envKeys: ['XAI_API_KEY'],
      },
    }],
    optional: [],
  },
  agents: {
    grok: {
      declaration: {
        title: { key: 'agentInput.agent.grok', fallback: 'Grok' },
        description: {
          key: 'profiles.aiBackend.grokSubtitleExperimental',
          fallback: 'Grok Build CLI (experimental)',
        },
        runtime: { kind: 'custom' },
        primary: 'sessions',
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'steer', 'followUp'],
            cancel: true,
            configuration: true,
            runtimeActivitySnapshots: true,
            workStateSources: [{ id: 'goals', itemKinds: ['goal'] }],
          },
        }),
        cli: {
          executable: {
            binaryName: 'grok',
            knownUserBinDirSuffixes: ['.grok/bin', '.local/bin'],
            sourcePreference: 'system-first',
            systemCommandResolutionStrategy: 'path-first',
          },
          install: {
            managed: null,
            manual: {
              kind: 'vendor_recipe',
              recipes: {
                darwin: [{ cmd: 'bash', args: ['-lc', installScript] }],
                linux: [{ cmd: 'bash', args: ['-lc', installScript] }],
                win32: [{
                  cmd: 'powershell',
                  args: [
                    '-NoProfile',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-Command',
                    'irm https://x.ai/cli/install.ps1 | iex',
                  ],
                }],
              },
            },
            guideUrl: 'https://x.ai/cli',
            docsUrl: 'https://x.ai',
          },
          auth: {
            support: 'login_terminal',
            probe: {
              parser: 'unknown',
              backgroundChecks: 'safe',
              statusArgs: null,
              envVars: ['XAI_API_KEY'],
            },
            loginLaunches: [
              { kind: 'primary', args: ['login'] },
              { kind: 'device_code', args: ['login', '--device-auth'] },
            ],
          },
        },
      },
      factory: createGrokAgentRuntime,
      sessionRunnerFactory: {
        module: './agent/runtime/factory',
        export: 'createGrokAgentRuntime',
        runtimeApiVersion: 1,
      },
    },
  },
  systemTools: {
    'grok-cli': {
      title: 'Grok Build CLI',
      executableNames: ['grok'],
    },
  },
  ui: {
    translations: GROK_UI_TRANSLATION_BUNDLES,
  },
});
