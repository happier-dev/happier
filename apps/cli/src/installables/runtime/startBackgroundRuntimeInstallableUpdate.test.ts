import { afterEach, describe, expect, it, vi } from 'vitest';

import { INSTALLABLE_KEYS } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';

import { startBackgroundRuntimeInstallableUpdate } from './startBackgroundRuntimeInstallableUpdate';
import type { RuntimeInstallableAdapter } from './runtimeInstallablesRegistry';

function createAdapter(): RuntimeInstallableAdapter {
  return {
    key: INSTALLABLE_KEYS.CODEX_ACP,
    detectLaunchResolution: vi.fn(async () => ({
      availability: { ok: true as const },
      canAutoInstall: false,
      canBackgroundAutoUpdate: true,
    })),
    installOrUpgrade: vi.fn(async () => ({ ok: true as const, logPath: '/tmp/install.log' })),
    runBackgroundAutoUpdateCheck: vi.fn(async () => {}),
  };
}

describe('startBackgroundRuntimeInstallableUpdate', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs the background check only once within the configured cooldown window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T10:00:00.000Z'));

    const adapter = createAdapter();
    const readLastCheckAtMs = vi.fn(async () => null);
    const writeLastCheckAtMs = vi.fn(async () => {});

    await startBackgroundRuntimeInstallableUpdate(
      { installableKey: `${INSTALLABLE_KEYS.CODEX_ACP}-cooldown-a`, adapter },
      {
        readLastCheckAtMs,
        writeLastCheckAtMs,
        autoUpdateCheckIntervalMs: 60_000,
      },
    );
    await startBackgroundRuntimeInstallableUpdate(
      { installableKey: `${INSTALLABLE_KEYS.CODEX_ACP}-cooldown-a`, adapter },
      {
        readLastCheckAtMs,
        writeLastCheckAtMs,
        autoUpdateCheckIntervalMs: 60_000,
      },
    );

    expect(adapter.runBackgroundAutoUpdateCheck).toHaveBeenCalledTimes(1);
    expect(writeLastCheckAtMs).toHaveBeenCalledTimes(1);
  });

  it('allows another background check after the cooldown expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T10:00:00.000Z'));

    const adapter = createAdapter();
    let lastCheckAtMs: number | null = null;

    const readLastCheckAtMs = vi.fn(async () => lastCheckAtMs);
    const writeLastCheckAtMs = vi.fn(async (_key: string, next: number) => {
      lastCheckAtMs = next;
    });

    await startBackgroundRuntimeInstallableUpdate(
      { installableKey: `${INSTALLABLE_KEYS.CODEX_ACP}-cooldown-b`, adapter },
      {
        readLastCheckAtMs,
        writeLastCheckAtMs,
        autoUpdateCheckIntervalMs: 60_000,
      },
    );

    vi.setSystemTime(new Date('2026-03-10T10:02:00.000Z'));

    await startBackgroundRuntimeInstallableUpdate(
      { installableKey: `${INSTALLABLE_KEYS.CODEX_ACP}-cooldown-b`, adapter },
      {
        readLastCheckAtMs,
        writeLastCheckAtMs,
        autoUpdateCheckIntervalMs: 60_000,
      },
    );

    expect(adapter.runBackgroundAutoUpdateCheck).toHaveBeenCalledTimes(2);
  });

  it('does not reject launch flow when update-state persistence fails', async () => {
    const adapter = createAdapter();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(
      startBackgroundRuntimeInstallableUpdate(
        { installableKey: `${INSTALLABLE_KEYS.CODEX_ACP}-state-write-failure`, adapter },
        {
          readLastCheckAtMs: vi.fn(async () => null),
          writeLastCheckAtMs: vi.fn(async () => {
            throw new Error('disk full');
          }),
          autoUpdateCheckIntervalMs: 60_000,
        },
      ),
    ).resolves.toBeUndefined();

    expect(adapter.runBackgroundAutoUpdateCheck).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
