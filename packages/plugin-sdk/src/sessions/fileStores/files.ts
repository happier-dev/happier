/** @moduleRealm daemon */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { sessionFileNameMatchesSessionId } from './sessionFileNameCodec.js';

async function readDirectoryEntries(dir: string) {
  return await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
}

export async function findNewestSessionFileInDir(params: Readonly<{
  sessionId: string;
  dir: string;
}>): Promise<string | null> {
  const entries = await readDirectoryEntries(params.dir).catch(() => null);
  if (!entries) return null;

  const matches: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const entryName = String(entry.name);
    if (!sessionFileNameMatchesSessionId(entryName, params.sessionId)) continue;
    const path = join(params.dir, entryName);
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) continue;
      matches.push({
        path,
        mtimeMs: Number.isFinite(metadata.mtimeMs) ? metadata.mtimeMs : 0,
      });
    } catch {
      // Ignore files that disappear between directory listing and stat.
    }
  }

  matches.sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.path.localeCompare(b.path));
  return matches[0]?.path ?? null;
}
