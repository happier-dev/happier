import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { GROK_UI_TRANSLATIONS } from './ui/translations.js';

const installScript = 'curl -fsSL https://x.ai/cli/install.sh | bash';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.agent.grok',
  version: '0.0.0',
  displayName: 'Grok',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
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
  contributes: {
    agents: [{
      id: 'grok',
      title: { key: 'agentInput.agent.grok', fallback: 'Grok' },
      description: {
        key: 'profiles.aiBackend.grokSubtitleExperimental',
        fallback: 'Grok Build CLI (experimental)',
      },
      runtime: { kind: 'custom' },
      primary: 'sessions',
      capabilities: {
        sessions: {
          open: ['create', 'resume', 'fork'],
          delivery: ['newTurn', 'steer', 'followUp'],
          cancel: true,
          configuration: true,
          conversationRollback: true,
        },
      },
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
    }],
    systemTools: [{ id: 'grok-cli', title: 'Grok Build CLI', executableNames: ['grok'] }],
    ui: {
      translations: [{
        locale: 'en',
        messages: GROK_UI_TRANSLATIONS.en,
      }],
    },
  },
} satisfies PluginManifest;
