import { inferAgentIdFromSessionMetadata, resolveAgentIdFromFlavor, resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { tryParseJsonRecord } from '@/utils/tryParseJsonRecord';

export function resolveVendorResumeIdForExistingSession(params: Readonly<{
  agent: unknown;
  credentials: Credentials | null;
  rawSession: Readonly<{ metadata?: unknown; dataEncryptionKey?: unknown; encryptionMode?: unknown }>;
}>): string | null {
  const rawMetadata = typeof params.rawSession.metadata === 'string' ? params.rawSession.metadata.trim() : '';
  if (!rawMetadata) return null;

  const metaRecord = (() => {
    if (params.rawSession.encryptionMode === 'plain') {
      return tryParseJsonRecord(rawMetadata);
    }
    if (!params.credentials) return null;
    return tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: params.rawSession });
  })();

  if (!metaRecord) return null;

  const explicitAgentId = resolveAgentIdFromFlavor(params.agent);
  const agentId = explicitAgentId ?? inferAgentIdFromSessionMetadata(metaRecord);

  return resolveVendorResumeIdFromSessionMetadata(agentId, metaRecord);
}

