import {
  getAgentResumeConfig,
  resolveAgentIdFromSessionMetadata,
  isLinkedVendorResumeIdentityCurrent,
  resolveCanonicalAgentIdFromFlavor,
  resolveVendorResumeIdFromSessionMetadata,
  type VendorResumeLinkedSessionCurrentAgent,
} from '@happier-dev/agents';

import type { StoredCredentials } from '@/persistence';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { tryParseJsonRecord } from '@/utils/tryParseJsonRecord';

export function resolveVendorResumeIdForExistingSession(params: Readonly<{
  agent: unknown;
  credentials: StoredCredentials | null;
  rawSession: Readonly<{ metadata?: unknown; dataEncryptionKey?: unknown; encryptionMode?: unknown }>;
  metadataRecord?: Record<string, unknown> | null;
  linkedSessionCurrentAgent?: VendorResumeLinkedSessionCurrentAgent | null;
}>): string | null {
  const metaRecord = params.metadataRecord ?? (() => {
    const rawMetadata = typeof params.rawSession.metadata === 'string' ? params.rawSession.metadata.trim() : '';
    if (!rawMetadata) return null;
    if (params.rawSession.encryptionMode === 'plain') {
      return tryParseJsonRecord(rawMetadata);
    }
    if (!params.credentials) return null;
    return tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: params.rawSession });
  })();

  if (!metaRecord) return null;

  const explicitAgentId = resolveCanonicalAgentIdFromFlavor(params.agent);
  const agentId = explicitAgentId ?? resolveAgentIdFromSessionMetadata(metaRecord);
  const resumeConfig = agentId ? getAgentResumeConfig(agentId) : null;
  const vendorResumeIdField =
    resumeConfig && 'vendorResumeIdField' in resumeConfig
      ? resumeConfig.vendorResumeIdField ?? null
      : null;
  if (!agentId) return null;
  if (!isLinkedVendorResumeIdentityCurrent({
    agentId,
    metadata: metaRecord,
    vendorResumeIdField,
    linkedSessionCurrentAgent: params.linkedSessionCurrentAgent,
  })) {
    return null;
  }

  return resolveVendorResumeIdFromSessionMetadata(agentId, metaRecord);
}
