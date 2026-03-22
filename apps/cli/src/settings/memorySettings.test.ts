import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

describe('memorySettings', () => {
  const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  let homeDir: string | undefined;

  beforeEach(async () => {
    homeDir = await createTempDir('happier-memory-settings-');
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
    if (homeDir) await removeTempDir(homeDir);
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

  it('stamps enabledAtMs when memory is enabled and preserves it across subsequent saves', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-03-09T16:30:00.000Z'));

      const { readMemorySettingsFromDisk, writeMemorySettingsToDisk } = await import('./memorySettings');

      await writeMemorySettingsToDisk({ v: 1, enabled: true });
      const first = await readMemorySettingsFromDisk();
      expect(first.enabled).toBe(true);
      expect(first.enabledAtMs).toBe(Date.now());

      vi.setSystemTime(new Date('2026-03-09T16:35:00.000Z'));
      await writeMemorySettingsToDisk({ ...first, hints: { ...first.hints, maxKeywords: 7 } });
      const second = await readMemorySettingsFromDisk();
      expect(second.enabledAtMs).toBe(first.enabledAtMs);
    } finally {
      vi.useRealTimers();
    }
  });

  it('repairs missing enabledAtMs for already-enabled memory settings when they are read back', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-03-09T17:00:00.000Z'));

      const { readSettings, updateSettings, writeCredentialsLegacy } = await import('@/persistence');
      const { readMemorySettingsFromDisk } = await import('./memorySettings');

      await writeCredentialsLegacy({
        token: 't',
        secret: new Uint8Array(32).fill(9),
      });

      await updateSettings((current) => ({
        ...current,
        memory: {
          v: 1,
          enabled: true,
          indexMode: 'deep',
          embeddings: {
            mode: 'custom',
            custom: {
              kind: 'openai_compatible',
              baseUrl: 'https://example.test/v1',
              apiKey: { _isSecretValue: true, value: 'sk-repair-test' },
              model: 'text-embedding-3-small',
            },
          },
        },
      }));

      const repaired = await readMemorySettingsFromDisk();
      expect(repaired.enabled).toBe(true);
      expect(repaired.enabledAtMs).toBe(Date.now());
      expect(repaired.embeddings.custom?.kind).toBe('openai_compatible');
      if (repaired.embeddings.custom?.kind !== 'openai_compatible') {
        throw new Error('expected openai_compatible embeddings config');
      }
      expect(repaired.embeddings.custom.apiKey?.value).toBe('sk-repair-test');

      const persisted = (await import('./memorySettings')).normalizeMemorySettings((await readSettings()).memory);
      expect(persisted.embeddings.custom?.kind).toBe('openai_compatible');
      if (persisted.embeddings.custom?.kind !== 'openai_compatible') {
        throw new Error('expected openai_compatible embeddings config');
      }
      expect(persisted.embeddings.custom.apiKey?.value).toBeUndefined();
      expect(persisted.embeddings.custom.apiKey?.encryptedValue?.c).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('seals remote embeddings API keys in settings.json and unseals them on read', async () => {
    const { readSettings, writeCredentialsLegacy } = await import('@/persistence');
    const { readMemorySettingsFromDisk, writeMemorySettingsToDisk, normalizeMemorySettings } = await import('./memorySettings');

    await writeCredentialsLegacy({
      token: 't',
      secret: new Uint8Array(32).fill(7),
    });

    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'deep',
      embeddings: {
        mode: 'custom',
        custom: {
          kind: 'openai_compatible',
          baseUrl: 'https://example.test/v1',
          apiKey: { _isSecretValue: true, value: 'sk-memory-test' },
          model: 'text-embedding-3-small',
        },
      },
    });

    const persisted = normalizeMemorySettings((await readSettings()).memory);
    expect(persisted.embeddings.custom?.kind).toBe('openai_compatible');
    if (persisted.embeddings.custom?.kind !== 'openai_compatible') {
      throw new Error('expected openai_compatible embeddings config');
    }
    expect(persisted.embeddings.custom.apiKey?.value).toBeUndefined();
    expect(persisted.embeddings.custom.apiKey?.encryptedValue?.c).toBeTruthy();

    const unsealed = await readMemorySettingsFromDisk();
    expect(unsealed.embeddings.custom?.kind).toBe('openai_compatible');
    if (unsealed.embeddings.custom?.kind !== 'openai_compatible') {
      throw new Error('expected openai_compatible embeddings config');
    }
    expect(unsealed.embeddings.custom.apiKey?.value).toBe('sk-memory-test');
  });
});
