import { getRuntimeDescriptorReader } from '../runtime/identity/runtimeDescriptorReaderRegistry.js';
import type {
  SharedRuntimeDescriptorByProviderId,
  SupportedRuntimeDescriptorProviderId,
} from '../runtime/identity/runtimeDescriptorTypes.js';
import { asRecord } from '../runtime/identity/runtimeDescriptorShared.js';

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
): SharedRuntimeDescriptorByProviderId[SupportedRuntimeDescriptorProviderId] | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;
  return getRuntimeDescriptorReader(providerId)(metadataRecord);
}
