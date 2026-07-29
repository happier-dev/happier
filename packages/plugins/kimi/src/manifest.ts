import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { HAPPIER_KIMI_ACP_SELECTOR_ENV } from './agent/preferences/pythonSelector.js';
import { KIMI_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2, id: 'happier.agent.kimi', version: '0.0.0', displayName: 'Kimi',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './dist/index.js' },
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
  contributes: {
    agents: [{
      id: 'kimi',
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
          probe: { parser: 'unknown', backgroundChecks: 'safe', statusArgs: null },
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
    systemTools: [{ id: 'kimi-cli', title: 'Kimi CLI', executableNames: ['kimi', 'kimi-cli'] }],
    hooks: [{ id: 'resolve-prerequisites', on: 'agent.resolvePrerequisites', category: 'decision', scope: 'agent', filters: { agentId: 'kimi' }, executionKind: 'decide' }],
    settings: [KIMI_AGENT_SETTINGS_CONTRIBUTION],
  },
} satisfies PluginManifest;
