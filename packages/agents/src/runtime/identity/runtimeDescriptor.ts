import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol';

import {
  getRuntimeDescriptorReader,
  isSupportedRuntimeDescriptorProviderId,
} from './runtimeDescriptorReaderRegistry.js';
import { asRecord, normalizeTrimmedString } from './runtimeDescriptorShared.js';

export type RuntimeDescriptor = Readonly<{
  providerId: string;
  runtimeKind: string | null;
  vendorSessionId: string | null;
  runtimeHandle: Readonly<Record<string, unknown>> | null;
  rawProvider: Readonly<Record<string, unknown>>;
}>;

function readRuntimeHandleFromProviderExtra(provider: Record<string, unknown>): Readonly<Record<string, unknown>> | null {
  const providerExtra = asRecord(provider.providerExtra);
  if (!providerExtra) return null;
  return asRecord(providerExtra.runtimeHandle);
}

export function readNormalizedRuntimeDescriptor(metadata: unknown): RuntimeDescriptor | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;

  const parsed = readRuntimeDescriptorV1FromMetadata(metadataRecord);
  if (!parsed) return null;

  if (isSupportedRuntimeDescriptorProviderId(parsed.providerId)) {
    const providerReader = getRuntimeDescriptorReader(parsed.providerId);
    const providerDescriptor = providerReader(metadataRecord);
    if (providerDescriptor) {
      return {
        providerId: providerDescriptor.providerId,
        runtimeKind: normalizeTrimmedString(providerDescriptor.runtimeKind),
        vendorSessionId: normalizeTrimmedString(providerDescriptor.vendorSessionId),
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
    vendorSessionId: normalizeTrimmedString(provider.vendorSessionId),
    runtimeHandle: readRuntimeHandleFromProviderExtra(provider),
    rawProvider: provider,
  };
}
