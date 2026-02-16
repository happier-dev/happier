import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env.testkit';

describe('memorySettings', () => {
  const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  let homeDir: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'happier-memory-settings-'));
    applyEnvValues({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_SERVER_URL: 'https://api.example.test',
      HAPPIER_WEBAPP_URL: 'https://app.example.test',
    });
    vi.resetModules();
  });

  afterEach(async () => {
    restoreEnvValues(envBackup);
    vi.resetModules();
    if (homeDir) await rm(homeDir, { recursive: true, force: true });
  });

  it('returns defaults when unset', async () => {
    const { readMemorySettingsFromDisk } = await import('./memorySettings');
    const settings = await readMemorySettingsFromDisk();
    expect(settings.v).toBe(1);
    expect(settings.enabled).toBe(false);
    expect(settings.indexMode).toBe('hints');
    expect(settings.backfillPolicy).toBe('new_only');
    const rawDefaultScope = (settings as unknown as Record<string, unknown>).defaultScope;
    const defaultScopeType =
      rawDefaultScope && typeof rawDefaultScope === 'object' && 'type' in rawDefaultScope
        ? String((rawDefaultScope as Record<string, unknown>).type ?? '')
        : '';
    expect(defaultScopeType).toBe('global');
    expect(settings.hints.windowSizeMessages).toBe(40);
    expect(settings.hints.maxShardChars).toBe(12_000);
    expect(settings.hints.paddingMessagesOnVerify).toBe(8);
    expect(settings.hints.updateMode).toBe('onIdle');
    expect(settings.hints.idleDelayMs).toBe(15_000);
    expect(settings.hints.maxRunsPerHour).toBe(12);
    expect(settings.hints.summarizerPermissionMode).toBe('no_tools');
  });

  it('persists normalized settings into settings.json', async () => {
    const { readMemorySettingsFromDisk, writeMemorySettingsToDisk } = await import('./memorySettings');

    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'hints',
      backfillPolicy: 'new_only',
      hints: {
        summarizerBackendId: 'claude',
        summarizerModelId: 'default',
        summarizerPermissionMode: 'no_tools',
      },
    });

    const next = await readMemorySettingsFromDisk();
    expect(next.enabled).toBe(true);
    expect(next.hints.summarizerBackendId).toBe('claude');
    expect(next.hints.summarizerModelId).toBe('default');
  });
});
