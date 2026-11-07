import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

describe('unchanged settings updates', () => {
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_ACTIVE_SERVER_ID']);
  let homeDir: string;
  let settingsRenames: number;
  beforeEach(async () => {
    homeDir = await createTempDir('happier-settings-noop-');
    env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined,
      HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
    settingsRenames = 0;
    vi.doMock('node:fs/promises', async importOriginal => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
        if (String(args[1]) === join(homeDir, 'settings.json')) settingsRenames++;
        return actual.rename(...args);
      } };
    });
    vi.resetModules();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock('node:fs/promises');
    env.restore();
    vi.resetModules();
    await removeTempDir(homeDir);
  });

  it('serializes and publishes zero settings files for unchanged ensures, then publishes one real identity change', async () => {
    const { updateSettings } = await import('./persistence');
    await updateSettings(current => ({ ...current, machineIdByServerId: { cloud: 'machine-original' } }));
    const settingsPath = join(homeDir, 'settings.json');
    const content = await readFile(settingsPath, 'utf8');
    const stringify = vi.spyOn(JSON, 'stringify');
    settingsRenames = 0;
    const settingsSerializations = () => stringify.mock.calls.filter(([value]) => (
      value && typeof value === 'object' && 'schemaVersion' in value
    )).length;
    for (let index = 0; index < 25; index++) {
      await updateSettings(current => index % 2 === 0 ? current : { ...current });
    }
    expect(settingsSerializations()).toBe(0);
    expect(settingsRenames).toBe(0);
    expect(await readFile(settingsPath, 'utf8')).toBe(content);
    await updateSettings(current => ({ ...current, machineIdByServerId: { cloud: 'machine-replacement' } }));
    expect(settingsSerializations()).toBe(1);
    expect(settingsRenames).toBe(1);
    expect(JSON.parse(await readFile(settingsPath, 'utf8')).machineIdByServerId.cloud).toBe('machine-replacement');
    expect(existsSync(`${settingsPath}.lock`)).toBe(false);
    expect(existsSync(`${settingsPath}.tmp`)).toBe(false);
  });

  it('imports cursors and persists a predecessor migration even when the updater returns its input', async () => {
    const settingsPath = join(homeDir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ schemaVersion: 4, onboardingCompleted: true,
      lastChangesCursorByAccountId: { account: 42 } }));
    const { updateSettings, readAccountChangesCursor } = await import('./persistence');
    await updateSettings(current => current);
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toMatchObject({ schemaVersion: 6, onboardingCompleted: true });
    expect(await readAccountChangesCursor('account')).toBe(42);
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).not.toHaveProperty('lastChangesCursorByAccountId');
    await updateSettings(current => current);
    expect(await readAccountChangesCursor('account')).toBe(42);
  });

  it('initializes a missing settings file and the initial cursor import on an unchanged updater', async () => {
    const { updateSettings } = await import('./persistence');
    await updateSettings(current => current);
    expect(JSON.parse(await readFile(join(homeDir, 'settings.json'), 'utf8')).schemaVersion).toBe(6);
    expect(JSON.parse(await readFile(join(homeDir, 'changes-cursors.json'), 'utf8'))).toEqual({});
  });
});
