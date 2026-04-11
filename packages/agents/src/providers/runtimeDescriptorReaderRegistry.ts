import { readCodexSessionMetadataRuntimeDescriptor } from './codex/readSessionMetadataRuntimeDescriptor.js';
import { readOpenCodeSessionMetadataRuntimeDescriptor } from './opencode/readSessionMetadataRuntimeDescriptor.js';
import { readPiSessionMetadataRuntimeDescriptor } from './pi/readSessionMetadataRuntimeDescriptor.js';
import type {
  SharedRuntimeDescriptorByProviderId,
  SupportedRuntimeDescriptorProviderId,
} from '../sessionControls/runtimeDescriptorTypes.js';

type ProviderRuntimeDescriptorReaderMap = {
  [K in SupportedRuntimeDescriptorProviderId]: (
    metadataRecord: Record<string, unknown>,
  ) => SharedRuntimeDescriptorByProviderId[K] | null;
};

const PROVIDER_RUNTIME_DESCRIPTOR_READERS: ProviderRuntimeDescriptorReaderMap = {
  codex: readCodexSessionMetadataRuntimeDescriptor,
  opencode: readOpenCodeSessionMetadataRuntimeDescriptor,
  pi: readPiSessionMetadataRuntimeDescriptor,
};

export function getProviderRuntimeDescriptorReader<K extends SupportedRuntimeDescriptorProviderId>(
  providerId: K,
): ProviderRuntimeDescriptorReaderMap[K] {
  return PROVIDER_RUNTIME_DESCRIPTOR_READERS[providerId];
}
