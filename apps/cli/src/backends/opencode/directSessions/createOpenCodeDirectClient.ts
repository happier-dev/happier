import type { DirectSessionsSource } from '@happier-dev/protocol';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createOpenCodeServerRuntimeClient, type OpenCodeServerRuntimeClient } from '../server/client';
import { withSharedManagedOpenCodeServerAccess } from '../server/sharedManagedServer';

function resolveBaseUrlOverride(source: DirectSessionsSource): string | null {
  if (source.kind !== 'opencodeServer') return null;
  return typeof source.baseUrl === 'string' && source.baseUrl.trim().length > 0 ? source.baseUrl.trim() : null;
}

function resolveDirectory(source: DirectSessionsSource): string {
  if (source.kind !== 'opencodeServer') return '';
  return typeof source.directory === 'string' && source.directory.trim().length > 0 ? source.directory.trim() : '';
}

async function createOpenCodeDirectClient(source: DirectSessionsSource): Promise<OpenCodeServerRuntimeClient> {
  const baseUrlOverride = resolveBaseUrlOverride(source);
  const directory = resolveDirectory(source);
  return await createOpenCodeServerRuntimeClient({
    directory,
    messageBuffer: new MessageBuffer(),
    ...(baseUrlOverride ? { baseUrlOverride } : {}),
  });
}

export async function withOpenCodeDirectClient<T>(
  source: DirectSessionsSource,
  operation: (client: OpenCodeServerRuntimeClient) => Promise<T>,
): Promise<T> {
  return await withSharedManagedOpenCodeServerAccess(async () => {
    const client = await createOpenCodeDirectClient(source);
    try {
      return await operation(client);
    } finally {
      await client.dispose();
    }
  }, resolveBaseUrlOverride(source) ?? process.env.HAPPIER_OPENCODE_SERVER_URL);
}

