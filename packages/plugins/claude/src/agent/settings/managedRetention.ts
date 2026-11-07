import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Observe local administrative declarations; Claude owns remote/MDM policy precedence. */
export async function readClaudeManagedRetention(systemSettingsDir: string): Promise<'present' | 'absent' | 'unreadable'> {
  try {
    const dropInsDir = join(systemSettingsDir, 'managed-settings.d');
    const entries = await readdir(dropInsDir).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    const files = [join(systemSettingsDir, 'managed-settings.json'), ...entries
      .filter((name) => !name.startsWith('.') && name.endsWith('.json')).sort().map((name) => join(dropInsDir, name))];
    let present = false;
    for (const file of files) {
      const raw = await readFile(file, 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (raw === null) continue;
      const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable';
      if ('cleanupPeriodDays' in parsed && parsed.cleanupPeriodDays != null) present = true;
    }
    return present ? 'present' : 'absent';
  } catch {
    return 'unreadable';
  }
}
