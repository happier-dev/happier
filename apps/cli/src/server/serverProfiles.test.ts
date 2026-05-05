import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerUrlComparableKey, deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { configuration, reloadConfiguration } from '@/configuration';
import { readCredentials, writeCredentialsDataKey } from '@/persistence';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

describe('server profiles', () => {
  const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL'] as const;
  let envScope = createEnvKeyScope(envKeys);

  function deriveEnvServerIdFromUrl(url: string): string {
    const raw = String(url ?? '').trim();
    if (!raw) return 'env_0';
    const value = (() => {
      try {
        const comparableKey = createServerUrlComparableKey(raw);
        return comparableKey || raw;
      } catch {
        return raw;
      }
    })();
    let h = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `env_${(h >>> 0).toString(16)}`;
  }

  function deriveLegacyEnvServerIdFromUrl(url: string): string {
    const raw = String(url ?? '').trim().replace(/\/+$/, '');
    if (!raw) return 'env_0';
    let h = 2166136261;
    for (let i = 0; i < raw.length; i += 1) {
      h ^= raw.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `env_${(h >>> 0).toString(16)}`;
  }

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.resetModules();
  });

  it('adds a server profile and can switch active server', async () => {
    await withTempDir('happier-cli-servers-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const {
        addServerProfile,
        getActiveServerProfile,
        useServerProfile,
        listServerProfiles,
      } = await import('./serverProfiles');

      const before = await getActiveServerProfile();
      expect(before.id).toBe('cloud');
      expect(before.name).toBe('Happier Cloud');

      const created = await addServerProfile({
        name: 'selfhost',
        serverUrl: 'https://stack.example.test',
        webappUrl: 'https://app.example.test',
        use: true,
      });
      expect(created.id).toBe('selfhost');

      const active = await getActiveServerProfile();
      expect(active.id).toBe('selfhost');

      await useServerProfile('cloud');
      expect((await getActiveServerProfile()).id).toBe('cloud');

      await useServerProfile('SelfHost');
      expect((await getActiveServerProfile()).id).toBe('selfhost');

      const list = await listServerProfiles();
      expect(list.map((s: { id: string }) => s.id).sort()).toEqual(['cloud', 'selfhost']);
    });
  });

  it('refuses to remove the active server profile unless forced', async () => {
    await withTempDir('happier-cli-servers-remove-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { addServerProfile, getActiveServerProfile, removeServerProfile } = await import('./serverProfiles');

      await addServerProfile({
        name: 'selfhost',
        serverUrl: 'https://stack.example.test',
        webappUrl: 'https://app.example.test',
        use: true,
      });

      expect((await getActiveServerProfile()).id).toBe('selfhost');

      await expect(removeServerProfile('selfhost')).rejects.toThrow(/active/i);

      const out = await removeServerProfile('selfhost', { force: true });
      expect(out.removed.id).toBe('selfhost');
      expect(out.active.id).toBe('cloud');
    });
  });

  it('can resolve a server profile by name without changing the active server', async () => {
    await withTempDir('happier-cli-servers-resolve-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { addServerProfile, getActiveServerProfile, getServerProfile } = await import('./serverProfiles');

      await addServerProfile({
        name: 'selfhost',
        serverUrl: 'https://stack.example.test',
        webappUrl: 'https://app.example.test',
        use: true,
      });

      expect((await getActiveServerProfile()).id).toBe('selfhost');
      expect((await getServerProfile('SelfHost')).id).toBe('selfhost');
      expect((await getActiveServerProfile()).id).toBe('selfhost');
    });
  });

  it('can resolve a server profile by relay URL without changing the active server', async () => {
    await withTempDir('happier-cli-servers-resolve-url-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { addServerProfile, getActiveServerProfile, getServerProfile } = await import('./serverProfiles');

      await addServerProfile({
        name: 'remote-dev-tui',
        serverUrl: 'http://127.0.0.1:52753',
        webappUrl: 'http://127.0.0.1:52753',
        use: true,
      });

      expect((await getActiveServerProfile()).id).toBe('remote-dev-tui');
      expect((await getServerProfile('http://127.0.0.1:52753/')).id).toBe('remote-dev-tui');
      expect((await getActiveServerProfile()).id).toBe('remote-dev-tui');
    });
  });

  it('refuses to create a server profile with reserved name "cloud"', async () => {
    await withTempDir('happier-cli-servers-reserved-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { addServerProfile } = await import('./serverProfiles');

      await expect(
        addServerProfile({
          name: 'cloud',
          serverUrl: 'https://stack.example.test',
          webappUrl: 'https://app.example.test',
        }),
      ).rejects.toThrow(/reserved/i);
    });
  });

  it('sanitizes profile ids to filesystem-safe values', async () => {
    await withTempDir('happier-cli-servers-sanitize-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { addServerProfile } = await import('./serverProfiles');

      const created = await addServerProfile({
        name: '../../escape',
        serverUrl: 'https://stack.example.test',
        webappUrl: 'https://app.example.test',
        use: true,
      });

      expect(created.id).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(created.id.includes('/')).toBe(false);
      expect(created.id.includes('\\')).toBe(false);
      expect(created.id).not.toBe('.');
      expect(created.id).not.toBe('..');
    });
  });

  it('upserts an existing profile when the comparable relay URL already exists', async () => {
    await withTempDir('happier-cli-servers-upsert-url-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { addServerProfile, listServerProfiles, upsertServerProfileByUrl } = await import('./serverProfiles');

      const created = await addServerProfile({
        name: 'selfhost',
        serverUrl: 'https://stack.example.test/relay',
        webappUrl: 'https://app.example.test',
        use: false,
      });

      const updated = await upsertServerProfileByUrl({
        name: 'custom',
        serverUrl: 'https://stack.example.test/api',
        localServerUrl: 'http://127.0.0.1:3012',
        webappUrl: 'https://app.example.test',
        use: true,
      });

      expect(updated.id).toBe(created.id);
      expect(updated.localServerUrl).toBe('http://127.0.0.1:3012');
      expect(await listServerProfiles()).toHaveLength(2);
    });
  });

  it('migrates server-scoped access.key when switching from env-derived serverId to a named profile', async () => {
    await withTempDir('happier-cli-servers-migrate-access-key-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
        HAPPIER_WEBAPP_URL: 'http://localhost:33005',
      });

      vi.resetModules();
      reloadConfiguration();

      const machineKey = new Uint8Array(32).fill(8);
      await writeCredentialsDataKey({
        token: 'token_super_secret',
        publicKey: deriveBoxPublicKeyFromSeed(machineKey),
        machineKey,
      });
      expect(await readCredentials()).not.toBeNull();
      const envDerivedServerId = configuration.activeServerId;
      expect(envDerivedServerId).toBe(deriveEnvServerIdFromUrl('http://127.0.0.1:3005'));
      expect(existsSync(join(homeDir, 'servers', envDerivedServerId, 'access.key'))).toBe(true);

      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      reloadConfiguration();

      const { upsertServerProfileByUrl } = await import('./serverProfiles');

      const created = await upsertServerProfileByUrl({
        name: 'VM A self-host preview',
        serverUrl: 'http://localhost:33005',
        localServerUrl: 'http://127.0.0.1:3005',
        webappUrl: 'http://localhost:33005',
        use: true,
      });

      expect(created.id).not.toBe(envDerivedServerId);
      reloadConfiguration();
      expect(existsSync(join(homeDir, 'servers', created.id, 'access.key'))).toBe(true);
      expect(await readCredentials()).not.toBeNull();
    });
  });

  it('migrates server-scoped access.key from legacy env-derived serverId when selecting a named profile', async () => {
    await withTempDir('happier-cli-servers-migrate-access-key-legacy-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
        HAPPIER_WEBAPP_URL: 'http://localhost:33005',
      });

      vi.resetModules();
      reloadConfiguration();

      const machineKey = new Uint8Array(32).fill(8);
      await writeCredentialsDataKey({
        token: 'token_super_secret',
        publicKey: deriveBoxPublicKeyFromSeed(machineKey),
        machineKey,
      });
      expect(await readCredentials()).not.toBeNull();

      const newEnvDerivedServerId = configuration.activeServerId;
      const legacyEnvDerivedServerId = deriveLegacyEnvServerIdFromUrl('http://127.0.0.1:3005');
      expect(newEnvDerivedServerId).not.toBe(legacyEnvDerivedServerId);

      const newKeyPath = join(homeDir, 'servers', newEnvDerivedServerId, 'access.key');
      const legacyKeyPath = join(homeDir, 'servers', legacyEnvDerivedServerId, 'access.key');
      expect(existsSync(newKeyPath)).toBe(true);
      mkdirSync(join(homeDir, 'servers', legacyEnvDerivedServerId), { recursive: true, mode: 0o700 });
      renameSync(newKeyPath, legacyKeyPath);
      expect(existsSync(newKeyPath)).toBe(false);
      expect(existsSync(legacyKeyPath)).toBe(true);

      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      reloadConfiguration();

      const { upsertServerProfileByUrl } = await import('./serverProfiles');
      const created = await upsertServerProfileByUrl({
        name: 'VM A self-host preview',
        serverUrl: 'http://localhost:33005',
        localServerUrl: 'http://127.0.0.1:3005',
        webappUrl: 'http://localhost:33005',
        use: true,
      });

      reloadConfiguration();
      expect(existsSync(join(homeDir, 'servers', created.id, 'access.key'))).toBe(true);
      expect(await readCredentials()).not.toBeNull();
    });
  });

  it('migrates server-scoped access.key when upserting an existing profile that lacks credentials', async () => {
    await withTempDir('happier-cli-servers-migrate-access-key-upsert-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      reloadConfiguration();

      const { addServerProfile, upsertServerProfileByUrl } = await import('./serverProfiles');
      const existing = await addServerProfile({
        name: 'VM A self-host preview',
        serverUrl: 'http://localhost:33005',
        localServerUrl: 'http://127.0.0.1:3005',
        webappUrl: 'http://localhost:33005',
        use: false,
      });

      expect(existsSync(join(homeDir, 'servers', existing.id, 'access.key'))).toBe(false);

      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
        HAPPIER_WEBAPP_URL: 'http://localhost:33005',
      });

      vi.resetModules();
      reloadConfiguration();

      const machineKey = new Uint8Array(32).fill(8);
      await writeCredentialsDataKey({
        token: 'token_super_secret',
        publicKey: deriveBoxPublicKeyFromSeed(machineKey),
        machineKey,
      });
      expect(await readCredentials()).not.toBeNull();
      const envDerivedServerId = configuration.activeServerId;
      expect(existsSync(join(homeDir, 'servers', envDerivedServerId, 'access.key'))).toBe(true);

      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      reloadConfiguration();

      await upsertServerProfileByUrl({
        name: 'VM A self-host preview',
        serverUrl: 'http://localhost:33005',
        localServerUrl: 'http://127.0.0.1:3005',
        webappUrl: 'http://localhost:33005',
        use: true,
      });

      reloadConfiguration();
      expect(existsSync(join(homeDir, 'servers', existing.id, 'access.key'))).toBe(true);
      expect(await readCredentials()).not.toBeNull();
    });
  });

  it('copies access.key from env-derived serverId when selecting a matching named profile', async () => {
    await withTempDir('happier-cli-servers-migrate-access-key-select-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
        HAPPIER_WEBAPP_URL: 'http://localhost:33005',
      });

      vi.resetModules();
      reloadConfiguration();

      const machineKey = new Uint8Array(32).fill(8);
      await writeCredentialsDataKey({
        token: 'token_super_secret',
        publicKey: deriveBoxPublicKeyFromSeed(machineKey),
        machineKey,
      });
      const envDerivedServerId = configuration.activeServerId;
      expect(existsSync(join(homeDir, 'servers', envDerivedServerId, 'access.key'))).toBe(true);

      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      reloadConfiguration();

      const { addServerProfile, upsertServerProfileByUrl } = await import('./serverProfiles');
      const named = await addServerProfile({
        name: 'VM A self-host preview',
        serverUrl: 'http://localhost:33005',
        localServerUrl: 'http://127.0.0.1:3005',
        webappUrl: 'http://localhost:33005',
        use: false,
      });

      expect(existsSync(join(homeDir, 'servers', named.id, 'access.key'))).toBe(false);

      await upsertServerProfileByUrl({
        name: 'VM A self-host preview',
        serverUrl: 'http://localhost:33005',
        localServerUrl: 'http://127.0.0.1:3005',
        webappUrl: 'http://localhost:33005',
        use: true,
      });

      reloadConfiguration();
      expect(await readCredentials()).not.toBeNull();
      expect(existsSync(join(homeDir, 'servers', named.id, 'access.key'))).toBe(true);
    });
  });

  it('copies access.key from env-derived serverId when using a named profile by id', async () => {
    await withTempDir('happier-cli-servers-migrate-access-key-use-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
        HAPPIER_WEBAPP_URL: 'http://localhost:33005',
      });

      vi.resetModules();
      reloadConfiguration();

      const machineKey = new Uint8Array(32).fill(8);
      await writeCredentialsDataKey({
        token: 'token_super_secret',
        publicKey: deriveBoxPublicKeyFromSeed(machineKey),
        machineKey,
      });
      const envDerivedServerId = configuration.activeServerId;
      expect(existsSync(join(homeDir, 'servers', envDerivedServerId, 'access.key'))).toBe(true);

      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      reloadConfiguration();

      const { addServerProfile, useServerProfile } = await import('./serverProfiles');
      const named = await addServerProfile({
        name: 'VM A self-host preview',
        serverUrl: 'http://localhost:33005',
        localServerUrl: 'http://127.0.0.1:3005',
        webappUrl: 'http://localhost:33005',
        use: false,
      });

      expect(existsSync(join(homeDir, 'servers', named.id, 'access.key'))).toBe(false);

      await useServerProfile(named.id);

      reloadConfiguration();
      expect(await readCredentials()).not.toBeNull();
      expect(existsSync(join(homeDir, 'servers', named.id, 'access.key'))).toBe(true);
    });
  });
});
