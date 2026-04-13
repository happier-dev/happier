import { getProviderRuntimeDescriptorReader } from './runtimeDescriptorReaderRegistry.js';
import { asRecord } from '../sessionControls/runtimeDescriptorShared.js';
import type {
  SharedRuntimeDescriptorByProviderId,
  SupportedRuntimeDescriptorProviderId,
} from '../sessionControls/runtimeDescriptorTypes.js';

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
  return getProviderRuntimeDescriptorReader(providerId)(metadataRecord);
}
