import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

// Transform the real selection graph before per-test environment isolation.
await import('./serverSelection');

async function seedFocusedProfile() {
  const { setServerProfileEndpointsById } = await import('./serverProfiles');
  await setServerProfileEndpointsById({ id: 'focused-home', serverUrl: 'https://focused.example.test',
    webappUrl: 'https://focused.example.test', use: true });
}

describe('server selection flags', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.resetModules();
  });

  it('does not persist when --server-url is used (default)', async () => {
    await withTempDir('happier-cli-server-select-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { applyServerSelectionFromArgs } = await import('./serverSelection');
      const { getActiveServerProfile } = await import('./serverProfiles');
      const config = await import('@/configuration');

      await seedFocusedProfile();
      const remaining = await applyServerSelectionFromArgs(['--server-url', 'https://stack.example.test']);
      expect(remaining).toEqual([]);
      expect(config.configuration.serverUrl).toBe('https://stack.example.test');
      expect(config.configuration.webappUrl).toBe('https://stack.example.test');
      expect(process.env.HAPPIER_WEBAPP_URL).toBe('https://stack.example.test');
      expect((await getActiveServerProfile()).id).toBe('focused-home');
    });
  });

  it('supports --local-server-url to keep deep links canonical while using local API (no persist)', async () => {
    await withTempDir('happier-cli-server-select-local-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
      });

      vi.resetModules();
      const { applyServerSelectionFromArgs } = await import('./serverSelection');
      const config = await import('@/configuration');

      const remaining = await applyServerSelectionFromArgs([
        '--server-url',
        'https://stack.example.test',
        '--local-server-url',
        'http://127.0.0.1:53545',
      ]);
      expect(remaining).toEqual([]);
      expect(config.configuration.serverUrl).toBe('https://stack.example.test');
      expect((config.configuration as any).apiServerUrl).toBe('http://127.0.0.1:53545');
      expect(process.env.HAPPIER_PUBLIC_SERVER_URL).toBe('https://stack.example.test');
      expect(process.env.HAPPIER_SERVER_URL).toBe('http://127.0.0.1:53545');
      expect(process.env.HAPPIER_LOCAL_SERVER_URL).toBe('http://127.0.0.1:53545');
    });
  });

  it('persists a new server profile when --server-url is used with --persist', async () => {
    await withTempDir('happier-cli-server-select-persist-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { applyServerSelectionFromArgs } = await import('./serverSelection');
      const { getActiveServerProfile } = await import('./serverProfiles');
      const config = await import('@/configuration');

      const remaining = await applyServerSelectionFromArgs(['--server-url', 'https://stack.example.test', '--persist']);
      expect(remaining).toEqual([]);
      expect(config.configuration.serverUrl).toBe('https://stack.example.test');
      const active = await getActiveServerProfile();
      expect(active.serverUrl).toBe('https://stack.example.test');
      expect(active.webappUrl).toBe('https://stack.example.test');
      expect(config.configuration.webappUrl).toBe('https://stack.example.test');

      const settingsRaw = JSON.parse(readFileSync(join(homeDir, 'settings.json'), 'utf8'));
      expect(settingsRaw.schemaVersion).toBe(6);
      expect(settingsRaw.activeServerId).not.toBe('cloud');
    });
  });

  it('persists deterministic URL metadata without replacing the active profile while applying it ephemerally', async () => {
    await withTempDir('happier-cli-server-select-non-focusing-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { resolveServerSelectionFromArgs, applyResolvedServerSelectionNonFocusing } = await import('./serverSelection');
      const { getActiveServerProfile, listServerProfiles } = await import('./serverProfiles');
      const config = await import('@/configuration');
      await seedFocusedProfile();
      const before = await getActiveServerProfile();
      const resolution = await resolveServerSelectionFromArgs([
        '--server-url',
        'https://pending.example.test',
        '--persist',
      ]);
      expect(resolution.selection).not.toBeNull();

      const applied = await applyResolvedServerSelectionNonFocusing(resolution.selection!);

      expect((await getActiveServerProfile()).id).toBe(before.id);
      expect(applied.profileId).not.toBe(before.id);
      expect(config.configuration.serverUrl).toBe('https://pending.example.test');
      expect(config.configuration.activeServerId).toBe(applied.profileId);
      expect((await listServerProfiles()).some((profile) => profile.id === applied.profileId)).toBe(true);
    });
  });

  it('reuses an existing matching server profile when --server-url is used with --persist', async () => {
    await withTempDir('happier-cli-server-select-persist-existing-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { addServerProfile, getActiveServerProfile, listServerProfiles } = await import('./serverProfiles');
      await addServerProfile({
        name: 'company',
        serverUrl: 'https://stack.example.test',
        webappUrl: 'https://stack.example.test',
        use: true,
      });

      const before = await getActiveServerProfile();
      expect(before.id).not.toBe('cloud');

      const { applyServerSelectionFromArgs } = await import('./serverSelection');
      await applyServerSelectionFromArgs(['--server-url', 'https://stack.example.test', '--persist']);

      const after = await getActiveServerProfile();
      expect(after.id).toBe(before.id);
      const { configuration } = await import('@/configuration');
      expect(configuration.activeServerId).toBe(before.id);

      const profiles = await listServerProfiles();
      expect(profiles.filter((profile) => profile.serverUrl === 'https://stack.example.test')).toHaveLength(1);
    });
  });

  it('rejects --persist and --no-persist together', async () => {
    await withTempDir('happier-cli-server-select-both-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { applyServerSelectionFromArgs } = await import('./serverSelection');

      await expect(
        applyServerSelectionFromArgs(['--server-url', 'https://stack.example.test', '--persist', '--no-persist']),
      ).rejects.toThrow('Cannot use --persist and --no-persist together');
    });
  });

  it('supports ephemeral prefix server selection without persisting settings', async () => {
    await withTempDir('happier-cli-server-prefix-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();

      const { addServerProfile } = await import('./serverProfiles');
      await seedFocusedProfile();
      await addServerProfile({
        name: 'company',
        serverUrl: 'https://company.example.test',
        webappUrl: 'https://app.company.example.test',
        use: false,
      });

      const selectionMod: any = await import('./serverSelection');
      expect(typeof selectionMod.applyEphemeralServerSelectionFromPrefixArgs).toBe('function');

      const resolution = await selectionMod.applyEphemeralServerSelectionFromPrefixArgs(['--server', 'company', 'doctor']);
      expect(resolution.rest).toEqual(['doctor']);
      expect(resolution.selection).toMatchObject({
        activeServerId: 'company',
        application: { kind: 'ephemeralEnv' },
        homeTarget: { profileId: 'company', homeServerIdentityId: null },
      });

      const config = await import('@/configuration');
      expect(config.configuration.serverUrl).toBe('https://company.example.test');
      expect(config.configuration.webappUrl).toBe('https://app.company.example.test');

      const settingsRaw = JSON.parse(readFileSync(join(homeDir, 'settings.json'), 'utf8'));
      expect(settingsRaw.activeServerId).toBe('focused-home');
    });
  });

  it('sets active id for prefix profile selection despite a stale matching env id', async () => {
    await withTempDir('happier-cli-server-prefix-stale-env-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: 'stale-profile',
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();

      const { addServerProfile, getActiveServerProfile } = await import('./serverProfiles');
      await seedFocusedProfile();
      await addServerProfile({
        name: 'stale profile',
        serverUrl: 'https://company.example.test',
        webappUrl: 'https://stale.company.example.test',
        use: false,
      });
      await addServerProfile({
        name: 'company',
        serverUrl: 'https://company.example.test',
        webappUrl: 'https://app.company.example.test',
        use: false,
      });

      const { applyEphemeralServerSelectionFromPrefixArgs } = await import('./serverSelection');
      const resolution = await applyEphemeralServerSelectionFromPrefixArgs(['--server', 'company', 'doctor']);
      expect(resolution.rest).toEqual(['doctor']);

      const config = await import('@/configuration');
      expect(config.configuration.activeServerId).toBe('company');
      expect(config.configuration.serverUrl).toBe('https://company.example.test');
      expect(config.configuration.webappUrl).toBe('https://app.company.example.test');
      expect(process.env.HAPPIER_ACTIVE_SERVER_ID).toBe('company');
      expect((await getActiveServerProfile()).id).toBe('focused-home');
    });
  });

  it('does not persist selected profile when --server is combined with --no-persist', async () => {
    await withTempDir('happier-cli-server-select-profile-np-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { addServerProfile, getActiveServerProfile } = await import('./serverProfiles');
      await seedFocusedProfile();
      await addServerProfile({
        name: 'company',
        serverUrl: 'https://company.example.test',
        webappUrl: 'https://app.company.example.test',
        use: false,
      });

      const { applyServerSelectionFromArgs } = await import('./serverSelection');
      const config = await import('@/configuration');

      await applyServerSelectionFromArgs(['--server', 'company', '--no-persist']);

      expect(config.configuration.serverUrl).toBe('https://company.example.test');
      expect(config.configuration.webappUrl).toBe('https://app.company.example.test');
      expect(process.env.HAPPIER_SERVER_URL).toBe('https://company.example.test');
      expect(process.env.HAPPIER_WEBAPP_URL).toBe('https://app.company.example.test');
      expect((await getActiveServerProfile()).id).toBe('focused-home');
    });
  });

  it('sets active id for --server --no-persist despite a stale matching env id', async () => {
    await withTempDir('happier-cli-server-select-profile-np-stale-env-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: 'stale-profile',
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { addServerProfile, getActiveServerProfile } = await import('./serverProfiles');
      await seedFocusedProfile();
      await addServerProfile({
        name: 'stale profile',
        serverUrl: 'https://company.example.test',
        webappUrl: 'https://stale.company.example.test',
        use: false,
      });
      await addServerProfile({
        name: 'company',
        serverUrl: 'https://company.example.test',
        webappUrl: 'https://app.company.example.test',
        use: false,
      });

      const { applyServerSelectionFromArgs } = await import('./serverSelection');
      const config = await import('@/configuration');

      await applyServerSelectionFromArgs(['--server', 'company', '--no-persist']);

      expect(config.configuration.activeServerId).toBe('company');
      expect(config.configuration.serverUrl).toBe('https://company.example.test');
      expect(config.configuration.webappUrl).toBe('https://app.company.example.test');
      expect(process.env.HAPPIER_ACTIVE_SERVER_ID).toBe('company');
      expect((await getActiveServerProfile()).id).toBe('focused-home');
    });
  });

  it('rejects legacy --public-server-url with guidance to use --local-server-url', async () => {
    await withTempDir('happier-cli-server-select-legacy-public-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { applyServerSelectionFromArgs } = await import('./serverSelection');

      await expect(
        applyServerSelectionFromArgs([
          '--server-url',
          'http://127.0.0.1:53545',
          '--public-server-url',
          'https://stack.example.test',
        ]),
      ).rejects.toThrow(/--local-server-url/i);
    });
  });

  it('rejects legacy --public-server-url in prefix-only selection flags with guidance to use --local-server-url', async () => {
    await withTempDir('happier-cli-server-select-legacy-public-prefix-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { applyEphemeralServerSelectionFromPrefixArgs } = await import('./serverSelection');

      await expect(
        applyEphemeralServerSelectionFromPrefixArgs([
          '--public-server-url',
          'https://stack.example.test',
          'doctor',
        ]),
      ).rejects.toThrow(/--local-server-url/i);
    });
  });
});
