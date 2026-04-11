import { readAgentRuntimeDescriptorV1ForProvider } from '@happier-dev/protocol';

import { normalizeCodexBackendMode } from '../../providerSettings/definitions/codex.js';
import { readCodexRuntimeDescriptorProviderExtra } from '../../sessionControls/codexRuntimeDescriptorExtra.js';
import {
  asRecord,
  normalizeCodexConnectedServiceFields,
  normalizeCodexHome,
  normalizeTrimmedString,
} from '../../sessionControls/runtimeDescriptorShared.js';
import type { SharedRuntimeDescriptorByProviderId } from '../../sessionControls/runtimeDescriptorTypes.js';

export function readCodexSessionMetadataRuntimeDescriptor(
  metadataRecord: Record<string, unknown>,
): SharedRuntimeDescriptorByProviderId['codex'] | null {
  const rawDescriptor = asRecord(metadataRecord.agentRuntimeDescriptorV1);
  const rawProvider = rawDescriptor?.providerId === 'codex' ? asRecord(rawDescriptor.provider) : null;
  const descriptor = readAgentRuntimeDescriptorV1ForProvider(metadataRecord.agentRuntimeDescriptorV1, 'codex');
  const providerExtra = readCodexRuntimeDescriptorProviderExtra(rawProvider?.providerExtra);
  const provider = descriptor?.provider ?? rawProvider;
  if (!provider) return null;

  const home = providerExtra?.home ?? normalizeCodexHome(provider.home);
  const codexConnectedServiceFields = normalizeCodexConnectedServiceFields({
    home,
    connectedServiceId: providerExtra?.connectedServiceId ?? normalizeTrimmedString(provider.connectedServiceId),
    connectedServiceProfileId: providerExtra?.connectedServiceProfileId ?? normalizeTrimmedString(provider.connectedServiceProfileId),
    homePath: providerExtra?.homePath ?? normalizeTrimmedString(provider.homePath),
  });

  return {
    providerId: 'codex',
    backendMode: providerExtra?.backendMode ?? normalizeCodexBackendMode(provider.backendMode),
    vendorSessionId: providerExtra?.vendorSessionId ?? normalizeTrimmedString(provider.vendorSessionId),
    home,
    connectedServiceId: codexConnectedServiceFields.connectedServiceId,
    connectedServiceProfileId: codexConnectedServiceFields.connectedServiceProfileId,
    homePath: codexConnectedServiceFields.homePath,
  };
}
