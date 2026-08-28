import { getRuntimeDescriptorReader } from './runtimeDescriptorReaderRegistry.js';
import type {
  KnownProviderRuntimeDescriptor,
  SharedRuntimeDescriptorRuntimeHandle,
} from './runtimeDescriptorTypes.js';
import { asRecord } from './runtimeDescriptorShared.js';

export type SessionMetadataRuntimeDescriptor = Readonly<{
  agentId: string;
  runtimeKind: string | null;
  providerSessionId?: string | null;
  runtimeHandle: SharedRuntimeDescriptorRuntimeHandle | null;
} & Record<string, unknown>>;

export function readSessionMetadataRuntimeDescriptor(
  metadata: unknown,
  providerId: string,
): SessionMetadataRuntimeDescriptor | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;

  // Released Session rows predate runtimeDescriptorV1 and retain flat Agent
  // fields. Keep that translation at this ingress only. Current descriptors
  // are opaque to generic host code and are interpreted by their owning Agent
  // or its focused UI projection.
  if (Object.hasOwn(metadataRecord, 'runtimeDescriptorV1')) return null;
  return getRuntimeDescriptorReader(providerId)?.(metadataRecord) ?? null;
}

export type SessionMetadataConnectedServiceBinding = Readonly<
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

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readConnectedServiceBindingFromDescriptor(
  descriptor: KnownProviderRuntimeDescriptor | null,
): Readonly<Record<string, SessionMetadataConnectedServiceBinding>> {
  const descriptorRecord = asRecord(descriptor);
  if (descriptorRecord?.home !== 'connectedService') return {};

  const connectedServiceId = readNonEmptyString(descriptorRecord.connectedServiceId);
  if (!connectedServiceId) return {};

  const groupId = readNonEmptyString(descriptorRecord.connectedServiceGroupId);
  const profileId = readNonEmptyString(descriptorRecord.connectedServiceProfileId);
  if (groupId) {
    return {
      [connectedServiceId]: {
        source: 'connected',
        selection: 'group',
        groupId,
        ...(profileId ? { profileId } : {}),
      },
    };
  }

  if (!profileId) return {};
  return {
    [connectedServiceId]: {
      source: 'connected',
      selection: 'profile',
      profileId,
    },
  };
}

export function readSessionMetadataConnectedServiceBindings(
  metadata: unknown,
  providerId: string,
): Readonly<Record<string, SessionMetadataConnectedServiceBinding>> {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return {};
  // Current Sessions persist the host-owned connected-services projection.
  // Never reconstruct host state from an Agent-owned current descriptor.
  if (Object.hasOwn(metadataRecord, 'runtimeDescriptorV1')) return {};
  return readConnectedServiceBindingFromDescriptor(
    getRuntimeDescriptorReader(providerId)?.(metadataRecord) ?? null,
  );
}
