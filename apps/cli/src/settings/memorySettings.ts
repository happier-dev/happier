import { randomBytes as nodeRandomBytes } from 'node:crypto';

import {
  DEFAULT_MEMORY_SETTINGS,
  normalizeMemorySettings,
  sealSecretsDeepV1,
  unsealSecretsDeepWithKeysV1,
  type MemorySettingsV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { readSettings, readStoredCredentials, updateSettings } from '@/persistence';
import {
  deriveSettingsSecretsReadKeysForCredentials,
} from '@/settings/secrets/settingsSecretsKey';

export {
  DEFAULT_MEMORY_SETTINGS,
  normalizeMemorySettings,
  type MemorySettingsV1,
} from '@happier-dev/protocol';

function normalizeEnabledAtMs(value: unknown): number {
  const raw = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.trunc(raw);
}

function finalizeMemorySettingsForPersistence(
  previous: MemorySettingsV1,
  next: MemorySettingsV1,
  nowMs: number = Date.now(),
): MemorySettingsV1 {
  if (!next.enabled) {
    return { ...next, enabledAtMs: 0 };
  }

  const prevEnabledAtMs = normalizeEnabledAtMs(previous.enabledAtMs);
  const nextEnabledAtMs = normalizeEnabledAtMs(next.enabledAtMs);
  const fallbackNowMs = Math.max(1, Math.trunc(nowMs));
  return {
    ...next,
    enabledAtMs: previous.enabled ? (prevEnabledAtMs || nextEnabledAtMs || fallbackNowMs) : (nextEnabledAtMs || fallbackNowMs),
  };
}

export class MemorySettingsSecretsUnavailableError extends Error {
  readonly code = 'memory_settings_secrets_unavailable';
  readonly cause: unknown;

  constructor(cause?: unknown) {
    super(
      cause instanceof Error
        ? `memory_settings_secrets_unavailable: ${cause.message}`
        : 'memory_settings_secrets_unavailable',
    );
    this.name = 'MemorySettingsSecretsUnavailableError';
    this.cause = cause;
  }
}

function hasUnavailableSealedSecret(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasUnavailableSealedSecret(item));
  }
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record._isSecretValue === true) {
    return typeof record.value !== 'string' && record.encryptedValue !== undefined;
  }
  return Object.values(record).some((item) => hasUnavailableSealedSecret(item));
}

function hasSecretValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasSecretValue(item));
  }
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record._isSecretValue === true) return true;
  return Object.values(record).some((item) => hasSecretValue(item));
}

async function resolveMemorySettingsSecretKey(): Promise<Uint8Array> {
  try {
    const storage = await readOrCreateDeviceLocalSecretStorage({
      path: configuration.deviceLocalSecretKeyFile,
    });
    return storage.deriveSecretKey({ purpose: 'memory_settings_secrets' });
  } catch (error) {
    throw new MemorySettingsSecretsUnavailableError(error);
  }
}

async function unsealMemorySettingsSecrets(raw: unknown): Promise<unknown> {
  if (!hasUnavailableSealedSecret(raw)) return raw;

  const credentials = await readStoredCredentials();
  const accountUnsealed = credentials
    ? unsealSecretsDeepWithKeysV1(
        raw,
        deriveSettingsSecretsReadKeysForCredentials(credentials),
      )
    : raw;
  if (!hasUnavailableSealedSecret(accountUnsealed)) return accountUnsealed;

  const unsealed = unsealSecretsDeepWithKeysV1(
    accountUnsealed,
    [await resolveMemorySettingsSecretKey()],
  );
  if (hasUnavailableSealedSecret(unsealed)) {
    throw new MemorySettingsSecretsUnavailableError();
  }
  return unsealed;
}

async function sealMemorySettingsSecrets(raw: MemorySettingsV1): Promise<MemorySettingsV1> {
  if (!hasSecretValue(raw)) return raw;
  return sealSecretsDeepV1(
    raw,
    await resolveMemorySettingsSecretKey(),
    (length) => new Uint8Array(nodeRandomBytes(length)),
  );
}

export async function readMemorySettingsFromDisk(): Promise<MemorySettingsV1> {
  const settings = await readSettings();
  const normalized = normalizeMemorySettings(await unsealMemorySettingsSecrets(settings.memory));
  if (!normalized.enabled || normalizeEnabledAtMs(normalized.enabledAtMs) > 0) {
    return normalized;
  }
  const repaired = finalizeMemorySettingsForPersistence(DEFAULT_MEMORY_SETTINGS, normalized);
  const sealed = await sealMemorySettingsSecrets(repaired);
  await updateSettings((current) => ({
    ...current,
    memory: sealed,
  }));
  return repaired;
}

export async function writeMemorySettingsToDisk(next: unknown): Promise<MemorySettingsV1> {
  const current = await readSettings();
  const previous = normalizeMemorySettings(await unsealMemorySettingsSecrets(current.memory));
  const normalized = finalizeMemorySettingsForPersistence(previous, normalizeMemorySettings(next));
  const sealed = await sealMemorySettingsSecrets(normalized);
  await updateSettings((current) => ({
    ...current,
    memory: sealed,
  }));
  return normalized;
}
