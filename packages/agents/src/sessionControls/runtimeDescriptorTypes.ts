// Compatibility-only module: canonical runtime descriptor types now live in `src/runtime/identity/**`.
export type {
  GenericProviderRuntimeDescriptor,
  KnownProviderRuntimeDescriptor,
  SharedRuntimeDescriptorByProviderId,
  SupportedRuntimeDescriptorProviderId,
} from '../runtime/identity/runtimeDescriptorTypes.js';
