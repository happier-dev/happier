import { afterEach, describe, expect, it, vi } from 'vitest';

describe('claudeExternalSessionProviderOps.canonicalizeLinkedSession', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('replaces stale linked configDir values with the current configured Claude configDir', async () => {
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '/tmp/current-claude-config');

    const { claudeExternalSessionProviderOps } = await import('./providerOps');

    await expect(
      claudeExternalSessionProviderOps.canonicalizeLinkedSession?.({
        metadata: {},
        remoteSessionId: 'claude-session',
        source: {
          kind: 'claudeConfig',
          configDir: '/tmp/stale-claude-config',
          projectId: 'proj-linked',
        },
      }),
    ).resolves.toEqual({
      remoteSessionId: 'claude-session',
      source: {
        kind: 'claudeConfig',
        configDir: '/tmp/current-claude-config',
        projectId: 'proj-linked',
      },
    });
  });
});
