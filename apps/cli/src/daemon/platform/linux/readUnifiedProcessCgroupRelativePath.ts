import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The kernel's cgroup-v2 membership; unsupported or unreadable membership is unknown. */
export async function readUnifiedProcessCgroupRelativePath(
  pid: number,
  procfsRootDir: string,
  read: (path: string, encoding: 'utf8') => Promise<string> = readFile,
): Promise<string | null> {
  try {
    const raw = await read(join(procfsRootDir, String(pid), 'cgroup'), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.startsWith('0::')) continue;
      return line.slice('0::'.length).trim() || null;
    }
    return null;
  } catch {
    return null;
  }
}
