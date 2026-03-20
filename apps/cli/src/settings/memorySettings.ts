import { randomBytes as nodeRandomBytes } from 'node:crypto';

import {
  DEFAULT_MEMORY_SETTINGS,
  normalizeMemorySettings,
  sealSecretsDeepV1,
  unsealSecretsDeepWithKeysV1,
  type MemorySettingsV1,
} from '@happier-dev/protocol';

import { readCredentials, readSettings, updateSettings } from '@/persistence';
import {
  deriveSettingsSecretsKeyForCredentials,
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

async function unsealMemorySettingsSecrets(raw: unknown): Promise<unknown> {
  const credentials = await readCredentials();
  if (!credentials) return raw;
  return unsealSecretsDeepWithKeysV1(raw, deriveSettingsSecretsReadKeysForCredentials(credentials));
}

async function sealMemorySettingsSecrets(raw: MemorySettingsV1): Promise<MemorySettingsV1> {
  const credentials = await readCredentials();
  if (!credentials) return raw;
  return sealSecretsDeepV1(
    raw,
    deriveSettingsSecretsKeyForCredentials(credentials),
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
