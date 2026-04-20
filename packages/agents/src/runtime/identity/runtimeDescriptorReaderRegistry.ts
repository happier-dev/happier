import { readCodexSessionMetadataRuntimeDescriptor } from '../../providers/codex/readSessionMetadataRuntimeDescriptor.js';
import { readOpenCodeSessionMetadataRuntimeDescriptor } from '../../providers/opencode/readSessionMetadataRuntimeDescriptor.js';
import { readPiSessionMetadataRuntimeDescriptor } from '../../providers/pi/readSessionMetadataRuntimeDescriptor.js';
import type {
  SharedRuntimeDescriptorByProviderId,
  SupportedRuntimeDescriptorProviderId,
} from './runtimeDescriptorTypes.js';

export const RUNTIME_DESCRIPTOR_PROVIDER_IDS = [
  'codex',
  'opencode',
  'pi',
] as const satisfies readonly SupportedRuntimeDescriptorProviderId[];

type RuntimeDescriptorReaderMap = {
  [K in SupportedRuntimeDescriptorProviderId]: (
    metadataRecord: Record<string, unknown>,
  ) => SharedRuntimeDescriptorByProviderId[K] | null;
};

const RUNTIME_DESCRIPTOR_READERS = {
  codex: readCodexSessionMetadataRuntimeDescriptor,
  opencode: readOpenCodeSessionMetadataRuntimeDescriptor,
  pi: readPiSessionMetadataRuntimeDescriptor,
} satisfies RuntimeDescriptorReaderMap;

export function getRuntimeDescriptorReader<K extends SupportedRuntimeDescriptorProviderId>(
  providerId: K,
): RuntimeDescriptorReaderMap[K] {
  return RUNTIME_DESCRIPTOR_READERS[providerId];
}

export function isSupportedRuntimeDescriptorProviderId(providerId: string): providerId is SupportedRuntimeDescriptorProviderId {
  return (RUNTIME_DESCRIPTOR_PROVIDER_IDS as readonly string[]).includes(providerId);
}
