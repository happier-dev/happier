import type { InstallerFs, InstallerOverrides } from './types';

export async function getFs(overrides: InstallerOverrides): Promise<InstallerFs> {
  if (overrides.fs) return overrides.fs;
  const fs = await import('expo-file-system');
  return fs as any;
}

export function getFetch(overrides: InstallerOverrides): typeof fetch {
  return overrides.fetch ?? fetch;
}

