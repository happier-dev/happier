// Compatibility-only module: canonical runtime descriptor reader registry now lives in `src/runtime/identity/**`.
export {
  RUNTIME_DESCRIPTOR_PROVIDER_IDS,
  RUNTIME_DESCRIPTOR_PROVIDER_IDS as PROVIDER_RUNTIME_DESCRIPTOR_PROVIDER_IDS,
  getRuntimeDescriptorReader,
  getRuntimeDescriptorReader as getProviderRuntimeDescriptorReader,
  isSupportedRuntimeDescriptorProviderId,
} from '../runtime/identity/runtimeDescriptorReaderRegistry.js';
