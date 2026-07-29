/**
 * Experimental Provider authoring/runtime helpers.
 *
 * Provider contribution/profile types and the protocol-owned validators used
 * by real Agent binding adapters incubate here. This entrypoint must not grow
 * into a second Provider registry or normalization layer.
 */
export {
  areProviderContributionKeysEqualV1,
  buildBackendTargetKeyV2,
  normalizeProviderCredentialHeaderName,
  ProviderEndpointUrlSyntaxSchema,
  ProviderPublicHeadersV1Schema,
  resolveSessionModelSelectionIntentV1,
  SessionModelSelectionResolutionError,
  SessionModelSelectionV1Schema,
} from '@happier-dev/protocol';

export type {
  AIBackendProfile,
  ProviderContributionV1,
} from '@happier-dev/protocol';
