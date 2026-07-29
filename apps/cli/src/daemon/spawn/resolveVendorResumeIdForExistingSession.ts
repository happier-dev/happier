import {
  getAgentResumeConfig,
  inferAgentIdFromSessionMetadata,
  isLinkedVendorResumeIdentityCurrent,
  resolveCanonicalAgentIdFromFlavor,
  resolveObservedVendorResumeIdForResume,
  resolveVendorResumeIdFromSessionMetadata,
  type VendorResumeLinkedSessionCurrentAgent,
} from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { tryParseJsonRecord } from '@/utils/tryParseJsonRecord';

export function resolveVendorResumeIdForExistingSession(params: Readonly<{
  agent: unknown;
  credentials: Credentials | null;
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
  const agentId = explicitAgentId ?? inferAgentIdFromSessionMetadata(metaRecord);
  const resumeConfig = getAgentResumeConfig(agentId);
  const vendorResumeIdField =
    resumeConfig && 'vendorResumeIdField' in resumeConfig
      ? resumeConfig.vendorResumeIdField ?? null
      : null;
  if (!isLinkedVendorResumeIdentityCurrent({
    agentId,
    metadata: metaRecord,
    vendorResumeIdField,
    linkedSessionCurrentAgent: params.linkedSessionCurrentAgent,
  })) {
    return null;
  }

  return resolveObservedVendorResumeIdForResume({
    agentId,
    metadata: metaRecord,
    vendorResumeId: resolveVendorResumeIdFromSessionMetadata(agentId, metaRecord),
  });
}
