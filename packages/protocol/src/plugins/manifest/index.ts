export {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
  normalizePluginJsonSchema,
  preparePluginJsonSchema,
} from '../actions/jsonSchemaValidation.js';
export type {
  PreparedPluginJsonSchema,
  PluginJsonSchemaValidator,
} from '../actions/jsonSchemaValidation.js';
export { zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';
export type { PluginJsonSchemaV2 } from '../contributions/publicTypes.js';
export {
  createPluginContributionIdentity,
  ManagedServiceLocalIdSchema,
  PluginContributionIdentityV1JsonSchema,
  PluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema,
  PluginContributionOperationRoleV1Schema,
  PluginContributionProtocolIdV1Schema,
  type ManagedServiceLocalId,
  type PluginContributionIdentityV1 as PluginContributionIdentity,
  type PluginContributionLocalId,
  type PluginContributionOperationRoleV1,
  type PluginContributionProtocolIdV1,
} from '../contributionIdentity.js';
export { PluginIdJsonSchema, PluginIdSchema, type PluginId } from '../pluginId.js';
export {
  AgentUiBehaviorDeclarationV1Schema,
  AgentUiComponentsDeclarationV1Schema,
  AgentUiConditionV1Schema,
  AgentUiMessageDeclarationV1Schema,
  AgentUiSessionDeclarationV1Schema,
  AgentUiProjectedDeclarationV1Schema,
  type AgentUiBehaviorDeclarationV1,
  type AgentUiComponentsDeclarationV1,
  type AgentUiConditionV1,
  type AgentUiMessageDeclarationV1,
  type AgentUiSessionDeclarationV1,
  type AgentUiSettingReferenceV1,
  type AgentUiProjectedDeclarationV1,
} from '../contributions/agentUiGrammar.js';
export {
  PLUGIN_CONTRIBUTION_CATALOG_V2,
  derivePluginDaemonContributionRegistrationRights,
  readContributedProviderCatalogParserIds,
  type PluginContributionCatalogEntryV2,
} from '../contributions/catalog.js';
export {
  PluginContributionPointProtocolV1Schema,
  PluginContributionPointV1Schema,
  PluginTargetedContributionOperationInputV1Schema,
  PluginTargetedContributionOperationRequirementsV1Schema,
  PluginTargetedContributionOperationV1Schema,
  PLUGIN_UI_MAX_RENDERER_CHAIN_LENGTH,
  PluginUiRendererChainBindingV1Schema,
  PluginTargetedContributionSurfacePresentationV1Schema,
  PluginTargetedContributionSurfaceV1Schema,
  PluginTargetedContributionProtocolV1Schema,
  PluginTargetedContributionTargetV1Schema,
  PluginTargetedContributionV1Schema,
  type PluginContributesV2,
  type PluginContributionPointV1,
  type PluginContributionPointProtocolV1,
  type PluginTargetedContributionOperationInputV1,
  type PluginTargetedContributionOperationRequirementsV1,
  type PluginTargetedContributionOperationV1,
  type PluginUiRendererChainBindingV1,
  type PluginTargetedContributionSurfacePresentationV1,
  type PluginTargetedContributionSurfaceV1,
  type PluginTargetedContributionProtocolV1,
  type PluginTargetedContributionTargetV1,
  type PluginTargetedContributionV1,
} from '../contributions/v2.js';
export {
  // Referenced by `PluginManifestV2Schema`'s public signature, so an author
  // building a declarative tree must be able to name it (r0.10: the schema was
  // `z.ZodType<unknown>` until the Protocol->CLI closure was bound, which is why
  // this omission was previously invisible).
  type PluginDeclarativeNodeV2,
} from '../contributions/ui/v2.js';
export {
  type PluginSettingsContribution,
} from '../contributions/settings.js';
export {
  type PromptAssetCapabilities,
  type PromptAssetTypeDescriptor,
} from '../../prompts/library/promptAssetDescriptorsV1.js';
export {
  decodePluginManifestUtf8,
  formatPluginManifestIngestionDiagnostic,
  formatPluginManifestIngestionDiagnostics,
  ingestPluginManifestV2,
  resolvePluginManifestSetReferencesV2,
  type PluginManifestIngestionDiagnostic,
  type PluginManifestIngestionResult,
  type PluginManifestSetReferenceResolutionResult,
} from './ingest.js';
export {
  PluginBrandV2Schema,
  PluginManifestV2Schema,
  type PluginBrandV2,
  type ParsedPluginManifestV2,
  type PluginManifest,
} from './v2.js';
