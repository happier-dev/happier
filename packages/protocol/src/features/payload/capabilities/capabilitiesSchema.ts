import { MachineOperationProtocolCapabilityV1Schema, MachineSessionSpawnProtocolCapabilityV1Schema } from '../../../machines/operationProtocolCapabilitiesV1.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { AccountStoredContentCompatibilityServerRequirementsV1Schema } from '../../../clientCompatibility/accountStoredContentCompatibilityV1.js';

import { OAuthProviderStatusSchema } from '../oauthProviderStatus.js';
import {
  BugReportsCapabilitiesSchema,
  DEFAULT_BUG_REPORTS_CAPABILITIES,
} from './bugReportsCapabilities.js';
import { DEFAULT_VOICE_CAPABILITIES, VoiceCapabilitiesSchema } from './voiceCapabilities.js';
import {
  DEFAULT_SOCIAL_FRIENDS_CAPABILITIES,
  SocialFriendsCapabilitiesSchema,
} from './socialFriendsCapabilities.js';
import {
  AuthCapabilitiesSchema,
  DEFAULT_AUTH_CAPABILITIES,
} from './authCapabilities.js';
import {
  DEFAULT_ENCRYPTION_CAPABILITIES,
  EncryptionCapabilitiesSchema,
} from './encryptionCapabilities.js';
import {
  DEFAULT_MACHINE_TRANSFER_CAPABILITIES,
  MachineTransferCapabilitiesSchema,
} from './machineTransferCapabilities.js';
import {
  DEFAULT_MACHINE_TUNNEL_CAPABILITIES,
  MachineTunnelCapabilitiesSchema,
} from './machineTunnelCapabilities.js';
import {
  DEFAULT_MACHINE_LIVE_STREAM_CAPABILITIES,
  MachineLiveStreamCapabilitiesSchema,
} from './machineLiveStreamCapabilities.js';
import {
  BrowserCapabilitiesSchema,
  DEFAULT_BROWSER_CAPABILITIES,
} from './browserCapabilities.js';
import {
  DEFAULT_DEVICE_CAPABILITIES,
  DeviceCapabilitiesSchema,
} from './deviceCapabilities.js';
import {
  DEFAULT_LOCAL_SERVICE_CAPABILITIES,
  LocalServiceCapabilitiesSchema,
} from './localServiceCapabilities.js';
import {
  DEFAULT_PEER_MEDIATION_CAPABILITIES,
  PeerMediationCapabilitiesSchema,
} from './peerMediationCapabilities.js';
import {
  DEFAULT_SERVER_CAPABILITIES,
  ServerCapabilitiesSchema,
} from './serverCapabilities.js';
import {
  DEFAULT_SERVER_IDENTITY_CAPABILITIES,
  ServerIdentityCapabilitiesSchema,
} from './serverIdentityCapabilities.js';
import { ServerReleaseCapabilitiesSchema } from './serverReleaseCapabilities.js';
import {
  DEFAULT_PETS_CAPABILITIES,
  PetsCapabilitiesSchema,
} from './petsCapabilities.js';
import {
  DEFAULT_SESSION_CAPABILITIES,
  SessionCapabilitiesSchema,
} from './sessionCapabilities.js';
import {
  DEFAULT_SHARING_CAPABILITIES,
  SharingCapabilitiesSchema,
} from './sharingCapabilities.js';
import {
  DEFAULT_LIVE_ACTIVITY_REMOTE_UPDATE_CAPABILITY_DIAGNOSTICS,
  LiveActivityRemoteUpdateCapabilityDiagnosticsSchema,
} from '../../../activity/live/remoteUpdateCapabilities.js';
import {
  ConnectedServicesCapabilitiesSchema,
  DEFAULT_CONNECTED_SERVICES_CAPABILITIES,
} from './connectedServicesCapabilities.js';
import {
  DEFAULT_PLUGINS_CAPABILITIES,
  PluginsCapabilitiesSchema,
} from './pluginsCapabilities.js';
import { PluginDataCollectionsCapabilitiesSchema } from './pluginDataCollectionsCapabilities.js';
import { AccountDirectoryCapabilitiesSchema } from './accountDirectoryCapabilities.js';
import { HomeSearchCapabilitiesSchema } from './homeSearchCapabilities.js';
import { TeamCredentialCapabilitiesSchema } from './teamCredentialCapabilities.js';

