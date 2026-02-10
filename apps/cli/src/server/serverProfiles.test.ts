import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('server profiles', () => {
  const previousHomeDir = process.env.HAPPIER_HOME_DIR;
  const tempHomeDirs = new Set<string>();

  const cleanupTempHomeDirs = () => {
    for (const dir of tempHomeDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempHomeDirs.clear();
  };

  const createTempHomeDir = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempHomeDirs.add(dir);
    return dir;
  };

  afterEach(() => {
    cleanupTempHomeDirs();

    if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHomeDir;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;
    vi.resetModules();
  });

  afterAll(() => {
    cleanupTempHomeDirs();
  });

  it('adds a server profile and can switch active server', async () => {
    const homeDir = createTempHomeDir('happier-cli-servers-');
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;

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

  it('refuses to remove the active server profile unless forced', async () => {
    const homeDir = createTempHomeDir('happier-cli-servers-remove-');
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;

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

  it('can resolve a server profile by name without changing the active server', async () => {
    const homeDir = createTempHomeDir('happier-cli-servers-resolve-');
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;

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

  it('refuses to create a server profile with reserved name "cloud"', async () => {
    const homeDir = createTempHomeDir('happier-cli-servers-reserved-');
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;

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

  it('sanitizes profile ids to filesystem-safe values', async () => {
    const homeDir = createTempHomeDir('happier-cli-servers-sanitize-');
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;

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
