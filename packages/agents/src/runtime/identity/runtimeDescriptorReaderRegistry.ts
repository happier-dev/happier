import {
  GENERATED_RUNTIME_DESCRIPTOR_READER_PROVIDER_IDS,
  GENERATED_RUNTIME_DESCRIPTOR_READERS,
  type GeneratedRuntimeDescriptorReaderProviderId,
} from '../../generated/runtimeDescriptorReaders.js';
import type {
  RuntimeDescriptorReaderMap,
  SupportedRuntimeDescriptorProviderId,
} from './runtimeDescriptorTypes.js';

export const RUNTIME_DESCRIPTOR_PROVIDER_IDS =
  GENERATED_RUNTIME_DESCRIPTOR_READER_PROVIDER_IDS satisfies readonly SupportedRuntimeDescriptorProviderId[];

const RUNTIME_DESCRIPTOR_READERS =
  GENERATED_RUNTIME_DESCRIPTOR_READERS satisfies Readonly<
    Pick<RuntimeDescriptorReaderMap, GeneratedRuntimeDescriptorReaderProviderId>
  >;

export function getRuntimeDescriptorReader<K extends GeneratedRuntimeDescriptorReaderProviderId>(
  providerId: K,
): RuntimeDescriptorReaderMap[K];
export function getRuntimeDescriptorReader(
  providerId: string,
): RuntimeDescriptorReaderMap[SupportedRuntimeDescriptorProviderId] | null;
export function getRuntimeDescriptorReader(
  providerId: string,
): RuntimeDescriptorReaderMap[SupportedRuntimeDescriptorProviderId] | null {
  if (!isSupportedRuntimeDescriptorProviderId(providerId)) return null;
  return RUNTIME_DESCRIPTOR_READERS[providerId as GeneratedRuntimeDescriptorReaderProviderId];
}

export function isSupportedRuntimeDescriptorProviderId(providerId: string): providerId is SupportedRuntimeDescriptorProviderId {
  return (RUNTIME_DESCRIPTOR_PROVIDER_IDS as readonly string[]).includes(providerId);
}
