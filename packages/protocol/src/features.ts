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
  DEFAULT_PETS_CAPABILITIES,
  DEFAULT_PETS_PACKAGE_LIMITS_CAPABILITIES,
  PetsCapabilitiesSchema,
  PetsPackageLimitsCapabilitiesSchema,
  type PetsCapabilities,
  type PetsPackageLimitsCapabilities,
} from './features/payload/capabilities/petsCapabilities.js';

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
export {
  DEFAULT_MACHINE_TRANSFER_CAPABILITIES,
  DEFAULT_MACHINE_TRANSFER_SERVER_ROUTED_CAPABILITIES,
  DEFAULT_MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES,
  MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY,
  MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_HARD_MAX,
  MachineTransferCapabilitiesSchema,
  MachineTransferServerRoutedCapabilitiesSchema,
  normalizeMachineTransferServerRoutedMaxBytes,
  readMachineTransferServerRoutedMaxBytes,
  type MachineTransferCapabilities,
  type MachineTransferServerRoutedCapabilities,
} from './features/payload/capabilities/machineTransferCapabilities.js';
export {
  DEFAULT_MACHINE_TUNNEL_CAPABILITIES,
  DEFAULT_MACHINE_TUNNEL_DIRECT_ALLOWED_PORTS,
  DEFAULT_MACHINE_TUNNEL_DIRECT_PEER_CAPABILITIES,
  DEFAULT_MACHINE_TUNNEL_MAX_DURATION_MS,
  DEFAULT_MACHINE_TUNNEL_MAX_IDLE_MS,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_CAPABILITIES,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES,
  MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET_HARD_MAX,
  MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX,
  MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX,
  MachineTunnelCapabilitiesSchema,
  MachineTunnelDirectPeerCapabilitiesSchema,
  MachineTunnelServerRoutedCapabilitiesSchema,
  normalizeMachineTunnelAllowedPorts,
  normalizeMachineTunnelPositiveInt,
  type MachineTunnelCapabilities,
  type MachineTunnelDirectPeerCapabilities,
  type MachineTunnelServerRoutedCapabilities,
} from './features/payload/capabilities/machineTunnelCapabilities.js';
export {
  DEFAULT_MACHINE_LIVE_STREAM_CAPABILITIES,
  DEFAULT_MACHINE_LIVE_STREAM_SERVER_ROUTED_CAPABILITIES,
  MachineLiveStreamCapabilitiesSchema,
  MachineLiveStreamRelayDisabledReasonSchema,
  MachineLiveStreamServerRoutedCapabilitiesSchema,
  readMachineLiveStreamRelayCaps,
  type MachineLiveStreamCapabilities,
  type MachineLiveStreamRelayDisabledReason,
  type MachineLiveStreamServerRoutedCapabilities,
} from './features/payload/capabilities/machineLiveStreamCapabilities.js';

export {
  DEFAULT_SESSION_CAPABILITIES,
  DEFAULT_SESSION_MESSAGES_CAPABILITIES,
  SessionCapabilitiesSchema,
  SessionMessagesCapabilitiesSchema,
  type SessionCapabilities,
  type SessionMessagesCapabilities,
} from './features/payload/capabilities/sessionCapabilities.js';

export { CapabilitiesSchema, type Capabilities } from './features/payload/capabilities/capabilitiesSchema.js';
export { FeatureGatesSchema, type FeatureGates } from './features/payload/featureGatesSchema.js';
export { FeaturesResponseSchema, type FeaturesResponse } from './features/payload/featuresResponseSchema.js';
