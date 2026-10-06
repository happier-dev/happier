/**
 * Browser authoring exposes declaration primitives only. Structural parsing
 * remains on the Node manifest owner because it performs canonical ingestion.
 */
export { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
export { createPluginContributionIdentity, PluginContributionIdentityV1JsonSchema, PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
export { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
export { PluginIdJsonSchema, PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
export type {
  PluginContributionIdentity,
  PluginJsonSchemaValidator,
} from '@happier-dev/protocol/plugins/manifest/declaration';

export type {
  ParsedPluginManifest,
  PluginContributes,
  PluginDeclarativeActionNodeV2,
  PluginDeclarativeActionPanelNodeV2,
  PluginDeclarativeCollectionListNodeV2,
  PluginDeclarativeControlV2,
  PluginDeclarativeItemNodeV2,
  PluginDeclarativeListNodeV2,
  PluginDeclarativeMetadataNodeV2,
  PluginDeclarativeNodeV2,
  PluginDeclarativeSectionNodeV2,
  PluginDeclarativeStateNodeV2,
  PluginDeclarativeTargetedSurfaceNodeV2,
  PluginDeclarativeTargetedSurfaceReferenceV1,
  PluginDeclarativeToneV2,
  PluginLocalizedStringV2,
  PluginManifest,
  PluginManifestDiagnostic,
  PluginManifestParseResult,
  PromptAssetCapabilities,
  PromptAssetTypeDescriptor,
} from './manifest.js';
