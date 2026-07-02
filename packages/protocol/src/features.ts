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
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_ALLOW_V1_FALLBACK,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_AGGREGATE_BYTES,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BINARY_HEADER_BYTES,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_PER_SUBSTREAM,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_CONCURRENT_SUBSTREAMS,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAMED_MESSAGE_BYTES,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_SESSION_IDLE_MS,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_SUBSTREAM_IDLE_MS,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_TOTAL_SUBSTREAMS,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_PREFERRED_ENCODING,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_SUPPORTED_ENCODINGS,
  DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES,
  MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET_HARD_MAX,
  MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX,
  MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX,
  MACHINE_TUNNEL_SERVER_ROUTED_MAX_SUBSTREAMS_HARD_MAX,
  MachineTunnelCapabilitiesSchema,
  MachineTunnelDirectPeerCapabilitiesSchema,
  MachineTunnelServerRoutedCapabilitiesSchema,
  MachineTunnelSubstreamCapabilitiesSchema,
  normalizeMachineTunnelAllowedPorts,
  normalizeMachineTunnelPositiveInt,
  normalizeMachineTunnelPreferredEncoding,
  normalizeMachineTunnelSupportedEncodings,
  type MachineTunnelCapabilities,
  type MachineTunnelDirectPeerCapabilities,
  type MachineTunnelServerRoutedCapabilities,
  type MachineTunnelSubstreamCapabilities,
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
  BrowserCapabilitiesSchema,
  BrowserInternalCapabilitiesSchema,
  BrowserSidecarCapabilitiesSchema,
  BrowserViewTargetCapabilitiesSchema,
  DEFAULT_BROWSER_CAPABILITIES,
  DEFAULT_BROWSER_INTERNAL_CAPABILITIES,
  DEFAULT_BROWSER_SIDECAR_CAPABILITIES,
  DEFAULT_BROWSER_VIEW_TARGET_CAPABILITIES,
  type BrowserCapabilities,
  type BrowserInternalCapabilities,
  type BrowserSidecarCapabilities,
  type BrowserViewTargetCapabilities,
} from './features/payload/capabilities/browserCapabilities.js';
export {
  DEFAULT_LOCAL_SERVICE_CAPABILITIES,
  DEFAULT_LOCAL_SERVICE_PREVIEW_CAPABILITIES,
  DEFAULT_LOCAL_SERVICE_PREVIEW_MAX_REQUEST_BODY_BYTES,
  DEFAULT_LOCAL_SERVICE_PREVIEW_MAX_RESPONSE_BODY_BYTES,
  DEFAULT_LOCAL_SERVICE_PREVIEW_TOKEN_TTL_MS,
  DEFAULT_LOCAL_SERVICE_PUBLIC_CAPABILITIES,
  LocalServiceCapabilitiesSchema,
  LocalServicePreviewCapabilitiesSchema,
  LocalServicePublicCapabilitiesSchema,
  type LocalServiceCapabilities,
  type LocalServicePreviewCapabilities,
  type LocalServicePublicCapabilities,
} from './features/payload/capabilities/localServiceCapabilities.js';

export {
  DEFAULT_SERVER_IDENTITY_CAPABILITIES,
  SERVER_IDENTITY_ID_PATTERN,
  ServerIdentityCapabilitiesSchema,
  normalizeServerIdentityIdCapability,
  type ServerIdentityCapabilities,
} from './features/payload/capabilities/serverIdentityCapabilities.js';

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
