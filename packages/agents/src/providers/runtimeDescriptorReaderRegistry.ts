import { readCodexSessionMetadataRuntimeDescriptor } from './codex/readSessionMetadataRuntimeDescriptor.js';
import { readOpenCodeSessionMetadataRuntimeDescriptor } from './opencode/readSessionMetadataRuntimeDescriptor.js';
import { readPiSessionMetadataRuntimeDescriptor } from './pi/readSessionMetadataRuntimeDescriptor.js';
import type {
  SharedRuntimeDescriptorByProviderId,
  SupportedRuntimeDescriptorProviderId,
} from '../sessionControls/runtimeDescriptorTypes.js';

export const PROVIDER_RUNTIME_DESCRIPTOR_PROVIDER_IDS = [
  'codex',
  'opencode',
  'pi',
] as const satisfies readonly SupportedRuntimeDescriptorProviderId[];

type ProviderRuntimeDescriptorReaderMap = {
  [K in SupportedRuntimeDescriptorProviderId]: (
    metadataRecord: Record<string, unknown>,
  ) => SharedRuntimeDescriptorByProviderId[K] | null;
};

const PROVIDER_RUNTIME_DESCRIPTOR_READERS = {
  codex: readCodexSessionMetadataRuntimeDescriptor,
  opencode: readOpenCodeSessionMetadataRuntimeDescriptor,
  pi: readPiSessionMetadataRuntimeDescriptor,
} satisfies ProviderRuntimeDescriptorReaderMap;

export function getProviderRuntimeDescriptorReader<K extends SupportedRuntimeDescriptorProviderId>(
  providerId: K,
): ProviderRuntimeDescriptorReaderMap[K] {
  return PROVIDER_RUNTIME_DESCRIPTOR_READERS[providerId];
}
