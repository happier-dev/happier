import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { describe, expect, it } from 'vitest';

import { DEVIN_ACP_RUNTIME_DECLARATION } from './runtimeDeclaration.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';

describe('Devin declarative ACP runtime', () => {
  it('launches the probed Devin ACP command through the declared system tool', () => {
    expect(DEVIN_ACP_RUNTIME_DECLARATION).toMatchObject({
      kind: 'acp',
      transport: {
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'devin-cli' },
        args: ['acp'],
      },
    });
  });

  it('maps explicit Happier permissions and leaves Devin default configuration untouched', () => {
    expect(DEVIN_ACP_RUNTIME_DECLARATION.definition.permissionModeMapping).toEqual({
      default: null,
      'read-only': 'ask',
      'safe-yolo': 'smart',
      yolo: 'bypass',
      plan: 'plan',
    });
  });

  it('drops ACP MCP input only because Devin receives the same servers natively', () => {
    expect(DEVIN_ACP_RUNTIME_DECLARATION.definition.mcp).toMatchObject({
      policy: 'drop',
      nativeSessionConfig: {
        configRootEnvKey: { posix: 'XDG_CONFIG_HOME', win32: 'APPDATA' },
        directory: 'devin',
        fileName: 'mcp_config.json',
        serversKey: 'mcpServers',
        serverEntryConstants: { transport: 'stdio' },
      },
    });
  });

  it('rejects native MCP delivery declared beside a pass-through input policy', () => {
    const parsed = parsePluginManifest({
      ...PLUGIN_MANIFEST,
      contributes: {
        ...PLUGIN_MANIFEST.contributes,
        agents: PLUGIN_MANIFEST.contributes.agents.map((agent) => (
          agent.id === 'devin'
            ? {
              ...agent,
              runtime: {
                ...DEVIN_ACP_RUNTIME_DECLARATION,
                definition: {
                  ...DEVIN_ACP_RUNTIME_DECLARATION.definition,
                  mcp: {
                    policy: 'pass_through',
                    nativeSessionConfig:
                      DEVIN_ACP_RUNTIME_DECLARATION.definition.mcp.nativeSessionConfig,
                  },
                },
              },
            }
            : agent
        )),
      },
    });
    expect(parsed.ok).toBe(false);
  });

  it('declares reasoning and Speed projection for Devin combined model identifiers', () => {
    expect(DEVIN_ACP_RUNTIME_DECLARATION.definition.models.suffixOption).toMatchObject({
      id: 'reasoning_effort',
      trailingOption: {
        id: 'service_tier',
        name: 'Speed',
        defaultValue: { value: 'standard', name: 'Standard' },
        values: [
          { segment: 'fast', value: 'fast', name: 'Fast' },
          { segment: 'priority', value: 'priority', name: 'Fast' },
        ],
      },
    });
    expect(
      DEVIN_ACP_RUNTIME_DECLARATION.definition.models.suffixOption.values
        .map((value) => value.value),
    ).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
});
