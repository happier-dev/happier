import { getRuntimeDescriptorReader } from './runtimeDescriptorReaderRegistry.js';
import type {
  KnownProviderRuntimeDescriptor,
  SharedRuntimeDescriptorByProviderId,
  SupportedRuntimeDescriptorProviderId,
} from './runtimeDescriptorTypes.js';
import { asRecord } from './runtimeDescriptorShared.js';

export function readSessionMetadataRuntimeDescriptor(
  metadata: unknown,
  providerId: 'codex',
): SharedRuntimeDescriptorByProviderId['codex'] | null;
export function readSessionMetadataRuntimeDescriptor(
  metadata: unknown,
  providerId: 'opencode',
): SharedRuntimeDescriptorByProviderId['opencode'] | null;
export function readSessionMetadataRuntimeDescriptor(
  metadata: unknown,
  providerId: 'pi',
): SharedRuntimeDescriptorByProviderId['pi'] | null;
export function readSessionMetadataRuntimeDescriptor(
  metadata: unknown,
  providerId: SupportedRuntimeDescriptorProviderId,
): SharedRuntimeDescriptorByProviderId[SupportedRuntimeDescriptorProviderId] | null;
export function readSessionMetadataRuntimeDescriptor(
  metadata: unknown,
  providerId: SupportedRuntimeDescriptorProviderId,
): SharedRuntimeDescriptorByProviderId[SupportedRuntimeDescriptorProviderId] | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;
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
  return readConnectedServiceBindingFromDescriptor(
    getRuntimeDescriptorReader(providerId)?.(metadataRecord) ?? null,
  );
}
