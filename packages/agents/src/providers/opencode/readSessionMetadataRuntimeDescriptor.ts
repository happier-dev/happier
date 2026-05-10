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

function assignRuntimeHandleValue(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined) {
    target[key] = value;
  }
}

function buildOpenCodeRuntimeHandle(params: Readonly<{
  backendMode: SharedRuntimeDescriptorByProviderId['opencode']['backendMode'];
  vendorSessionId: string | null;
  serverBaseUrl: string | null;
  serverBaseUrlExplicit: boolean;
}>): Readonly<Record<string, unknown>> | null {
  const runtimeHandle: Record<string, unknown> = {};
  assignRuntimeHandleValue(runtimeHandle, 'backendMode', params.backendMode);
  assignRuntimeHandleValue(runtimeHandle, 'vendorSessionId', params.vendorSessionId);
  assignRuntimeHandleValue(runtimeHandle, 'serverBaseUrl', params.serverBaseUrl);
  if (params.serverBaseUrlExplicit) {
    runtimeHandle.serverBaseUrlExplicit = true;
  }
  return Object.keys(runtimeHandle).length > 0 ? runtimeHandle : null;
}

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
  const backendMode = providerExtra?.backendMode ?? normalizeOpenCodeBackendMode(provider.backendMode);
  const vendorSessionId = providerExtra?.vendorSessionId ?? normalizeTrimmedString(provider.vendorSessionId);
  const serverBaseUrl = providerExtra?.serverBaseUrl ?? normalizeOpenCodeServerBaseUrl(provider.serverBaseUrl);
  const serverBaseUrlExplicit = providerExtra?.serverBaseUrlExplicit ?? normalizeOpenCodeServerBaseUrlExplicit(provider.serverBaseUrlExplicit);

  return {
    providerId: 'opencode',
    runtimeKind: backendMode,
    backendMode,
    vendorSessionId,
    runtimeHandle: buildOpenCodeRuntimeHandle({
      backendMode,
      vendorSessionId,
      serverBaseUrl,
      serverBaseUrlExplicit,
    }),
    serverBaseUrl,
    serverBaseUrlExplicit,
  };
}
