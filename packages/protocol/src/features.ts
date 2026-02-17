// `/v1/features` returns:
// - `features`: catalog feature gates (enablement only; derived-path `...enabled` bits)
// - `capabilities`: configuration/status details used by clients (not themselves catalog feature gates)

export { OAuthProviderStatusSchema, type OAuthProviderStatus } from './features/payload/oauthProviderStatus.js';
export { FeatureGateSchema, type FeatureGate } from './features/payload/featureGate.js';

export {
  BugReportsCapabilitiesSchema,
  BUG_REPORT_DEFAULT_ACCEPTED_ARTIFACT_KINDS,
  BUG_REPORT_DEFAULT_CONTEXT_WINDOW_MS,
  DEFAULT_BUG_REPORTS_CAPABILITIES,
  coerceBugReportsCapabilitiesFromFeaturesPayload,
  type BugReportsCapabilities,
} from './features/payload/capabilities/bugReportsCapabilities.js';

export {
  VoiceCapabilitiesSchema,
  DEFAULT_VOICE_CAPABILITIES,
  type VoiceCapabilities,
} from './features/payload/capabilities/voiceCapabilities.js';

export {
  SocialFriendsCapabilitiesSchema,
  DEFAULT_SOCIAL_FRIENDS_CAPABILITIES,
  type SocialFriendsCapabilities,
} from './features/payload/capabilities/socialFriendsCapabilities.js';

export {
  AuthCapabilitiesSchema,
  DEFAULT_AUTH_CAPABILITIES,
  type AuthCapabilities,
} from './features/payload/capabilities/authCapabilities.js';

export { CapabilitiesSchema, type Capabilities } from './features/payload/capabilities/capabilitiesSchema.js';
export { FeatureGatesSchema, type FeatureGates } from './features/payload/featureGatesSchema.js';
export { FeaturesResponseSchema, type FeaturesResponse } from './features/payload/featuresResponseSchema.js';
