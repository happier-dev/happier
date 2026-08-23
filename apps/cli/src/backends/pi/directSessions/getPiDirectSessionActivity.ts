import { stat } from 'node:fs/promises';

import type { DirectSessionsSource } from '@happier-dev/protocol';

import { resolvePiDirectSessionFile } from './resolvePiDirectSessionFile';

/**
 * Pi direct-session activity is derived from the session file's mtime. There is no live process
 * probe in the direct-session model; liveness during background follow is owned by the polling
 * follow-lease. `isRunning` is therefore always false, matching Claude's behavior.
 */
export async function getPiDirectSessionActivity(params: Readonly<{
  source: DirectSessionsSource;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
}>): Promise<Readonly<{ lastActivityAtMs: number | null }>> {
  const resolved = await resolvePiDirectSessionFile({
    source: params.source,
    env: params.env,
    remoteSessionId: params.remoteSessionId,
  });
  if (!resolved) return { lastActivityAtMs: null };

  const s = await stat(resolved.filePath).catch(() => null);
  if (!s) return { lastActivityAtMs: null };

  return { lastActivityAtMs: Math.trunc(s.mtimeMs) };
}
