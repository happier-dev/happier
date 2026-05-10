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

function assignRuntimeHandleValue(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined) {
    target[key] = value;
  }
}

function buildCodexRuntimeHandle(params: Readonly<{
  backendMode: SharedRuntimeDescriptorByProviderId['codex']['backendMode'];
  vendorSessionId: string | null;
  home: SharedRuntimeDescriptorByProviderId['codex']['home'];
  connectedServiceId: string | null;
  connectedServiceProfileId: string | null;
  homePath: string | null;
}>): Readonly<Record<string, unknown>> | null {
  const runtimeHandle: Record<string, unknown> = {};
  assignRuntimeHandleValue(runtimeHandle, 'backendMode', params.backendMode);
  assignRuntimeHandleValue(runtimeHandle, 'vendorSessionId', params.vendorSessionId);
  assignRuntimeHandleValue(runtimeHandle, 'home', params.home);
  assignRuntimeHandleValue(runtimeHandle, 'connectedServiceId', params.connectedServiceId);
  assignRuntimeHandleValue(runtimeHandle, 'connectedServiceProfileId', params.connectedServiceProfileId);
  assignRuntimeHandleValue(runtimeHandle, 'homePath', params.homePath);
  return Object.keys(runtimeHandle).length > 0 ? runtimeHandle : null;
}

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
  const backendMode = providerExtra?.backendMode ?? normalizeCodexBackendMode(provider.backendMode);
  const vendorSessionId = providerExtra?.vendorSessionId ?? normalizeTrimmedString(provider.vendorSessionId);

  return {
    providerId: 'codex',
    runtimeKind: backendMode,
    backendMode,
    vendorSessionId,
    runtimeHandle: buildCodexRuntimeHandle({
      backendMode,
      vendorSessionId,
      home,
      connectedServiceId: codexConnectedServiceFields.connectedServiceId,
      connectedServiceProfileId: codexConnectedServiceFields.connectedServiceProfileId,
      homePath: codexConnectedServiceFields.homePath,
    }),
    home,
    connectedServiceId: codexConnectedServiceFields.connectedServiceId,
    connectedServiceProfileId: codexConnectedServiceFields.connectedServiceProfileId,
    homePath: codexConnectedServiceFields.homePath,
  };
}
