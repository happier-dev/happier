import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { DirectSessionsSource } from '@happier-dev/protocol';

import { resolveOhMyPiAgentDir } from '@/backends/ohMyPi/directSessions/resolveOhMyPiAgentDir';

export async function resolveOhMyPiSessionFile(params: Readonly<{
  source: DirectSessionsSource;
  remoteSessionId: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<Readonly<{ filePath: string }> | null> {
  const agentDir = resolveOhMyPiAgentDir({ source: params.source, env: params.env });
  const sessionsDir = join(agentDir, 'sessions');

  let sessionRoots: string[] = [];
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    sessionRoots = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(sessionsDir, entry.name));
  } catch {
    return null;
  }

  const suffix = `_${params.remoteSessionId}.jsonl`;
  for (const sessionRoot of sessionRoots) {
    let entries: string[] = [];
    try {
      entries = await readdir(sessionRoot);
    } catch {
      continue;
    }
    const match = entries.find((entry) => entry.endsWith(suffix));
    if (match) {
      return { filePath: join(sessionRoot, match) };
    }
  }
  return null;
}
