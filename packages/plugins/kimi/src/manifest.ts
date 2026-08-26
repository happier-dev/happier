import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { HookHandler } from '@happier-dev/plugin-sdk/hooks';

import { AGENT_DEFINITION } from './agent/definition.js';
import { resolveKimiDaemonSpawnPrerequisites } from './agent/lifecycle/spawnHooks.js';
import { HAPPIER_KIMI_ACP_SELECTOR_ENV } from './agent/preferences/pythonSelector.js';
import { resolveKimiSessionRuntimePreferences } from './agent/preferences/session.js';
import { createKimiAgentRuntime } from './agent/runtime/factory.js';
import { KIMI_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

const resolveKimiDaemonSpawnPrerequisitesHook: HookHandler = (event, context) =>
  resolveKimiDaemonSpawnPrerequisites(event, context);

const {
  id: KIMI_AGENT_SETTINGS_CONTRIBUTION_ID,
  ...KIMI_AGENT_SETTINGS_DECLARATION
} = KIMI_AGENT_SETTINGS_CONTRIBUTION;

export const KIMI_PLUGIN = definePlugin({
  id: 'happier.agent.kimi',
  version: '0.0.0',
  displayName: 'Kimi',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'kimi-process',
      capability: 'process',
      reason: 'Run the declared Kimi CLI executable.',
      scope: {
        executables: [{ kind: 'systemTool', id: 'kimi-cli' }],
        envKeys: [HAPPIER_KIMI_ACP_SELECTOR_ENV, 'PYTHONPATH'],
      },
    }],
    optional: [],
  },
  agents: {
    kimi: {
      declaration: {
        title: 'Kimi',
        runtime: { kind: 'custom' },
        cli: {
          displayName: 'Kimi CLI',
          executable: {
            binaryName: 'kimi',
            knownUserBinDirSuffixes: ['.local/bin'],
            sourcePreference: 'system-first',
          },
          install: {
            managed: null,
            manual: {
              kind: 'vendor_recipe',
              recipes: {
                darwin: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://code.kimi.com/install.sh | bash'] }],
                linux: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://code.kimi.com/install.sh | bash'] }],
                win32: [{
                  cmd: 'powershell',
                  args: [
                    '-NoProfile',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-Command',
                    'Invoke-RestMethod https://code.kimi.com/install.ps1 | Invoke-Expression',
                  ],
                }],
              },
            },
            guideUrl: 'https://kimi.moonshot.cn/docs/cli',
            docsUrl: 'https://code.kimi.com',
          },
          auth: {
            support: 'login_terminal',
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
      factory: createKimiAgentRuntime,
      cliSessionCommand: {
        sessionRuntimeId: 'kimi',
        accountSettingsAgentId: 'kimi',
        buildSessionOptions: (input) => ({
          ok: true,
          options: resolveKimiSessionRuntimePreferences({
            settings: input.settings,
            environment: input.environment,
          }),
        }),
      },
      sessionRunnerFactory: {
        module: './agent/runtime/factory',
        export: 'createKimiAgentRuntime',
        runtimeApiVersion: 1,
      },
    },
  },
  systemTools: {
    'kimi-cli': { title: 'Kimi CLI', executableNames: ['kimi', 'kimi-cli'] },
  },
  hooks: {
    'resolve-prerequisites': {
      declaration: {
        on: 'agent.resolvePrerequisites',
        hookApiVersion: 1,
        category: 'decision',
        scope: 'agent',
        filters: { agentId: 'kimi' },
        executionKind: 'decide',
      },
      handler: resolveKimiDaemonSpawnPrerequisitesHook,
    },
  },
  settings: {
    [KIMI_AGENT_SETTINGS_CONTRIBUTION_ID]: KIMI_AGENT_SETTINGS_DECLARATION,
  },
});

export const PLUGIN_MANIFEST = KIMI_PLUGIN.manifest;
