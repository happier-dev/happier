import { z } from 'zod';
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

export const CapabilitiesSchema = z.object({
  accountStoredContentCompatibility:
    AccountStoredContentCompatibilityServerRequirementsV1Schema.optional(),
  bugReports: BugReportsCapabilitiesSchema.optional().default(DEFAULT_BUG_REPORTS_CAPABILITIES),
  voice: VoiceCapabilitiesSchema.optional().default(DEFAULT_VOICE_CAPABILITIES),
  pets: PetsCapabilitiesSchema.optional().default(DEFAULT_PETS_CAPABILITIES),
  encryption: EncryptionCapabilitiesSchema.optional().default(DEFAULT_ENCRYPTION_CAPABILITIES),
  server: ServerCapabilitiesSchema.optional().default(DEFAULT_SERVER_CAPABILITIES),
  serverIdentity: ServerIdentityCapabilitiesSchema.optional().default(DEFAULT_SERVER_IDENTITY_CAPABILITIES),
  machines: z
    .object({
      transfer: MachineTransferCapabilitiesSchema.optional().default(DEFAULT_MACHINE_TRANSFER_CAPABILITIES),
      tunnel: MachineTunnelCapabilitiesSchema.optional().default(DEFAULT_MACHINE_TUNNEL_CAPABILITIES),
      liveStream: MachineLiveStreamCapabilitiesSchema.optional().default(DEFAULT_MACHINE_LIVE_STREAM_CAPABILITIES),
      peerMediation: PeerMediationCapabilitiesSchema.optional().default(DEFAULT_PEER_MEDIATION_CAPABILITIES),
    })
    .optional()
    .default({
      transfer: DEFAULT_MACHINE_TRANSFER_CAPABILITIES,
      tunnel: DEFAULT_MACHINE_TUNNEL_CAPABILITIES,
      liveStream: DEFAULT_MACHINE_LIVE_STREAM_CAPABILITIES,
      peerMediation: DEFAULT_PEER_MEDIATION_CAPABILITIES,
    }),
  localServices: LocalServiceCapabilitiesSchema.optional().default(DEFAULT_LOCAL_SERVICE_CAPABILITIES),
  browser: BrowserCapabilitiesSchema.optional().default(DEFAULT_BROWSER_CAPABILITIES),
  devices: DeviceCapabilitiesSchema.optional().default(DEFAULT_DEVICE_CAPABILITIES),
  plugins: PluginsCapabilitiesSchema.optional().default(DEFAULT_PLUGINS_CAPABILITIES),
  // This must remain a root-level optional family: `server` and `plugins` are
  // strict incumbent children, while the outer capability envelope is additive.
  pluginDataCollections: PluginDataCollectionsCapabilitiesSchema.optional(),
  social: z
    .object({
      friends: SocialFriendsCapabilitiesSchema.optional().default(DEFAULT_SOCIAL_FRIENDS_CAPABILITIES),
    })
    .optional()
    .default({ friends: DEFAULT_SOCIAL_FRIENDS_CAPABILITIES }),
  oauth: z
    .object({
      providers: z.record(z.string(), OAuthProviderStatusSchema),
    })
    .optional()
    .default({ providers: {} }),
  auth: AuthCapabilitiesSchema.optional().default(DEFAULT_AUTH_CAPABILITIES),
  session: SessionCapabilitiesSchema.optional().default(DEFAULT_SESSION_CAPABILITIES),
  sharing: SharingCapabilitiesSchema.optional().default(DEFAULT_SHARING_CAPABILITIES),
  connectedServices: ConnectedServicesCapabilitiesSchema.optional().default(DEFAULT_CONNECTED_SERVICES_CAPABILITIES),
  liveActivities: z
    .object({
      remoteUpdates: LiveActivityRemoteUpdateCapabilityDiagnosticsSchema.optional().default(
        DEFAULT_LIVE_ACTIVITY_REMOTE_UPDATE_CAPABILITY_DIAGNOSTICS,
      ),
    })
    .optional()
    .default({ remoteUpdates: DEFAULT_LIVE_ACTIVITY_REMOTE_UPDATE_CAPABILITY_DIAGNOSTICS }),
});

export type Capabilities = z.infer<typeof CapabilitiesSchema>;
