import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('server profile observations', () => {
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_ACTIVE_SERVER_ID']);
  afterEach(() => {
    env.restore();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('imports the 0.2 timestamp once before retiring it from a settings publication', async () => {
    await withTempDir('happier-profile-predecessor-', async homeDir => {
      env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
      const path = join(homeDir, 'settings.json');
      // 0.2 persistence.ts Settings.servers and serverProfiles.ts coerceProfile.
      const predecessor = { schemaVersion: 6, onboardingCompleted: true, activeServerId: 'old', servers: {
        old: { id: 'old', name: 'old', serverUrl: 'https://old.example.test', webappUrl: 'https://old.example.test',
          createdAt: 1, updatedAt: 1, lastUsedAt: 123 },
      } };
      await writeFile(path, JSON.stringify(predecessor));
      const { updateSettings } = await import('@/persistence');
      await updateSettings(settings => ({ ...settings, chromeMode: true }));
      expect(JSON.parse(await readFile(path, 'utf8')).servers.old).not.toHaveProperty('lastUsedAt');
      vi.resetModules();
      expect((await (await import('./serverProfiles')).getServerProfile('old')).lastUsedAt).toBe(123);
      await writeFile(path, JSON.stringify({ ...predecessor, servers: {
        old: { ...predecessor.servers.old, lastUsedAt: 456 },
      } }));
      vi.resetModules();
      expect((await (await import('./serverProfiles')).getServerProfile('old')).lastUsedAt).toBe(123);
    });
  });

  it('preserves deliberate selection and profile edit time, then retires removed usage', async () => {
    await withTempDir('happier-profile-removal-', async homeDir => {
      env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
      const profiles = await import('./serverProfiles');
      const options = { name: 'retired', serverUrl: 'https://retired.example.test', webappUrl: 'https://retired.example.test' };
      const first = await profiles.addServerProfile({ ...options, use: true });
      const other = await profiles.addServerProfile({ name: 'other', serverUrl: 'https://other.example.test', webappUrl: 'https://other.example.test', use: true });
      expect((await profiles.useServerProfile(first.id)).updatedAt).toBe(first.updatedAt);
      expect((await profiles.getActiveServerProfile()).id).toBe(first.id);
      const firstUsage = (await profiles.getServerProfile(first.id)).lastUsedAt;
      expect((await profiles.upsertServerProfileByUrl(options)).lastUsedAt).toBe(firstUsage);
      await profiles.useServerProfile(other.id);
      expect((await profiles.removeServerProfile(first.id)).removed.lastUsedAt).toBe(firstUsage);
      expect(JSON.parse(await readFile(join(homeDir, 'server-profile-observations.json'), 'utf8'))).not.toHaveProperty(first.id);
      expect((await profiles.addServerProfile(options)).lastUsedAt).toBe(0);
      expect((await profiles.getActiveServerProfile()).id).toBe(other.id);
    });
  });

  // F10: selecting a Home is a preference; the time it was used is device-local state.
  it.each(['use', 'add', 'upsert', 'descriptor', 'endpoints'] as const)(
    'persists %s usage outside settings and reads it after a fresh module load', async operation => {
      await withTempDir('happier-profile-observations-', async homeDir => {
        env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined,
          HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
        vi.resetModules();
        const profiles = await import('./serverProfiles');
        const options = { name: 'observed', serverUrl: 'https://observed.example.test', webappUrl: 'https://observed.example.test' };
        const created = await profiles.addServerProfile({ ...options, use: true });
        const settingsPath = join(homeDir, 'settings.json');
        const before = await readFile(settingsPath, 'utf8');
        const beforeStat = await stat(settingsPath);
        const now = Date.now() + 10_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const result = operation === 'use' ? await profiles.useServerProfile(created.id)
          : operation === 'add' ? await profiles.addServerProfile({ ...options, use: true })
          : operation === 'upsert' ? await profiles.upsertServerProfileByUrl({ ...options, use: true })
          : operation === 'endpoints' ? await profiles.setServerProfileEndpointsById({ ...options, id: created.id, use: true })
          : (await profiles.adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: created.id, use: true,
            observation: 'exact', descriptor: { v: 1, homeServerIdentityId: 'srv_observed', canonicalServerUrl: options.serverUrl,
              revision: 1, endpoints: [{ kind: 'https', url: options.serverUrl }] } })).profile;
        expect(result.lastUsedAt).toBe(now);
        const raw = JSON.parse(await readFile(settingsPath, 'utf8'));
        expect(raw.activeServerId).toBe(created.id);
        expect(raw.servers[created.id]).not.toHaveProperty('lastUsedAt');
        if (operation !== 'descriptor') {
          expect(await readFile(settingsPath, 'utf8')).toBe(before);
          expect((await stat(settingsPath)).mtimeMs).toBe(beforeStat.mtimeMs);
        }
        vi.restoreAllMocks();
        vi.resetModules();
        expect((await (await import('./serverProfiles')).getServerProfile(created.id)).lastUsedAt).toBe(now);
      });
    },
  );
});
