// Compatibility-only module: canonical session-control adapter registry now lives in `src/runtime/controlSurface/**`.
export {
  PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS,
  getProviderSessionControlAdapter,
  type ProviderSessionControlAdapter,
} from '../runtime/controlSurface/sessionControlAdapterRegistry.js';