export const CapabilitiesSchema = lazyZodSchema(() => z.object({
  /** Operation epoch, separate from package version and product enablement. */
  providerBroker: z.optional(z.strictObject({ protocolVersions: z.tuple([z.literal(1), z.literal(2)]) })),
  homeSearch: z.optional(HomeSearchCapabilitiesSchema),
  accountDirectory: z.optional(AccountDirectoryCapabilitiesSchema),
  accountStoredContentCompatibility:
    z.optional(AccountStoredContentCompatibilityServerRequirementsV1Schema),
  bugReports: z._default(z.optional(BugReportsCapabilitiesSchema), DEFAULT_BUG_REPORTS_CAPABILITIES),
  voice: z._default(z.optional(VoiceCapabilitiesSchema), DEFAULT_VOICE_CAPABILITIES),
  pets: z._default(z.optional(PetsCapabilitiesSchema), DEFAULT_PETS_CAPABILITIES),
  encryption: z._default(z.optional(EncryptionCapabilitiesSchema), DEFAULT_ENCRYPTION_CAPABILITIES),
  server: z._default(z.optional(ServerCapabilitiesSchema), DEFAULT_SERVER_CAPABILITIES),
  serverIdentity: z._default(z.optional(ServerIdentityCapabilitiesSchema), DEFAULT_SERVER_IDENTITY_CAPABILITIES),
  serverRelease: z.optional(ServerReleaseCapabilitiesSchema),
  machines: z._default(z.optional(z
    .object({
      connectedAccountAuthentication: z.catch(z.optional(MachineOperationProtocolCapabilityV1Schema), undefined),
      sessionSpawn: z.catch(z.optional(MachineSessionSpawnProtocolCapabilityV1Schema), undefined),
      transfer: z._default(z.optional(MachineTransferCapabilitiesSchema), DEFAULT_MACHINE_TRANSFER_CAPABILITIES),
      tunnel: z._default(z.optional(MachineTunnelCapabilitiesSchema), DEFAULT_MACHINE_TUNNEL_CAPABILITIES),
      liveStream: z._default(z.optional(MachineLiveStreamCapabilitiesSchema), DEFAULT_MACHINE_LIVE_STREAM_CAPABILITIES),
      peerMediation: z._default(z.optional(PeerMediationCapabilitiesSchema), DEFAULT_PEER_MEDIATION_CAPABILITIES),
    })), {
      transfer: DEFAULT_MACHINE_TRANSFER_CAPABILITIES,
      tunnel: DEFAULT_MACHINE_TUNNEL_CAPABILITIES,
      liveStream: DEFAULT_MACHINE_LIVE_STREAM_CAPABILITIES,
      peerMediation: DEFAULT_PEER_MEDIATION_CAPABILITIES,
    }),
  localServices: z._default(z.optional(LocalServiceCapabilitiesSchema), DEFAULT_LOCAL_SERVICE_CAPABILITIES),
  browser: z._default(z.optional(BrowserCapabilitiesSchema), DEFAULT_BROWSER_CAPABILITIES),
  devices: z._default(z.optional(DeviceCapabilitiesSchema), DEFAULT_DEVICE_CAPABILITIES),
  plugins: z._default(z.optional(PluginsCapabilitiesSchema), DEFAULT_PLUGINS_CAPABILITIES),
  // This must remain a root-level optional family: `server` and `plugins` are
  // strict incumbent children, while the outer capability envelope is additive.
  pluginDataCollections: z.optional(PluginDataCollectionsCapabilitiesSchema),
  social: z._default(z.optional(z
    .object({
      friends: z._default(z.optional(SocialFriendsCapabilitiesSchema), DEFAULT_SOCIAL_FRIENDS_CAPABILITIES),
    })), { friends: DEFAULT_SOCIAL_FRIENDS_CAPABILITIES }),
  oauth: z._default(z.optional(z
    .object({
      providers: z.record(z.string(), OAuthProviderStatusSchema),
    })), { providers: {} }),
  auth: z._default(z.optional(AuthCapabilitiesSchema), DEFAULT_AUTH_CAPABILITIES),
  session: z._default(z.optional(SessionCapabilitiesSchema), DEFAULT_SESSION_CAPABILITIES),
  sharing: z._default(z.optional(SharingCapabilitiesSchema), DEFAULT_SHARING_CAPABILITIES),
  connectedServices: z._default(z.optional(ConnectedServicesCapabilitiesSchema), DEFAULT_CONNECTED_SERVICES_CAPABILITIES),
  teams: z.optional(TeamCredentialCapabilitiesSchema),
  liveActivities: z._default(z.optional(z
    .object({
      remoteUpdates: z._default(z.optional(LiveActivityRemoteUpdateCapabilityDiagnosticsSchema), DEFAULT_LIVE_ACTIVITY_REMOTE_UPDATE_CAPABILITY_DIAGNOSTICS),
    })), { remoteUpdates: DEFAULT_LIVE_ACTIVITY_REMOTE_UPDATE_CAPABILITY_DIAGNOSTICS }),
}));

export type Capabilities = z.infer<typeof CapabilitiesSchema>;
