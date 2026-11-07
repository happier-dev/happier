import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountSettingsParse } from '@happier-dev/protocol';

import type { DaemonState } from '@/api/types';
import {
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createProviderAccountSettingsController } from './providerAccountSettings';
import packageJson from '../../../package.json';

const roots: string[] = [];
afterEach(async () => {
  resetActiveAccountSettingsSnapshotForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('provider account settings lifecycle', () => {
  it('applies the account intent through the real provider and refreshes changed native settings without republishing equal facts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-account-settings-'));
    roots.push(root);
    const configDir = join(root, 'claude');
    await mkdir(configDir);
    const settingsPath = join(configDir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ cleanupPeriodDays: 30, unrelated: true }));
    let state: DaemonState = { status: 'running', startedAt: 101 };
    let publications = 0;
    const errors: unknown[] = [];
    const controller = createProviderAccountSettingsController({
      scopeKey: 'account-a',
      processEnv: { CLAUDE_CONFIG_DIR: configDir },
      activeServerDir: join(root, 'server'),
      apiMachine: {
        updateDaemonState: async (updater) => {
          const next = updater(state);
          if (next !== state) publications += 1;
          state = next;
        },
      },
      onError: (error) => errors.push(error),
    });
    const select = (settingsVersion: number, days: number, scopeKey = 'account-a') => {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ claudeSessionRetentionV1: { mode: 'days', days } }),
        settingsVersion,
        settingsSecretsReadKeys: [],
        loadedAtMs: 0,
        scopeKey,
      });
    };
    try {
      select(1, 365);
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({ cleanupPeriodDays: 365, unrelated: true });
        expect(state.providerSettingsSourceV1).toEqual({ pid: process.pid, cliVersion: packageJson.version, startedAt: 101 });
      });
      expect(state.providerSettingsV1?.claude).toMatchObject({
        policy: { mode: 'days', days: 365 },
        targets: expect.arrayContaining([{ id: 'native', status: 'applied', currentDays: 365 }]),
      });
      const confirmedPublications = publications;
      await controller.refresh();
      expect(publications).toBe(confirmedPublications);
      state = { ...state, providerSettingsSourceV1: { pid: process.pid, cliVersion: packageJson.version, startedAt: 100 } };
      await controller.refresh();
      expect(state.providerSettingsSourceV1?.startedAt).toBe(101);
      expect(publications).toBe(confirmedPublications + 1);
      await writeFile(settingsPath, JSON.stringify({ cleanupPeriodDays: 7, unrelated: true }));
      await controller.refresh();
      expect(JSON.parse(await readFile(settingsPath, 'utf8')).cleanupPeriodDays).toBe(365);
      select(2, 36500);
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(settingsPath, 'utf8')).cleanupPeriodDays).toBe(36500);
      });
      select(3, 1, 'account-b');
      await controller.refresh();
      expect(JSON.parse(await readFile(settingsPath, 'utf8')).cleanupPeriodDays).toBe(36500);
      expect(errors).toEqual([]);
    } finally {
      controller.stop();
    }
  });
});
