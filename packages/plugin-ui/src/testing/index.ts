/**
 * Semantic-only RNW mount support for the SDK-owned Plugin UI testkit.
 *
 * This public entry deliberately exports no DOM nodes, React roots, native
 * trees, or host-private controllers. The SDK fixture remains the owner of
 * lifecycle, semantic queries, actions, cancellation, and disposal.
 */
export { createPluginUiRnwSemanticSurfaceAdapter } from './rnwSemanticAdapter.js';
export type {
  PluginUiRnwSemanticSurfaceAdapterOptions,
} from './rnwSemanticAdapter.js';
