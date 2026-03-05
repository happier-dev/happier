import { describe, expect, it } from 'vitest';

import { resolveProviderOutgoingMessageMetaExtras, resolveProviderSpawnExtras } from './providerSettings';

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
      ).toEqual({ experimentalCodexAcp: true });
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
    ).toEqual({ experimentalCodexAcp: false });
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
