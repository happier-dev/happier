import type { DirectSessionsSource } from '@happier-dev/protocol';

import { createOpenCodeDirectClient } from './createOpenCodeDirectClient';

export async function getOpenCodeDirectSessionWorkingDirectory(params: Readonly<{
  source: DirectSessionsSource;
  remoteSessionId: string;
}>): Promise<string | null> {
  if (params.source.kind === 'opencodeServer') {
    const fromSource = typeof params.source.directory === 'string' ? params.source.directory.trim() : '';
    if (fromSource.length > 0) return fromSource;
  }

  const client = await createOpenCodeDirectClient(params.source);
  try {
    const session = await client.sessionGet({ sessionId: params.remoteSessionId });
    const directory = typeof (session as Record<string, unknown>).directory === 'string'
      ? String((session as Record<string, unknown>).directory).trim()
      : '';
    return directory.length > 0 ? directory : null;
  } catch {
    return null;
  } finally {
    await client.dispose().catch(() => {});
  }
}
