import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { describe, expect, it } from 'vitest';

import { DEVIN_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Devin plugin manifest', () => {
  it('declares the probed Devin CLI and host-owned ACP runtime contract', () => {
    const publicManifest = parsePluginManifest(PLUGIN_MANIFEST);
    expect(publicManifest.ok).toBe(true);
    expect(PLUGIN_MANIFEST).toMatchObject({
      id: 'happier.agent.devin',
      entrypoints: { daemon: './.happier-plugin/daemon.js' },
      hostAccess: {
        required: [{
          id: 'devin-oauth',
          capability: 'network',
          scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.devin.ai' }], methods: ['GET', 'POST'] },
        }, {
          id: 'devin-process',
          capability: 'process',
          scope: {
            executables: [{ kind: 'systemTool', id: 'devin-cli' }],
            envKeys: ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'APPDATA', 'WINDSURF_API_KEY', 'HAPPIER_DEVIN_NATIVE_DATA_HOME'],
          },
        }, {
          id: 'devin-native-history',
          capability: 'filesystem',
          scope: { locations: [{ root: 'workspace' }], access: ['read'] },
        }],
        optional: [],
      },
      contributes: {
        agents: [{
          id: 'devin',
          primary: 'sessions',
          surfaces: {
            externalSession: { sources: [expect.objectContaining({ sourceKind: 'devinHome', contentSearch: true })] },
          },
          runtime: {
            kind: 'acp',
            transport: {
              kind: 'stdio',
              executable: { kind: 'systemTool', id: 'devin-cli' },
              args: ['acp'],
            },
            definition: {
              modelConfigOptionId: 'model',
              mcp: {
                policy: 'drop',
                nativeSessionConfig: { directory: 'devin', fileName: 'mcp_config.json' },
              },
              permissionModeMapping: { default: null, 'safe-yolo': 'smart' },
            },
          },
          capabilities: {
            surfaces: expect.arrayContaining(['terminal', 'externalSessions']),
            sessions: {
              open: ['create', 'resume'],
              delivery: ['newTurn', 'followUp'],
              cancel: true,
              configuration: true,
            },
            tools: { delivery: 'native_mcp' },
          },
          cli: {
            executable: {
              binaryName: 'devin',
              knownUserBinDirSuffixes: ['.local/bin'],
              sourcePreference: 'system-first',
              systemCommandResolutionStrategy: 'path-first',
            },
            auth: {
              support: 'login_terminal',
              nonInteractiveStatusProbe: true,
              loginLaunches: [{ kind: 'primary', args: ['auth', 'login'] }],
            },
          },
        }],
        systemTools: [{ id: 'devin-cli', executableNames: ['devin'] }],
        settings: [DEVIN_AGENT_SETTINGS_CONTRIBUTION],
      },
    });
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.capabilities).toHaveProperty('tools', {
      delivery: 'native_mcp',
    });
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.cli.auth).not.toHaveProperty('probe');
  });
});
