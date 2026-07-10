import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol';

import { getRuntimeDescriptorReader } from './runtimeDescriptorReaderRegistry.js';
import { asRecord, normalizeTrimmedString } from './runtimeDescriptorShared.js';

export type RuntimeDescriptor = Readonly<{
  providerId: string;
  runtimeKind: string | null;
  providerSessionId: string | null;
  runtimeHandle: Readonly<Record<string, unknown>> | null;
  rawProvider: Readonly<Record<string, unknown>>;
}>;

function readRuntimeHandleFromAgentExtra(agentPayload: Record<string, unknown>): Readonly<Record<string, unknown>> | null {
  const agentExtra = asRecord(agentPayload.agentExtra);
  if (!agentExtra) return null;
  return asRecord(agentExtra.runtimeHandle);
}

function readProviderSessionIdCompat(provider: Readonly<Record<string, unknown>>): string | null {
  return normalizeTrimmedString(provider.providerSessionId)
    ?? normalizeTrimmedString(provider.vendorSessionId); // legacy vendorSessionId read-compat
}

export function readNormalizedRuntimeDescriptor(metadata: unknown): RuntimeDescriptor | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;

  const parsed = readRuntimeDescriptorV1FromMetadata(metadataRecord);
  if (!parsed) return null;

  const providerReader = getRuntimeDescriptorReader(parsed.agentId);
  if (providerReader) {
    const providerDescriptor = providerReader(metadataRecord);
    if (providerDescriptor) {
      return {
        providerId: providerDescriptor.agentId,
        runtimeKind: normalizeTrimmedString(providerDescriptor.runtimeKind),
        providerSessionId: normalizeTrimmedString(providerDescriptor.providerSessionId),
        runtimeHandle: readRuntimeHandleFromAgentExtra(parsed.agent as Record<string, unknown>)
          ?? providerDescriptor.runtimeHandle,
        rawProvider: parsed.agent as Readonly<Record<string, unknown>>,
      };
    }
  }

  const agentPayload = asRecord(parsed.agent);
  if (!agentPayload) return null;
  return {
    providerId: parsed.agentId,
    runtimeKind: normalizeTrimmedString(agentPayload.backendMode),
    providerSessionId: readProviderSessionIdCompat(agentPayload),
    runtimeHandle: readRuntimeHandleFromAgentExtra(agentPayload),
    rawProvider: agentPayload,
  };
}
