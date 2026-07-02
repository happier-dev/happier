import { buildProviderSessionIdSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';

import { readOpenCodeSessionRuntimeHandleFromMetadata } from './runtimeDescriptor.js';

export const OPEN_CODE_PROVIDER_SESSION_ID_METADATA_KEY = 'opencodeSessionId';

export function readOpenCodeProviderSessionIdFromMetadata(metadata: unknown): string | null {
  return readOpenCodeSessionRuntimeHandleFromMetadata(metadata).providerSessionId;
}

export function writeOpenCodeProviderSessionIdMetadata(providerSessionId: string | null | undefined): Readonly<Record<string, unknown>> {
  const value = typeof providerSessionId === 'string' ? providerSessionId.trim() : '';
  if (!value) return {};
  return buildProviderSessionIdSessionMetadata({
    metadataKey: OPEN_CODE_PROVIDER_SESSION_ID_METADATA_KEY,
    value,
  });
}
