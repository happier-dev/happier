import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('configuration server selection (persisted settings)', () => {
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
    vi.resetModules();
  });

  it('does not treat remote http URL as localServerUrl when legacy publicServerUrl exists', async () => {
    await withTempDir('happier-cli-config-server-selection-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });

      writeFileSync(
        join(homeDir, 'settings.json'),
        JSON.stringify(
          {
            schemaVersion: 5,
            onboardingCompleted: true,
            activeServerId: 's1',
            servers: {
              s1: {
                id: 's1',
                name: 'Selfhost',
                serverUrl: 'http://public.example.test',
                publicServerUrl: 'https://public.example.test',
                webappUrl: 'https://app.happier.dev',
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

      const configMod = await import('@/configuration');
      configMod.reloadConfiguration();

      expect(configMod.configuration.serverUrl).toBe('https://public.example.test');
      expect(configMod.configuration.apiServerUrl).toBe('https://public.example.test');
    });
  });

  it('reuses persisted server id/credentials when env public+local URLs point at the same server', async () => {
    await withTempDir('happier-cli-config-server-selection-', async (homeDir) => {
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
      expect(configMod.configuration.activeServerId).toBe('s_local');

      const persistence = await import('@/persistence');
      const creds = await persistence.readCredentials();
      expect(creds?.token).toBe('token-1');
    });
  });

  it('prefers the credentialed local server id when a public alias profile exists without credentials', async () => {
    await withTempDir('happier-cli-config-server-selection-', async (homeDir) => {
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
              s_public: {
                id: 's_public',
                name: 'Public alias',
                serverUrl: 'http://host.lima.internal:53288',
                localServerUrl: 'http://127.0.0.1:53288',
                webappUrl: 'http://localhost:53288',
                createdAt: 2,
                updatedAt: 2,
                lastUsedAt: 2,
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
      expect(configMod.configuration.activeServerId).toBe('s_local');

      const persistence = await import('@/persistence');
      const creds = await persistence.readCredentials();
      expect(creds?.token).toBe('token-1');
    });
  });

  it('preserves the explicit runtime server id while resolving persisted public+local aliases', async () => {
    await withTempDir('happier-cli-config-server-selection-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:53288',
        HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:53288',
        HAPPIER_PUBLIC_SERVER_URL: 'http://host.lima.internal:53288',
        HAPPIER_WEBAPP_URL: undefined,
        // Simulate a wrapper-provided derived id for --server-url (not present in settings.json).
        HAPPIER_ACTIVE_SERVER_ID: 'env_deadbeef',
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
              s_public: {
                id: 's_public',
                name: 'Public alias',
                serverUrl: 'http://host.lima.internal:53288',
                localServerUrl: 'http://127.0.0.1:53288',
                webappUrl: 'http://localhost:53288',
                createdAt: 2,
                updatedAt: 2,
                lastUsedAt: 2,
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const serversDir = join(homeDir, 'servers', 'env_deadbeef');
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
      expect(configMod.configuration.activeServerId).toBe('env_deadbeef');

      const persistence = await import('@/persistence');
      const creds = await persistence.readCredentials();
      expect(creds?.token).toBe('token-1');
    });
  });

  it('preserves an explicit runtime server id for equivalent persisted loopback aliases', async () => {
    await withTempDir('happier-cli-config-loopback-alias-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:53288',
        HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:53288',
        HAPPIER_PUBLIC_SERVER_URL: 'http://happier-stack.localhost:53288',
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: 'env_deadbeef',
      });

      writeFileSync(
        join(homeDir, 'settings.json'),
        JSON.stringify(
          {
            schemaVersion: 5,
            onboardingCompleted: true,
            activeServerId: 'stack_local',
            servers: {
              stack_local: {
                id: 'stack_local',
                name: 'Stack local',
                serverUrl: 'http://localhost:53288',
                localServerUrl: 'http://127.0.0.1:53288',
                webappUrl: 'http://happier-stack.localhost:53288',
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

      const serversDir = join(homeDir, 'servers', 'env_deadbeef');
      mkdirSync(serversDir, { recursive: true });
      writeFileSync(
        join(serversDir, 'access.key'),
        JSON.stringify(
          {
            token: 'token-loopback',
            encryption: {
              publicKey: Buffer.alloc(32, 3).toString('base64'),
              machineKey: Buffer.alloc(32, 4).toString('base64'),
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const configMod = await import('@/configuration');
      configMod.reloadConfiguration();

      expect(configMod.configuration.activeServerId).toBe('env_deadbeef');
      expect(configMod.configuration.serverUrl).toBe('http://happier-stack.localhost:53288');
      expect(configMod.configuration.apiServerUrl).toBe('http://127.0.0.1:53288');

      const persistence = await import('@/persistence');
      const creds = await persistence.readCredentials();
      expect(creds?.token).toBe('token-loopback');
    });
  });
});
