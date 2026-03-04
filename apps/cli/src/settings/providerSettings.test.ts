import { describe, expect, it } from 'vitest';

import { applyProviderSpawnExtrasToProcessEnv, resolveProviderOutgoingMessageMetaExtras } from './providerSettings';

describe('providerSettings', () => {
  it('sets Codex ACP env when account settings request ACP and env is unset', () => {
    const prevAcp = process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;
    try {
      delete process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;

      applyProviderSpawnExtrasToProcessEnv({
        agentId: 'codex',
        settings: { codexBackendMode: 'acp' },
      });

      expect(process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP).toBe('1');
    } finally {
      if (prevAcp === undefined) {
        delete process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;
      } else {
        process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = prevAcp;
      }
    }
  });

  it('does not override existing env overrides', () => {
    const prevAcp = process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;
    try {
      process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = '1';

      applyProviderSpawnExtrasToProcessEnv({
        agentId: 'codex',
        settings: { codexBackendMode: 'mcp' },
      });

      expect(process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP).toBe('1');
    } finally {
      process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = prevAcp;
    }
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
