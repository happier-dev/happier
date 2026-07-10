import {
  readRuntimeDescriptorV1ForAgent,
  readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/protocol';

import {
  asRecord,
  normalizeTrimmedString,
} from './runtimeDescriptorShared.js';
import type {
  RuntimeDescriptorReaderMap,
  SharedRuntimeDescriptorByProviderId,
  SupportedRuntimeDescriptorProviderId,
} from './runtimeDescriptorTypes.js';

export type ProviderSessionIdRuntimeDescriptorReaderContribution<
  TProviderId extends SupportedRuntimeDescriptorProviderId,
> = Readonly<{
  providerId: TProviderId;
  runtimeHandle: 'providerSessionId';
}>;

function buildProviderSessionIdRuntimeHandle(providerSessionId: string | null): Readonly<Record<string, unknown>> | null {
  return providerSessionId ? { providerSessionId } : null;
}

function readProviderSessionIdCompat(provider: Readonly<Record<string, unknown>>): string | null {
  return normalizeTrimmedString(provider.providerSessionId)
    ?? normalizeTrimmedString(provider.vendorSessionId); // legacy vendorSessionId read-compat
}

export function createProviderSessionIdRuntimeDescriptorReader<
  TProviderId extends SupportedRuntimeDescriptorProviderId,
>(
  contribution: ProviderSessionIdRuntimeDescriptorReaderContribution<TProviderId>,
): RuntimeDescriptorReaderMap[TProviderId] {
  return ((metadata: unknown): SharedRuntimeDescriptorByProviderId[TProviderId] | null => {
    const metadataRecord = asRecord(metadata);
    if (!metadataRecord) return null;

    const descriptor = readRuntimeDescriptorV1ForAgent(
      readRuntimeDescriptorV1FromMetadata(metadataRecord),
      contribution.providerId,
    );
    if (!descriptor) return null;

    const providerSessionId = readProviderSessionIdCompat(descriptor.agent);
    const sharedDescriptor = {
      agentId: contribution.providerId,
      runtimeKind: null,
      providerSessionId,
      runtimeHandle: buildProviderSessionIdRuntimeHandle(providerSessionId),
    };

    return sharedDescriptor as unknown as SharedRuntimeDescriptorByProviderId[TProviderId];
  }) as RuntimeDescriptorReaderMap[TProviderId];
}
