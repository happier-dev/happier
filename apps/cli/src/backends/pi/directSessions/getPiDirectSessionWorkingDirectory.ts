import type { DirectSessionsSource } from '@happier-dev/protocol';

import { resolvePiDirectSessionFile } from './resolvePiDirectSessionFile';

/**
 * Resolve a pi direct session's working directory from its authoritative source: the session
 * header `cwd` field. The `sessions/--<cwd>--` directory name is not decoded here because the
 * encoding collapses both separators and drive colons to `-`, making reverse decoding ambiguous.
 */
export async function getPiDirectSessionWorkingDirectory(params: Readonly<{
  source: DirectSessionsSource;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
}>): Promise<string | null> {
  const resolved = await resolvePiDirectSessionFile({
    source: params.source,
    env: params.env,
    remoteSessionId: params.remoteSessionId,
  });
  if (!resolved) return null;

  const cwd = resolved.header.cwd.trim();
  return cwd || null;
}
