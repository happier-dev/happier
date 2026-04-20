import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol';

import {
  getRuntimeDescriptorReader,
  isSupportedRuntimeDescriptorProviderId,
} from './runtimeDescriptorReaderRegistry.js';
import { asRecord, normalizeTrimmedString } from './runtimeDescriptorShared.js';
import type { KnownProviderRuntimeDescriptor } from './runtimeDescriptorTypes.js';

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

function assignRuntimeHandleValue(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined) {
    target[key] = value;
  }
}

function buildRuntimeHandleFromKnownProviderDescriptor(
  providerDescriptor: KnownProviderRuntimeDescriptor,
): Readonly<Record<string, unknown>> | null {
  const runtimeHandle: Record<string, unknown> = {};

  switch (providerDescriptor.providerId) {
    case 'codex':
      assignRuntimeHandleValue(runtimeHandle, 'backendMode', providerDescriptor.backendMode);
      assignRuntimeHandleValue(runtimeHandle, 'vendorSessionId', providerDescriptor.vendorSessionId);
      assignRuntimeHandleValue(runtimeHandle, 'home', providerDescriptor.home);
      assignRuntimeHandleValue(runtimeHandle, 'connectedServiceId', providerDescriptor.connectedServiceId);
      assignRuntimeHandleValue(runtimeHandle, 'connectedServiceProfileId', providerDescriptor.connectedServiceProfileId);
      assignRuntimeHandleValue(runtimeHandle, 'homePath', providerDescriptor.homePath);
      break;
    case 'opencode':
      assignRuntimeHandleValue(runtimeHandle, 'backendMode', providerDescriptor.backendMode);
      assignRuntimeHandleValue(runtimeHandle, 'vendorSessionId', providerDescriptor.vendorSessionId);
      assignRuntimeHandleValue(runtimeHandle, 'serverBaseUrl', providerDescriptor.serverBaseUrl);
      if (providerDescriptor.serverBaseUrlExplicit) {
        runtimeHandle.serverBaseUrlExplicit = true;
      }
      break;
    case 'pi':
      assignRuntimeHandleValue(runtimeHandle, 'vendorSessionId', providerDescriptor.vendorSessionId);
      break;
  }

  return Object.keys(runtimeHandle).length > 0 ? runtimeHandle : null;
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
      const runtimeKind = 'backendMode' in providerDescriptor ? normalizeTrimmedString(providerDescriptor.backendMode) : null;
      return {
        providerId: providerDescriptor.providerId,
        runtimeKind,
        vendorSessionId: normalizeTrimmedString(providerDescriptor.vendorSessionId),
        runtimeHandle: readRuntimeHandleFromProviderExtra(parsed.provider as Record<string, unknown>)
          ?? buildRuntimeHandleFromKnownProviderDescriptor(providerDescriptor),
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
