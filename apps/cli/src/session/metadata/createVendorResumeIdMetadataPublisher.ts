import { AGENTS_CORE, type AgentId } from '@happier-dev/agents';

import type { AcpBoundSessionIdentity } from '@/agent/acp/runtime/sessionIdentityBinding';
import type { Metadata } from '@/api/types';

function resolveVendorResumeIdField(agentId: AgentId): string {
  const resume = AGENTS_CORE[agentId].resume;
  const field = 'vendorResumeIdField' in resume && typeof resume.vendorResumeIdField === 'string'
    ? resume.vendorResumeIdField.trim()
    : '';
  if (!field) {
    throw new Error(`Agent ${agentId} does not declare a vendor resume metadata field`);
  }
  return field;
}

export function createVendorResumeIdMetadataPublisher(params: Readonly<{
  agentId: AgentId;
  getMetadataSnapshot: () => Metadata | null;
  updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
}>) {
  const metadataField = resolveVendorResumeIdField(params.agentId);
  let published: Readonly<{ generation: number; vendorSessionId: string }> | null = null;
  let inFlight: Readonly<{
    generation: number;
    vendorSessionId: string;
    promise: Promise<void>;
  }> | null = null;

  const persistBound = async (event: AcpBoundSessionIdentity): Promise<void> => {
    const vendorSessionId = typeof event.vendorSessionId === 'string'
      ? event.vendorSessionId.trim()
      : '';
    if (!vendorSessionId) {
      throw new Error('Cannot publish an empty bound vendor session identity');
    }

    if (published?.generation === event.generation && published.vendorSessionId === vendorSessionId) return;

    const metadataSnapshot = params.getMetadataSnapshot();
    const persistedResumeId = metadataSnapshot
      ? (metadataSnapshot as unknown as Readonly<Record<string, unknown>>)[metadataField]
      : undefined;
    // A metadata-backed resume already has the durability that creation must establish. Requiring
    // a redundant server acknowledgement here can turn a successful provider load into a fresh
    // session fallback; non-durable resume sources still take the acknowledged write path below.
    if (
      event.operation === 'resume'
      && typeof persistedResumeId === 'string'
      && persistedResumeId.trim() === vendorSessionId
    ) {
      published = { generation: event.generation, vendorSessionId };
      return;
    }

    if (inFlight) {
      if (inFlight.generation === event.generation && inFlight.vendorSessionId === vendorSessionId) {
        return await inFlight.promise;
      }
      await inFlight.promise;
      if (published?.generation === event.generation && published.vendorSessionId === vendorSessionId) return;
    }

    const promise = Promise.resolve(params.updateMetadata((metadata) => ({
      ...metadata,
      [metadataField]: vendorSessionId,
    })));
    inFlight = { generation: event.generation, vendorSessionId, promise };
    try {
      await promise;
      published = { generation: event.generation, vendorSessionId };
    } finally {
      if (inFlight?.promise === promise) inFlight = null;
    }
  };

  return { persistBound };
}
