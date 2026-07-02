import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

import type { ExternalSessionsSource } from '@happier-dev/protocol';

import { resolveOhMyPiAgentDir } from './source.js';

export function readOhMyPiSessionIdFromFilename(filename: string): string | null {
  const match = filename.match(/_(.+)\.jsonl$/);
  const remoteSessionId = match?.[1]?.trim();
  return remoteSessionId || null;
}

export async function listOhMyPiSessionRoots(params: Readonly<{
  source: ExternalSessionsSource;
  env?: NodeJS.ProcessEnv;
}>): Promise<string[]> {
  const agentDir = resolveOhMyPiAgentDir({ source: params.source, env: params.env });
  const sessionsDir = join(agentDir, 'sessions');
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(sessionsDir, entry.name));
  } catch {
    return [];
  }
}

export async function resolveOhMyPiSessionFile(params: Readonly<{
  source: ExternalSessionsSource;
  remoteSessionId: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<Readonly<{ filePath: string }> | null> {
  const sessionRoots = await listOhMyPiSessionRoots({
    source: params.source,
    env: params.env,
  });
  const suffix = `_${params.remoteSessionId}.jsonl`;
  for (const sessionRoot of sessionRoots) {
    let entries: Dirent[] = [];
    try {
      entries = await readdir(sessionRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    const match = entries.find((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(suffix));
    if (match) {
      return { filePath: join(sessionRoot, match.name) };
    }
  }
  return null;
}
