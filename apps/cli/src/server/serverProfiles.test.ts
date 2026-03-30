import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('server profiles', () => {
  const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL'] as const;
  let envScope = createEnvKeyScope(envKeys);

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
});
