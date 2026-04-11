import { afterEach, describe, expect, it, vi } from 'vitest';

describe('claudeDirectSessionProviderOps.canonicalizeLinkedSession', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('replaces stale linked configDir values with the current configured Claude configDir', async () => {
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '/tmp/current-claude-config');

    const { claudeDirectSessionProviderOps } = await import('./providerOps');

    await expect(
      claudeDirectSessionProviderOps.canonicalizeLinkedSession?.({
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
