import { stat } from 'node:fs/promises';

import type { DirectSessionsSource } from '@happier-dev/protocol';

import { resolveClaudeDirectSessionFile } from './resolveClaudeDirectSessionFile';

export async function getClaudeDirectSessionActivity(params: Readonly<{
  source: DirectSessionsSource;
  remoteSessionId: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<Readonly<{ lastActivityAtMs: number | null }>> {
  const resolved = await resolveClaudeDirectSessionFile({
    source: params.source,
    remoteSessionId: params.remoteSessionId,
    env: params.env,
  });
  if (!resolved) return { lastActivityAtMs: null };

  try {
    const s = await stat(resolved.filePath);
    const mtimeMs = Number.isFinite(s.mtimeMs) ? Math.trunc(s.mtimeMs) : null;
    return { lastActivityAtMs: mtimeMs != null && mtimeMs >= 0 ? mtimeMs : null };
  } catch {
    return { lastActivityAtMs: null };
  }
}

