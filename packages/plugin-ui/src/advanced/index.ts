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
/**
 * Byte admission for a renderable packaged image.
 *
 * A host adapter that acquires image bytes outside the Resource store admits
 * them here, off the render path, exactly as the store does when a read
 * resolves. Presentation can only read what an owner admitted, so an
 * unadmitted or over-ceiling mark presents the neutral text fallback instead of
 * making a render pay to find out.
 */
export {
  HAPPIER_MAX_RENDERABLE_IMAGE_BYTES,
  HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS,
  HAPPIER_RENDERABLE_IMAGE_CONTENT_TYPE,
  materializeHappierRenderableImage,
  type HappierRenderableImageSource,
} from '../presentation/content/renderableImage.js';
export {
  createPluginUiHostApiResourceClient,
  createPluginUiResourceStore,
  type PluginUiResourceAccountLifetime,
  type PluginUiResourceClient,
  type PluginUiResourceEntry,
  type PluginUiResourceStore,
} from '../hostApi/resourceStore.js';
