/**
 * Browser-safe manifest declaration primitives. Manifest ingestion, catalog
 * normalization, and installation policy intentionally remain on the broader
 * manifest entrypoint; these are the exact values author tooling can use.
 */
export {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from '../actions/jsonSchemaValidation.js';
export type { PluginJsonSchemaValidator } from '../actions/jsonSchemaValidation.js';
export {
  PLUGIN_UI_MAX_RENDERER_CHAIN_LENGTH,
  PluginUiRendererChainBindingV1Schema,
  type PluginUiRendererChainBindingV1,
} from '../contributions/ui/rendererChainBinding.js';

export {
  createPluginContributionIdentity,
  PluginContributionIdentityV1JsonSchema,
  PluginContributionIdentityV1Schema,
  type PluginContributionIdentityV1 as PluginContributionIdentity,
} from '../contributionIdentity.js';

export {
  PluginIdJsonSchema,
  PluginIdSchema,
  type PluginId,
} from '../pluginId.js';
