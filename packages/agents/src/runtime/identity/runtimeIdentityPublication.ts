import type { RuntimeDescriptor } from './runtimeDescriptor.js';

export type RuntimeIdentityPublication = Readonly<{
  runtimeDescriptor: RuntimeDescriptor | null;
  compatibilitySources: ReadonlyArray<'runtimeDescriptorV1' | 'legacy_provider_metadata'>;
}>;

export function publishRuntimeIdentity(params: Readonly<{
  runtimeDescriptor: RuntimeDescriptor | null;
  compatibilitySources?: ReadonlyArray<'runtimeDescriptorV1' | 'legacy_provider_metadata'>;
}>): RuntimeIdentityPublication {
  return {
    runtimeDescriptor: params.runtimeDescriptor,
    compatibilitySources: params.compatibilitySources ?? ['runtimeDescriptorV1'],
  };
}
