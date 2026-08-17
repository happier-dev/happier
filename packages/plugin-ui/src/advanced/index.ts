/**
 * Explicit composition hooks for trusted authors and host-owned test fixtures.
 *
 * Ordinary artifact entries use `defineUiSurface` from the package root. These
 * APIs are intentionally separate because their callers own provider lifetime
 * or Resource-store construction and therefore also own the corresponding
 * host/context boundary.
 */
export {
  PluginUiProvider,
  type PluginUiProviderProps,
} from '../components/PluginUiProvider.js';
export {
  PluginHostApiProvider,
  type PluginHostApiProviderProps,
} from '../hostApi/context.js';
export {
  createPluginUiHostApiResourceClient,
  createPluginUiResourceStore,
  type PluginUiResourceAccountLifetime,
  type PluginUiResourceClient,
  type PluginUiResourceEntry,
  type PluginUiResourceStore,
} from '../hostApi/resourceStore.js';
