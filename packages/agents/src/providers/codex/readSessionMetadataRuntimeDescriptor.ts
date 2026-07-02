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

type CodexRuntimeDescriptor = SharedRuntimeDescriptorByProviderId['codex'];

export type CodexSessionMetadataConnectedServiceBinding = Readonly<
  | { source: 'native' }
  | {
      source: 'connected';
      selection: 'profile';
      profileId: string;
    }
  | {
      source: 'connected';
      selection: 'group';
      groupId: string;
      profileId?: string;
    }
>;

function assignRuntimeHandleValue(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined) {
    target[key] = value;
  }
}

function readProviderSessionIdCompat(provider: Readonly<Record<string, unknown>>): string | null {
  return normalizeTrimmedString(provider.providerSessionId)
    ?? normalizeTrimmedString(provider.vendorSessionId); // legacy vendorSessionId read-compat
}

function buildCodexRuntimeHandle(params: Readonly<{
  backendMode: CodexRuntimeDescriptor['backendMode'];
  providerSessionId: string | null;
  home: CodexRuntimeDescriptor['home'];
  connectedServiceId: string | null;
  connectedServiceProfileId: string | null;
  connectedServiceGroupId: string | null;
  homePath: string | null;
}>): Readonly<Record<string, unknown>> | null {
  const runtimeHandle: Record<string, unknown> = {};
  assignRuntimeHandleValue(runtimeHandle, 'backendMode', params.backendMode);
  assignRuntimeHandleValue(runtimeHandle, 'providerSessionId', params.providerSessionId);
  assignRuntimeHandleValue(runtimeHandle, 'home', params.home);
  assignRuntimeHandleValue(runtimeHandle, 'connectedServiceId', params.connectedServiceId);
  assignRuntimeHandleValue(runtimeHandle, 'connectedServiceProfileId', params.connectedServiceProfileId);
  assignRuntimeHandleValue(runtimeHandle, 'connectedServiceGroupId', params.connectedServiceGroupId);
  assignRuntimeHandleValue(runtimeHandle, 'homePath', params.homePath);
  return Object.keys(runtimeHandle).length > 0 ? runtimeHandle : null;
}

function readLegacyCodexSessionMetadataRuntimeDescriptor(
  metadataRecord: Record<string, unknown>,
): CodexRuntimeDescriptor | null {
  const backendMode = normalizeCodexBackendMode(metadataRecord.codexBackendMode);
  if (!backendMode) return null;

  const providerSessionId = normalizeTrimmedString(metadataRecord.codexSessionId);
  const runtimeHandle = buildCodexRuntimeHandle({
    backendMode,
    providerSessionId,
    home: null,
    connectedServiceId: null,
    connectedServiceProfileId: null,
    connectedServiceGroupId: null,
    homePath: null,
  });

  return {
    providerId: 'codex',
    runtimeKind: backendMode,
    backendMode,
    providerSessionId,
    runtimeHandle,
    home: null,
    connectedServiceId: null,
    connectedServiceProfileId: null,
    connectedServiceGroupId: null,
    homePath: null,
  };
}

export function readGenericCodexSessionMetadataRuntimeDescriptor(
  metadataRecord: Record<string, unknown>,
): CodexRuntimeDescriptor | null {
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
    connectedServiceGroupId: providerExtra?.connectedServiceGroupId ?? normalizeTrimmedString(provider.connectedServiceGroupId),
    homePath: providerExtra?.homePath ?? normalizeTrimmedString(provider.homePath),
  });
  const backendMode = providerExtra?.backendMode ?? normalizeCodexBackendMode(provider.backendMode);
  const providerSessionId = providerExtra?.providerSessionId ?? readProviderSessionIdCompat(provider);

  return {
    providerId: 'codex',
    runtimeKind: backendMode,
    backendMode,
    providerSessionId,
    runtimeHandle: buildCodexRuntimeHandle({
      backendMode,
      providerSessionId,
      home,
      connectedServiceId: codexConnectedServiceFields.connectedServiceId,
      connectedServiceProfileId: codexConnectedServiceFields.connectedServiceProfileId,
      connectedServiceGroupId: codexConnectedServiceFields.connectedServiceGroupId,
      homePath: codexConnectedServiceFields.homePath,
    }),
    home,
    connectedServiceId: codexConnectedServiceFields.connectedServiceId,
    connectedServiceProfileId: codexConnectedServiceFields.connectedServiceProfileId,
    connectedServiceGroupId: codexConnectedServiceFields.connectedServiceGroupId,
    homePath: codexConnectedServiceFields.homePath,
  };
}

export function readCodexSessionMetadataRuntimeDescriptor(
  metadataRecord: Record<string, unknown>,
): CodexRuntimeDescriptor | null {
  return readGenericCodexSessionMetadataRuntimeDescriptor(metadataRecord)
    ?? readLegacyCodexSessionMetadataRuntimeDescriptor(metadataRecord);
}

export function readCodexSessionMetadataConnectedServiceBindings(
  metadata: unknown,
): Readonly<Record<string, CodexSessionMetadataConnectedServiceBinding>> {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return {};

  const descriptor = readCodexSessionMetadataRuntimeDescriptor(metadataRecord);
  if (descriptor?.home !== 'connectedService' || !descriptor.connectedServiceId) return {};

  if (descriptor.connectedServiceGroupId) {
    return {
      [descriptor.connectedServiceId]: {
        source: 'connected',
        selection: 'group',
        groupId: descriptor.connectedServiceGroupId,
        ...(descriptor.connectedServiceProfileId ? { profileId: descriptor.connectedServiceProfileId } : {}),
      },
    };
  }

  if (!descriptor.connectedServiceProfileId) return {};
  return {
    [descriptor.connectedServiceId]: {
      source: 'connected',
      selection: 'profile',
      profileId: descriptor.connectedServiceProfileId,
    },
  };
}
