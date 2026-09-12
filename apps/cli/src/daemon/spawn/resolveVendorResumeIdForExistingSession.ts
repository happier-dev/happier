import { resolveProviderSessionIdForBackendTarget } from '@happier-dev/agents';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { tryParseJsonRecord } from '@/utils/tryParseJsonRecord';

export function resolveVendorResumeIdForExistingSession(params: Readonly<{
  backendTarget: BackendTargetRefV1;
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

  return resolveProviderSessionIdForBackendTarget(params.backendTarget, metaRecord);
}
