import {
  readRawRuntimeDescriptorV1FromMetadata,
  readRuntimeDescriptorV1ForProvider,
  readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/protocol';

import { normalizeCodexBackendMode } from '../../providerSettings/definitions/codex.js';
import { readCodexRuntimeDescriptorProviderExtra } from './runtimeDescriptorExtra.js';
import {
  asRecord,
  normalizeTrimmedString,
} from '../../runtime/identity/runtimeDescriptorShared.js';
import { normalizeCodexConnectedServiceFields, normalizeCodexHome } from './runtimeDescriptorShared.js';
import type { SharedRuntimeDescriptorByProviderId } from '../../runtime/identity/runtimeDescriptorTypes.js';

export function readCodexSessionMetadataRuntimeDescriptor(
  metadataRecord: Record<string, unknown>,
): SharedRuntimeDescriptorByProviderId['codex'] | null {
  const rawDescriptorInput = readRawRuntimeDescriptorV1FromMetadata(metadataRecord);
  const rawDescriptor = asRecord(rawDescriptorInput);
  const rawProvider = rawDescriptor?.providerId === 'codex' ? asRecord(rawDescriptor.provider) : null;
  const descriptor = readRuntimeDescriptorV1ForProvider(
    readRuntimeDescriptorV1FromMetadata(metadataRecord) ?? rawDescriptorInput,
    'codex',
  );
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
