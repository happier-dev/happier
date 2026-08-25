import {
  ConversationProvidersContributionPointV1,
  CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
} from '@happier-dev/channels-protocol/v1';

/** Package-local alias for the one protocol-owned contribution-point id. */
export const CHANNELS_PROVIDER_POINT_ID = CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1;

/**
 * The target-owned executable contribution-point definitions shared by the
 * authored manifest and the generated cold bundled registry.
 */
export const PLUGIN_TARGETED_CONTRIBUTION_POINT_DEFINITIONS = Object.freeze({
  [CHANNELS_PROVIDER_POINT_ID]: ConversationProvidersContributionPointV1,
});
