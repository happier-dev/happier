import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

const { mockPost } = vi.hoisted(() => ({
  mockPost: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    post: mockPost,
  },
}));

describe('approveTerminalAuthRequest', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_ACTIVE_SERVER_ID',
  ] as const;

  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    mockPost.mockReset();
    vi.resetModules();
  });

  it('posts approval response to apiServerUrl when local override is present', async () => {
    await withTempDir('happier-cli-terminal-auth-approval-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:53288',
        HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:53288',
        HAPPIER_PUBLIC_SERVER_URL: 'http://host.lima.internal:53288',
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });

      writeFileSync(
        join(homeDir, 'settings.json'),
        JSON.stringify(
          {
            schemaVersion: 5,
            onboardingCompleted: true,
            activeServerId: 's_local',
            servers: {
              s_local: {
                id: 's_local',
                name: 'Local dev',
                serverUrl: 'http://127.0.0.1:53288',
                webappUrl: 'http://localhost:53288',
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: 1,
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const serversDir = join(homeDir, 'servers', 's_local');
      mkdirSync(serversDir, { recursive: true });
      writeFileSync(
        join(serversDir, 'access.key'),
        JSON.stringify(
          {
            token: 'token-1',
            encryption: {
              publicKey: Buffer.alloc(32, 1).toString('base64'),
              machineKey: Buffer.alloc(32, 2).toString('base64'),
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const configMod = await import('@/configuration');
      configMod.reloadConfiguration();
      expect(configMod.configuration.serverUrl).toBe('http://host.lima.internal:53288');
      expect(configMod.configuration.apiServerUrl).toBe('http://127.0.0.1:53288');

      mockPost.mockResolvedValueOnce({ status: 200, data: {} });

      const approval = await import('./terminalAuthApproval');
      const terminalPublicKey = Buffer.alloc(32, 3).toString('base64');
      await approval.approveTerminalAuthRequest({ publicKey: terminalPublicKey });

      expect(mockPost).toHaveBeenCalledTimes(1);
      const [url] = mockPost.mock.calls[0] ?? [];
      expect(url).toBe('http://127.0.0.1:53288/v1/auth/response');
    });
  });

  it('reports a typed upgrade requirement for token-only credentials without posting a keyed response', async () => {
    await withTempDir('happier-cli-terminal-auth-approval-token-only-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'https://api.happier.dev',
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });

      const configMod = await import('@/configuration');
      configMod.reloadConfiguration();
      const persistence = await import('@/persistence');
      await persistence.writeCredentialsTokenOnly({ token: 'token-only-1' });

      const approval = await import('./terminalAuthApproval');
      const terminalPublicKey = Buffer.alloc(32, 3).toString('base64');
      await expect(
        approval.approveTerminalAuthRequest({ publicKey: terminalPublicKey }),
      ).rejects.toMatchObject({
        name: 'TokenOnlyTerminalApprovalUpgradeRequiredError',
        code: 'TOKEN_ONLY_TERMINAL_APPROVAL_UPGRADE_REQUIRED',
      });
      expect(mockPost).not.toHaveBeenCalled();
    });
  });
});
