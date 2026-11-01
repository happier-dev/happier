import type { DirectSessionsSource } from '@happier-dev/protocol';

import { withOpenCodeDirectClient } from './createOpenCodeDirectClient';

export async function getOpenCodeDirectSessionWorkingDirectory(params: Readonly<{
  source: DirectSessionsSource;
  remoteSessionId: string;
}>): Promise<string | null> {
  if (params.source.kind === 'opencodeServer') {
    const fromSource = typeof params.source.directory === 'string' ? params.source.directory.trim() : '';
    if (fromSource.length > 0) return fromSource;
  }

  return await withOpenCodeDirectClient(params.source, async (client) => {
  try {
    const session = await client.sessionGet({ sessionId: params.remoteSessionId });
    const directory = typeof (session as Record<string, unknown>).directory === 'string'
      ? String((session as Record<string, unknown>).directory).trim()
      : '';
    return directory.length > 0 ? directory : null;
  } catch {
    return null;
  }
  });
}
