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

function readRuntimeHandleFromProviderExtra(provider: Record<string, unknown>): Readonly<Record<string, unknown>> | null {
  const providerExtra = asRecord(provider.providerExtra);
  if (!providerExtra) return null;
  return asRecord(providerExtra.runtimeHandle);
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

  const providerReader = getRuntimeDescriptorReader(parsed.providerId);
  if (providerReader) {
    const providerDescriptor = providerReader(metadataRecord);
    if (providerDescriptor) {
      return {
        providerId: providerDescriptor.providerId,
        runtimeKind: normalizeTrimmedString(providerDescriptor.runtimeKind),
        providerSessionId: normalizeTrimmedString(providerDescriptor.providerSessionId),
        runtimeHandle: readRuntimeHandleFromProviderExtra(parsed.provider as Record<string, unknown>)
          ?? providerDescriptor.runtimeHandle,
        rawProvider: parsed.provider as Readonly<Record<string, unknown>>,
      };
    }
  }

  const provider = asRecord(parsed.provider);
  if (!provider) return null;
  return {
    providerId: parsed.providerId,
    runtimeKind: normalizeTrimmedString(provider.backendMode),
    providerSessionId: readProviderSessionIdCompat(provider),
    runtimeHandle: readRuntimeHandleFromProviderExtra(provider),
    rawProvider: provider,
  };
}
