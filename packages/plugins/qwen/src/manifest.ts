import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.agent.qwen',
  version: '0.0.0',
  displayName: 'Qwen Code',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: 'qwen-process',
      capability: 'process',
      reason: 'Run the declared Qwen CLI executable.',
      scope: { executables: [{ kind: 'systemTool', id: 'qwen-cli' }] },
    }],
    optional: [],
  },
  contributes: {
    agents: [{
      id: 'qwen',
      title: 'Qwen Code',
      runtime: { kind: 'custom' },
      cli: {
        displayName: 'Qwen CLI',
        executable: {
          binaryName: 'qwen',
          knownUserBinDirSuffixes: null,
          sourcePreference: 'system-first',
        },
        install: {
          managed: {
            kind: 'managed_package',
            packageName: '@qwen-code/qwen-code',
            binaryName: 'qwen',
          },
          manual: { kind: 'command' },
          guideUrl: 'https://qwenlm.github.io/qwen-code-docs/',
          docsUrl: null,
        },
        auth: {
          support: 'login_terminal',
          probe: { parser: 'unknown', backgroundChecks: 'safe', statusArgs: null },
          loginLaunches: [{ kind: 'primary', args: [], initialInput: '/auth\r' }],
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
    systemTools: [{ id: 'qwen-cli', title: 'Qwen Code CLI', executableNames: ['qwen'] }],
  },
} satisfies PluginManifest;
