import { type Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { DirectSessionsSource } from '@happier-dev/protocol';

import { resolvePiAgentDir } from './resolvePiAgentDir';
import { readPiSessionHeader } from './readPiSessionHeader';

export type ResolvedPiDirectSessionFile = Readonly<{
  filePath: string;
  fileRelPath: string;
}>;

type PiSessionFilePreference = Readonly<{
  filePath: string;
  mtimeMs: number;
}>;

export function comparePiSessionFilePreference(
  left: PiSessionFilePreference,
  right: PiSessionFilePreference,
): number {
  return right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath);
}

function isSafeSegment(value: string): boolean {
  if (!value) return false;
  if (value.includes('/') || value.includes('\\')) return false;
  if (value === '.' || value === '..') return false;
  return true;
}

/**
 * Extract the session UUID from a pi session filename (`<ISO-timestamp>_<uuid>.jsonl` or
 * `<uuid>.jsonl`). The UUID is the segment after the final underscore.
 */
export function extractPiSessionIdFromFilename(fileName: string): string | null {
  if (!fileName.endsWith('.jsonl')) return null;
  const base = fileName.slice(0, -'.jsonl'.length);
  if (!base) return null;
  const lastUnderscore = base.lastIndexOf('_');
  const id = lastUnderscore >= 0 ? base.slice(lastUnderscore + 1) : base;
  return id || null;
}

/**
 * Resolve a pi session file by the canonical id in its session header. Scans every
 * `sessions/--<cwd>--/`
 * directory under the agent dir because a session's working directory is not known ahead of time
 * and the directory name encodes cwd ambiguously. When the same id appears in multiple directories,
 * the most recently modified file wins (mirrors Claude's project-spanning resolution).
 */
export async function resolvePiDirectSessionFile(params: Readonly<{
  source: DirectSessionsSource;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
}>): Promise<ResolvedPiDirectSessionFile | null> {
  const env = params.env ?? process.env;
  const remoteSessionId = String(params.remoteSessionId ?? '').trim();
  if (!isSafeSegment(remoteSessionId)) return null;

  const agentDir = resolvePiAgentDir({ source: params.source, env });
  const sessionsDir = join(agentDir, 'sessions');

  let dirEntries: Dirent<string>[];
  try {
    dirEntries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  let best: { filePath: string; fileRelPath: string; mtimeMs: number } | null = null;

  for (const dirEntry of dirEntries) {
    if (!dirEntry.isDirectory()) continue;
    if (dirEntry.isSymbolicLink()) continue;
    const dirName = typeof dirEntry.name === 'string' ? dirEntry.name : String(dirEntry.name);
    if (!isSafeSegment(dirName)) continue;

    let fileEntries: Dirent<string>[];
    try {
      fileEntries = await readdir(join(sessionsDir, dirName), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const fileEntry of fileEntries) {
      if (!fileEntry.isFile()) continue;
      if (fileEntry.isSymbolicLink()) continue;
      const name = typeof fileEntry.name === 'string' ? fileEntry.name : String(fileEntry.name);
      if (!name.endsWith('.jsonl')) continue;

      const filePath = join(sessionsDir, dirName, name);
      try {
        const header = await readPiSessionHeader(filePath);
        if (header?.id !== remoteSessionId) continue;
        const s = await stat(filePath);
        if (!s.isFile()) continue;
        if (!best || comparePiSessionFilePreference(
          { filePath, mtimeMs: s.mtimeMs },
          best,
        ) < 0) {
          best = {
            filePath,
            fileRelPath: `sessions/${dirName}/${name}`.replace(/\\/g, '/'),
            mtimeMs: Math.trunc(s.mtimeMs),
          };
        }
      } catch {
        // ignore unreadable candidate
      }
    }
  }

  return best ? { filePath: best.filePath, fileRelPath: best.fileRelPath } : null;
}
