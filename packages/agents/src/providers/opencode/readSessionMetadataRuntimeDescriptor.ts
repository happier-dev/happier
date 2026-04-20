import {
  readRawRuntimeDescriptorV1FromMetadata,
  readRuntimeDescriptorV1ForProvider,
  readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/protocol';

import {
  normalizeOpenCodeBackendMode,
  normalizeOpenCodeServerBaseUrl,
  normalizeOpenCodeServerBaseUrlExplicit,
} from '../../providerSettings/definitions/opencode.js';
import { readOpenCodeRuntimeDescriptorProviderExtra } from './runtimeDescriptorExtra.js';
import { asRecord, normalizeTrimmedString } from '../../runtime/identity/runtimeDescriptorShared.js';
import type { SharedRuntimeDescriptorByProviderId } from '../../runtime/identity/runtimeDescriptorTypes.js';

export function readOpenCodeSessionMetadataRuntimeDescriptor(
  metadata: unknown,
): SharedRuntimeDescriptorByProviderId['opencode'] | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;

  const rawDescriptorInput = readRawRuntimeDescriptorV1FromMetadata(metadataRecord);
  const rawDescriptor = asRecord(rawDescriptorInput);
  const rawProvider = rawDescriptor?.providerId === 'opencode' ? asRecord(rawDescriptor.provider) : null;
  const descriptor = readRuntimeDescriptorV1ForProvider(
    readRuntimeDescriptorV1FromMetadata(metadataRecord) ?? rawDescriptorInput,
    'opencode',
  );
  const providerExtra = readOpenCodeRuntimeDescriptorProviderExtra(rawProvider?.providerExtra);
  const provider = descriptor?.provider ?? rawProvider;
  if (!provider) return null;

  return {
    providerId: 'opencode',
    backendMode: providerExtra?.backendMode ?? normalizeOpenCodeBackendMode(provider.backendMode),
    vendorSessionId: providerExtra?.vendorSessionId ?? normalizeTrimmedString(provider.vendorSessionId),
    serverBaseUrl: providerExtra?.serverBaseUrl ?? normalizeOpenCodeServerBaseUrl(provider.serverBaseUrl),
    serverBaseUrlExplicit: providerExtra?.serverBaseUrlExplicit ?? normalizeOpenCodeServerBaseUrlExplicit(provider.serverBaseUrlExplicit),
  };
}
