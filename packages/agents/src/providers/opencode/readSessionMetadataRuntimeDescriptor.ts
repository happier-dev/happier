import { readAgentRuntimeDescriptorV1ForProvider } from '@happier-dev/protocol';

import {
  normalizeOpenCodeBackendMode,
  normalizeOpenCodeServerBaseUrl,
  normalizeOpenCodeServerBaseUrlExplicit,
} from '../../providerSettings/definitions/opencode.js';
import { readOpenCodeRuntimeDescriptorProviderExtra } from './runtimeDescriptorExtra.js';
import { asRecord, normalizeTrimmedString } from '../../sessionControls/runtimeDescriptorShared.js';
import type { SharedRuntimeDescriptorByProviderId } from '../../sessionControls/runtimeDescriptorTypes.js';

export function readOpenCodeSessionMetadataRuntimeDescriptor(
  metadataRecord: Record<string, unknown>,
): SharedRuntimeDescriptorByProviderId['opencode'] | null {
  const rawDescriptor = asRecord(metadataRecord.agentRuntimeDescriptorV1);
  const rawProvider = rawDescriptor?.providerId === 'opencode' ? asRecord(rawDescriptor.provider) : null;
  const descriptor = readAgentRuntimeDescriptorV1ForProvider(metadataRecord.agentRuntimeDescriptorV1, 'opencode');
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
