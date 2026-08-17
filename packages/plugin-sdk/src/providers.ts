/**
 * Experimental Provider authoring/runtime helpers.
 *
 * Provider contribution/profile types and the protocol-owned validators used
 * by real Agent binding adapters incubate here. This entrypoint must not grow
 * into a second Provider registry or normalization layer. EU-3 publishes the
 * exact final surface from providers/projections.ts; EU-4 removes this broader
 * experimental barrel only after its current consumers move.
 */
export {
  areProviderContributionKeysEqualV1,
  buildBackendTargetKeyV2,
  containsProviderRegisteredSensitiveValue,
  normalizeProviderCredentialHeaderName,
  ProviderConnectionIdSchema,
  ProviderContributionV1Schema,
  ProviderEndpointUrlSyntaxSchema,
  ProviderPublicHeadersV1Schema,
  resolveProviderBindingCompatibilityWithFingerprintV1,
  resolveSessionModelSelectionIntentV1,
  SessionModelSelectionResolutionError,
  SessionModelSelectionV1Schema,
} from '@happier-dev/protocol';

export type {
  ProviderBindingStatusRequest,
  ProviderBindingStatusResult,
  ProviderCatalogService,
  ProviderConnectionMutationRequest,
  ProviderConnectionMutationResult,
  ProviderConnectionsDescribeRequest,
  ProviderConnectionsDescribeResult,
  ProviderConnectionsService,
  ProviderContribution,
  ProviderManagedRuntimeDeclaration,
  ProviderMigrationsService,
  ProviderModelLoadRequest,
  ProviderModelLoadResult,
  ProviderModelProjectionRequest,
  ProviderModelProjectionResult,
  ProviderModelsRequest,
  ProviderModelsResult,
  ProviderModelSettingsMutationRequest,
  ProviderModelSettingsMutationResult,
  ProviderProbeRequest,
  ProviderProbeResult,
  ProviderProfileMigrationConfirmRequest,
  ProviderProfileMigrationConfirmResult,
  ProviderProfileMigrationConflictConfirmRequest,
  ProviderProfileMigrationConflictConfirmResult,
  ProviderProfileMigrationPreviewRequest,
  ProviderProfileMigrationPreviewResult,
  ProvidersService,
} from './providers/projections.js';

export type {
  AIBackendProfile,
  CapabilitySupport as ProviderCapabilitySupport,
  ProviderApiKeyCredentialRequirementV1,
  ProviderCatalogCommandFallbackV1,
  ProviderCatalogDeclarationV1,
  ProviderCatalogParserV1,
  ProviderCatalogProbeV1,
  ProviderCompatibilityCapabilitiesV1,
  ProviderCompatibilityOverrideV1,
  ProviderContributionV1,
  ProviderCredentialDestinationV1,
  ProviderCredentialFormatV1,
  ProviderCredentialTransportV1,
  ProviderDetectionDescriptorV1,
  ProviderEndpointTemplateV1,
  ProviderLegacyProfileMigrationDescriptorV1,
  ProviderModelLoadDescriptorV1,
  ProviderWireProtocol,
} from '@happier-dev/protocol';
