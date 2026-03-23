import { describe, expect, it } from 'vitest';

import {
  resolveProviderOutgoingMessageMetaExtras,
  resolveProviderSpawnExtras,
  resolveProviderSpawnExtrasForRuntime,
} from './providerSettings';

describe('providerSettings', () => {
  it('resolves Codex ACP spawn extras from account settings without mutating process env', () => {
    const prevAcp = process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;
    process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = '0';

    try {
      expect(
        resolveProviderSpawnExtras({
          agentId: 'codex',
          settings: { codexBackendMode: 'acp' },
        }),
      ).toEqual({ codexBackendMode: 'acp', experimentalCodexAcp: true });
      expect(process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP).toBe('0');
    } finally {
      if (prevAcp === undefined) {
        delete process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;
      } else {
        process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = prevAcp;
      }
    }
  });

  it('resolves Codex MCP spawn extras when account settings disable ACP', () => {
    expect(
      resolveProviderSpawnExtras({
        agentId: 'codex',
        settings: { codexBackendMode: 'mcp' },
      }),
    ).toEqual({ codexBackendMode: 'mcp' });
  });

  it('does not enable ACP spawn extras when Codex backend mode is appServer', () => {
    expect(
      resolveProviderSpawnExtras({
        agentId: 'codex',
        settings: { codexBackendMode: 'appServer' },
      }),
    ).toEqual({ codexBackendMode: 'appServer' });
  });

  it('keeps Codex runtime spawn extras on the canonical backend mode path for ACP settings', () => {
    expect(
      resolveProviderSpawnExtrasForRuntime({
        agentId: 'codex',
        settings: { codexBackendMode: 'acp' },
        processEnv: {},
      }),
    ).toEqual({ codexBackendMode: 'acp' });
  });

  it('lets an explicit Codex ACP env override win over account settings at runtime', () => {
    expect(
      resolveProviderSpawnExtrasForRuntime({
        agentId: 'codex',
        settings: { codexBackendMode: 'acp' },
        processEnv: { HAPPIER_EXPERIMENTAL_CODEX_ACP: '0' },
      }),
    ).toEqual({});
  });

  it('lets an explicit Codex backend mode env override win over account settings at runtime', () => {
    expect(
      resolveProviderSpawnExtrasForRuntime({
        agentId: 'codex',
        settings: { codexBackendMode: 'acp' },
        processEnv: { HAPPIER_CODEX_BACKEND_MODE: 'appServer' },
      }),
    ).toEqual({ codexBackendMode: 'appServer' });
  });

  it('keeps Codex runtime extras pinned to MCP when fallback publishes mcp into env', () => {
    expect(
      resolveProviderSpawnExtrasForRuntime({
        agentId: 'codex',
        settings: { codexBackendMode: 'acp' },
        processEnv: { HAPPIER_CODEX_BACKEND_MODE: 'mcp' },
      }),
    ).toEqual({ codexBackendMode: 'mcp' });
  });

  it('builds Claude outgoing meta defaults from account settings', () => {
    const extras = resolveProviderOutgoingMessageMetaExtras({
      agentId: 'claude',
      settings: {
        claudeRemoteAgentSdkEnabled: true,
        claudeRemoteSettingSourcesV2: ['user', 'project', 'local'],
        claudeRemoteAdvancedOptionsJson: '{\"plugins\":[]}',
      },
      session: null,
    });

    expect(extras.claudeRemoteAgentSdkEnabled).toBe(true);
    expect(extras.claudeRemoteSettingSourcesV2).toEqual(['user', 'project', 'local']);
    expect(extras.claudeRemoteSettingSources).toBeUndefined();
    // Normalized JSON.
    expect(extras.claudeRemoteAdvancedOptionsJson).toBe('{\"plugins\":[]}');
  });
});
