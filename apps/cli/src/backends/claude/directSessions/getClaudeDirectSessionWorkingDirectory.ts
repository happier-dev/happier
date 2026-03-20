import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import type { DirectSessionsSource } from '@happier-dev/protocol';

import { resolveClaudeDirectSessionFile } from './resolveClaudeDirectSessionFile';

export async function getClaudeDirectSessionWorkingDirectory(params: Readonly<{
  source: DirectSessionsSource;
  remoteSessionId: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<string | null> {
  const resolved = await resolveClaudeDirectSessionFile({
    source: params.source,
    env: params.env,
    remoteSessionId: params.remoteSessionId,
  });
  if (!resolved) return null;

  const stream = createReadStream(resolved.filePath, { encoding: 'utf8' });
  const lines = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const cwd = typeof parsed.cwd === 'string' ? parsed.cwd.trim() : '';
        if (cwd.length > 0) {
          return cwd;
        }
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}
