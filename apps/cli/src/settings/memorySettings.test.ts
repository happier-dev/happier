import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
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
    const { configuration } = await import('@/configuration');
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
    await expect(readFile(configuration.deviceLocalSecretKeyFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('persists normalized settings into settings.json', async () => {
    const { configuration } = await import('@/configuration');
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
    await expect(readFile(configuration.deviceLocalSecretKeyFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
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

  it('seals token-only remote embeddings API keys with device-local custody before writing settings.json', async () => {
    const { configuration } = await import('@/configuration');
    const { writeCredentialsTokenOnly } = await import('@/persistence');
    const { readMemorySettingsFromDisk, writeMemorySettingsToDisk } = await import('./memorySettings');

    await writeCredentialsTokenOnly({ token: 'token-only' });
    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'deep',
      embeddings: {
        mode: 'custom',
        custom: {
          kind: 'openai_compatible',
          baseUrl: 'https://example.test/v1',
          apiKey: { _isSecretValue: true, value: 'sk-token-only-memory' },
          model: 'text-embedding-3-small',
        },
      },
    });

    const persistedBytes = await readFile(configuration.settingsFile, 'utf8');
    expect(persistedBytes).not.toContain('sk-token-only-memory');

    const unsealed = await readMemorySettingsFromDisk();
    expect(unsealed.embeddings.custom?.kind).toBe('openai_compatible');
    if (unsealed.embeddings.custom?.kind !== 'openai_compatible') {
      throw new Error('expected openai_compatible embeddings config');
    }
    expect(unsealed.embeddings.custom.apiKey?.value).toBe('sk-token-only-memory');
  });

  it('opens legacy account-encrypted memory settings without consulting a corrupt device-local key', async () => {
    const { configuration } = await import('@/configuration');
    const { deriveSettingsSecretsKeyV1, sealSecretsDeepV1 } = await import('@happier-dev/protocol');
    const { updateSettings, writeCredentialsLegacy } = await import('@/persistence');
    const { readMemorySettingsFromDisk } = await import('./memorySettings');
    const secret = new Uint8Array(32).fill(7);

    await writeCredentialsLegacy({ token: 't', secret });
    const legacySealed = sealSecretsDeepV1(
      {
        v: 1,
        enabled: true,
        enabledAtMs: 1,
        indexMode: 'deep',
        embeddings: {
          mode: 'custom',
          custom: {
            kind: 'openai_compatible',
            baseUrl: 'https://example.test/v1',
            apiKey: { _isSecretValue: true, value: 'sk-legacy-account-memory' },
            model: 'text-embedding-3-small',
          },
        },
      },
      deriveSettingsSecretsKeyV1(secret),
      (length) => new Uint8Array(length).fill(5),
    );
    await updateSettings((current) => ({ ...current, memory: legacySealed }));
    await writeFile(
      configuration.deviceLocalSecretKeyFile,
      '{"version":1,"key":"bad"}',
      { encoding: 'utf8', mode: 0o600 },
    );

    const unsealed = await readMemorySettingsFromDisk();
    expect(unsealed.embeddings.custom?.kind).toBe('openai_compatible');
    if (unsealed.embeddings.custom?.kind !== 'openai_compatible') {
      throw new Error('expected openai_compatible embeddings config');
    }
    expect(unsealed.embeddings.custom.apiKey?.value).toBe('sk-legacy-account-memory');
  });

  it('does not overwrite memory settings when the device-local key is corrupt', async () => {
    const { configuration } = await import('@/configuration');
    const persistence = await import('@/persistence');
    const { updateSettings, writeCredentialsTokenOnly } = persistence;

    await writeCredentialsTokenOnly({ token: 'token-only' });
    await updateSettings((current) => current);
    const corruptKeyBytes = '{"version":1,"key":"bad"}';
    await writeFile(
      configuration.deviceLocalSecretKeyFile,
      corruptKeyBytes,
      { encoding: 'utf8', mode: 0o600 },
    );
    const settingsBytesBefore = await readFile(configuration.settingsFile, 'utf8');
    const updateSettingsSpy = vi.spyOn(persistence, 'updateSettings');
    const { writeMemorySettingsToDisk } = await import('./memorySettings');

    const writePromise = writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'deep',
      embeddings: {
        mode: 'custom',
        custom: {
          kind: 'openai_compatible',
          baseUrl: 'https://example.test/v1',
          apiKey: { _isSecretValue: true, value: 'sk-must-not-persist' },
          model: 'text-embedding-3-small',
        },
      },
    });
    await expect(writePromise).rejects.toMatchObject({
      code: 'memory_settings_secrets_unavailable',
    });
    await expect(writePromise).rejects.toThrow(/Invalid device-local secret key/);

    expect(updateSettingsSpy).not.toHaveBeenCalled();
    await expect(readFile(configuration.settingsFile, 'utf8')).resolves.toBe(settingsBytesBefore);
    await expect(readFile(configuration.deviceLocalSecretKeyFile, 'utf8')).resolves.toBe(corruptKeyBytes);
  });

  it('does not repair settings or custody bytes when a device-sealed secret cannot be opened', async () => {
    const { configuration } = await import('@/configuration');
    const { writeCredentialsTokenOnly } = await import('@/persistence');
    const { writeMemorySettingsToDisk } = await import('./memorySettings');

    await writeCredentialsTokenOnly({ token: 'token-only' });
    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'deep',
      embeddings: {
        mode: 'custom',
        custom: {
          kind: 'openai_compatible',
          baseUrl: 'https://example.test/v1',
          apiKey: { _isSecretValue: true, value: 'sk-device-sealed' },
          model: 'text-embedding-3-small',
        },
      },
    });
    const settingsBytesBefore = await readFile(configuration.settingsFile, 'utf8');
    const replacementKeyBytes = JSON.stringify({
      version: 1,
      key: Buffer.from(new Uint8Array(32).fill(9)).toString('base64url'),
    });
    await writeFile(
      configuration.deviceLocalSecretKeyFile,
      replacementKeyBytes,
      { encoding: 'utf8', mode: 0o600 },
    );

    vi.resetModules();
    const persistence = await import('@/persistence');
    const updateSettingsSpy = vi.spyOn(persistence, 'updateSettings');
    const {
      MemorySettingsSecretsUnavailableError,
      readMemorySettingsFromDisk,
    } = await import('./memorySettings');

    const readPromise = readMemorySettingsFromDisk();
    await expect(readPromise).rejects.toMatchObject({
      code: 'memory_settings_secrets_unavailable',
    });
    await expect(readPromise).rejects.toBeInstanceOf(MemorySettingsSecretsUnavailableError);

    expect(updateSettingsSpy).not.toHaveBeenCalled();
    await expect(readFile(configuration.settingsFile, 'utf8')).resolves.toBe(settingsBytesBefore);
    await expect(readFile(configuration.deviceLocalSecretKeyFile, 'utf8')).resolves.toBe(replacementKeyBytes);
  });
});
