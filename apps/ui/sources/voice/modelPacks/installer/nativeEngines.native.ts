import type { SherpaNativeModule } from '@happier-dev/sherpa-native';

import { fileUriToNativePath } from '@/voice/modelPacks/nativePath';

import type { InstallerOverrides } from './types';

export type InstallerSherpaNative = Pick<SherpaNativeModule, 'release' | 'excludeFromBackup'>;

async function getSherpaNative(overrides: InstallerOverrides): Promise<InstallerSherpaNative | null> {
  if (overrides.sherpaNative !== undefined) return overrides.sherpaNative;
  try {
    const { getOptionalHappierSherpaNativeModule } = await import('@happier-dev/sherpa-native');
    return getOptionalHappierSherpaNativeModule();
  } catch {
    // Builds without the native speech module have no engines to unload and nothing to exclude.
    return null;
  }
}

/**
 * Native engines keep the pack's models loaded per assets dir. Unload them before the pack's files are
 * replaced or deleted so the next use loads the current build instead of a stale cached engine.
 */
export async function releaseModelPackEngines(overrides: InstallerOverrides, dirUri: string): Promise<void> {
  const native = await getSherpaNative(overrides);
  if (!native?.release) return;
  await native.release({ assetsDir: fileUriToNativePath(dirUri) });
}

async function excludeFromBackup(native: InstallerSherpaNative, dirUri: string): Promise<void> {
  if (!native.excludeFromBackup) return;
  try {
    await native.excludeFromBackup({ path: fileUriToNativePath(dirUri) });
  } catch (error) {
    console.warn('[modelPacks] Failed to exclude model pack from backup', error instanceof Error ? error.name : 'unknown');
  }
}

/**
 * Packs are large and re-downloadable, so they stay out of device backups. Mark each directory on use:
 * removal and cancellation can recreate the same path without its former backup flag. Runs in the
 * background: pack use never waits on it, and a failure is only logged.
 */
export function excludeModelPackDirFromBackup(overrides: InstallerOverrides, dirUri: string): void {
  void getSherpaNative(overrides).then((native) => (native ? excludeFromBackup(native, dirUri) : undefined));
}
