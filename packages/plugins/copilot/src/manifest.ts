import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { COPILOT_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { COPILOT_UI_TRANSLATIONS } from './ui/translations.js';

const COPILOT_AUTH_ENV_KEYS = [
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.agent.copilot',
  version: '0.0.0',
  displayName: 'GitHub Copilot',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
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
  contributes: {
    agents: [{
      id: 'copilot',
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
      capabilities: {
        sessions: {
          open: ['create', 'resume'],
          delivery: ['newTurn', 'steer', 'followUp'],
          cancel: true,
        },
      },
    }],
    systemTools: [{
      id: 'copilot-cli',
      title: 'GitHub Copilot CLI',
      executableNames: ['copilot'],
    }],
    ui: {
      translations: [{ locale: 'en', messages: COPILOT_UI_TRANSLATIONS.en }],
    },
    settings: [COPILOT_AGENT_SETTINGS_CONTRIBUTION],
  },
} satisfies PluginManifest;
