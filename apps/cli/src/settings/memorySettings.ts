import { normalizeMemorySettings, type MemorySettingsV1 } from '@happier-dev/protocol';

import { readSettings, updateSettings } from '@/persistence';

export {
  DEFAULT_MEMORY_SETTINGS,
  MemorySettingsV1Schema,
  normalizeMemorySettings,
  type MemorySettingsV1,
} from '@happier-dev/protocol';

export async function readMemorySettingsFromDisk(): Promise<MemorySettingsV1> {
  const settings = await readSettings();
  return normalizeMemorySettings(settings.memory);
}

export async function writeMemorySettingsToDisk(next: unknown): Promise<MemorySettingsV1> {
  const normalized = normalizeMemorySettings(next);
  await updateSettings((current) => ({
    ...current,
    memory: normalized,
  }));
  return normalized;
}
