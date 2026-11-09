import { DEFAULT_LOCAL_SERVICE_PREVIEW_TOKEN_TTL_MS } from '@happier-dev/protocol/features/payload/capabilities/localServiceCapabilities';
import { DEFAULT_MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES, MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_HARD_MAX } from '@happier-dev/protocol/features/payload/capabilities/machineTransferCapabilities';
import { DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BINARY_HEADER_BYTES, DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES, DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAMED_MESSAGE_BYTES, DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES, MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX } from '@happier-dev/protocol/features/payload/capabilities/machineTunnelCapabilities';
import { PET_PACKAGE_LIMITS_V1 } from '@happier-dev/protocol/pets/constants';
import { PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1, PLUGIN_COLLECTION_LIMITS_V1 } from '@happier-dev/protocol/plugins/data/collectionLimitsV1';
import { type FeatureId } from '@happier-dev/protocol/features/catalog';
import { type ServerConfigEntryInput } from '@happier-dev/protocol/serverConfig/serverConfigEntry';

import type { FEATURE_ENV_KEYS } from './featureEnvSchema';

/**
 * The one declaration of every server feature configuration key (plan §3.14, "READER_DEFAULTS"):
 * type, default and bounds as `readFeatureEnv.ts` parses them, plus who may set each key.
 *
 * `readFeatureEnv.ts` reads its defaults and bounds from this table, and `featureServerConfig.ts`
 * derives the registry family from it and `FEATURE_ENV_KEYS`. A switch whose key is
 * `HAPPIER_FEATURE_<ID>__ENABLED` for a catalog feature takes its feature id and, unless it states
 * its own, its description from the feature catalog.
 *
 * Every feature key is Home-editable (plan r3): none is needed before the database opens. `apply`
 * is `restart` where a consumer captures the value when the server starts (socket setup, route
 * body limits, route registration), so a Home change takes effect at the next start.
 */
export type FeatureEnvProperty = keyof typeof FEATURE_ENV_KEYS;

export type FeatureConfigDeclaration = Readonly<
    Omit<ServerConfigEntryInput, 'section' | 'family' | 'description' | 'featureId'> & {
        /** Defaults to the catalog description of `featureId`. */
        description?: string;
        featureId?: FeatureId;
        section?: 'features' | 'policies';
    }
>;

const HOME = { sensitivity: 'plain', apply: 'live', editable: 'home' } as const;
const AT_STARTUP = { sensitivity: 'plain', apply: 'restart', editable: 'home' } as const;
const POLICY = { sensitivity: 'plain', apply: 'live', editable: 'home', section: 'policies' } as const;

const ON = { type: 'boolean', default: true } as const;
const OFF = { type: 'boolean', default: false } as const;

const LIVE_STREAM_CAP = { type: 'int', bounds: { min: 1 }, ...AT_STARTUP } as const;

export const FEATURE_READER_DEFAULTS = {
    accountPublicProfilesEnabled: { ...ON, ...HOME },
    machinesPoolsEnabled: { ...ON, ...HOME },
    teamsEnabled: { ...ON, ...HOME },
    teamsCredentialResourcesEnabled: { ...ON, ...HOME },
    teamsCredentialResourcesExternalApiEnabled: { ...ON, ...HOME },
    workflowsEnabled: { ...ON, ...HOME, aliases: ['HAPPIER_FEATURE_AUTOMATIONS__ENABLED'] },
    deploymentsEnabled: { ...ON, ...HOME },
    botsEnabled: { ...ON, ...HOME },

    artifactRevisionRetentionCount: {
        type: 'int', default: 10, bounds: { min: 0 }, ...POLICY,
        description: 'Number of prior bodies retained for each ordinary Account Artifact.',
    },
    artifactDocumentLimitBytes: {
        type: 'int', bounds: { min: 0 }, ...POLICY,
        description: 'Optional byte cap for an ordinary Artifact stored header, body and retained bodies; unset means unlimited.',
    },
    artifactAccountLimitBytes: {
        type: 'int', bounds: { min: 0 }, ...POLICY,
        description: 'Optional Account byte budget for ordinary Artifact stored headers, bodies and retained bodies; unset means unlimited.',
    },

    bugReportsEnabled: { ...ON, ...HOME },
    bugReportsProviderUrl: {
        type: 'string',
        ...HOME,
        featureId: 'bugReports',
        description: 'Bug report provider endpoint. Set but blank publishes no provider.',
    },
    bugReportsDefaultIncludeDiagnostics: {
        ...ON,
        ...HOME,
        featureId: 'bugReports',
        description: 'Whether the bug report form includes diagnostics unless the reporter opts out.',
    },
    bugReportsMaxArtifactBytes: {
        type: 'int',
        default: 10 * 1024 * 1024,
        bounds: { min: 1024 },
        ...HOME,
        featureId: 'bugReports',
        description: 'Largest artifact a bug report may attach, in bytes.',
    },
    bugReportsUploadTimeoutMs: {
        type: 'int',
        default: 120_000,
        bounds: { min: 5000 },
        ...HOME,
        featureId: 'bugReports',
        description: 'Time a bug report upload may take, in milliseconds.',
    },
    bugReportsAcceptedArtifactKinds: {
        type: 'list',
        ...HOME,
        featureId: 'bugReports',
        description: 'Artifact kinds bug reports accept (comma-separated); unset accepts the default kinds.',
    },
    bugReportsContextWindowMs: {
        type: 'int',
        default: 30 * 60 * 1000,
        bounds: { min: 1000, max: 24 * 60 * 60 * 1000 },
        ...HOME,
        featureId: 'bugReports',
        description: 'How far back a bug report collects context, in milliseconds.',
    },

    voiceEnabled: { ...ON, ...HOME },
    voiceRequireSubscription: {
        type: 'boolean',
        ...HOME,
        featureId: 'voice',
        description: 'Require a subscription for voice. When unset: required in production, not otherwise.',
    },

    connectedServicesQuotasEnabled: { ...ON, ...HOME },
    connectedServicesAccountGroupsEnabled: { ...ON, ...HOME },
    connectedServicesAccountFallbackEnabled: { ...ON, ...HOME },

    updatesOtaEnabled: { ...ON, ...HOME },

    attachmentsUploadsEnabled: { ...ON, ...HOME },

    petsCompanionEnabled: { ...ON, ...HOME },
    petsSyncEnabled: { ...OFF, ...HOME },
    petsSyncMaxManifestBytes: {
        type: 'int',
        default: PET_PACKAGE_LIMITS_V1.maxManifestBytes,
        bounds: { min: 1 },
        ...AT_STARTUP,
        featureId: 'pets.sync',
        description: 'Largest pet manifest accepted, in bytes.',
    },
    petsSyncMaxCanonicalSpritesheetBytes: {
        type: 'int',
        default: PET_PACKAGE_LIMITS_V1.maxCanonicalSpritesheetBytes,
        bounds: { min: 1 },
        ...AT_STARTUP,
        featureId: 'pets.sync',
        description: 'Largest pet spritesheet accepted, in bytes.',
    },
    petsSyncMaxCanonicalPackageBytes: {
        type: 'int',
        default: PET_PACKAGE_LIMITS_V1.maxCanonicalPackageBytes,
        bounds: { min: 1 },
        ...AT_STARTUP,
        featureId: 'pets.sync',
        description: 'Largest pet package accepted, in bytes.',
    },
    petsSyncMaxImportedPetsPerAccount: {
        type: 'int',
        default: PET_PACKAGE_LIMITS_V1.maxImportedPetsPerAccount,
        bounds: { min: 1 },
        ...AT_STARTUP,
        featureId: 'pets.sync',
        description: 'Most imported pets one account may keep.',
    },
    petsSyncMaxImportedPetBytesPerAccount: {
        type: 'int',
        default: PET_PACKAGE_LIMITS_V1.maxImportedPetBytesPerAccount,
        bounds: { min: 1 },
        ...AT_STARTUP,
        featureId: 'pets.sync',
        description: 'Most bytes of imported pets one account may keep.',
    },
    petsSyncEncryptedCustomPetSyncPolicy: {
        type: 'enum',
        default: 'disabled',
        bounds: { values: ['disabled'] },
        ...HOME,
        featureId: 'pets.sync',
        description: 'Reserved. Encrypted custom pet sync is not supported; the server always uses `disabled`.',
    },

    sessionsHandoffEnabled: { ...ON, ...HOME },
    sessionsEphemeralRunnerEnabled: { ...ON, ...HOME },
    sessionsAgentSwitchingEnabled: { ...ON, ...HOME },
    sessionsDraftsEnabled: { ...ON, ...HOME },
    sessionsFilteredListingEnabled: { ...ON, ...HOME },
    sessionsBoardEnabled: { ...ON, ...HOME },
    sessionsFollowingEnabled: { ...ON, ...HOME },
    sessionsConversationsEnabled: { ...ON, ...HOME },
    sessionsUsageLimitRecoveryEnabled: { ...ON, ...HOME },
    machinesTransferDirectPeerEnabled: { ...ON, ...AT_STARTUP },
    machinesRpcDirectPeerEnabled: { ...ON, ...HOME },
    machinesPeerMediationObservabilityEnabled: { ...OFF, ...HOME },
    machinesTransferServerRoutedEnabled: { ...ON, ...AT_STARTUP },
    machinesTransferServerRoutedMaxBytes: {
        type: 'int',
        default: DEFAULT_MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES,
        bounds: { min: 1, max: MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_HARD_MAX },
        ...AT_STARTUP,
        featureId: 'machines.transfer.serverRouted',
        description: 'Largest file a server-routed transfer carries, in bytes (capped at the protocol hard maximum).',
    },
    machinesTransferServerRoutedMaxActiveTransfersPerSocket: {
        type: 'int',
        default: 128,
        bounds: { min: 1, max: 10_000 },
        ...AT_STARTUP,
        featureId: 'machines.transfer.serverRouted',
        description: 'Most server-routed transfers one socket may run at once.',
    },
    machinesTunnelDirectPeerEnabled: { ...ON, ...AT_STARTUP },
    machinesTunnelServerRoutedEnabled: { ...OFF, ...AT_STARTUP },
    machinesTunnelServerRoutedMaxActiveTunnelsPerSocket: {
        type: 'int',
        bounds: { min: 1 },
        ...AT_STARTUP,
        featureId: 'machines.tunnel.serverRouted',
        description: 'Most server-routed tunnels one socket may hold open.',
    },
    machinesTunnelServerRoutedMaxFrameBytes: {
        type: 'int',
        default: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES,
        bounds: { min: 1, max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX },
        ...AT_STARTUP,
        featureId: 'machines.tunnel.serverRouted',
        description: 'Largest server-routed tunnel frame, in bytes.',
    },
    machinesTunnelServerRoutedSupportedEncodings: {
        type: 'list',
        ...AT_STARTUP,
        featureId: 'machines.tunnel.serverRouted',
        description: 'Frame encodings server-routed tunnels accept; unset uses the protocol defaults.',
    },
    machinesTunnelServerRoutedPreferredEncoding: {
        type: 'string',
        ...AT_STARTUP,
        featureId: 'machines.tunnel.serverRouted',
        description: 'Preferred frame encoding; must be one of the supported encodings, else the first supported one.',
    },
    machinesTunnelServerRoutedMaxBinaryHeaderBytes: {
        type: 'int',
        default: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BINARY_HEADER_BYTES,
        bounds: { min: 1, max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX },
        ...AT_STARTUP,
        featureId: 'machines.tunnel.serverRouted',
        description: 'Largest binary frame header, in bytes.',
    },
    machinesTunnelServerRoutedMaxRawPayloadBytes: {
        type: 'int',
        default: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES,
        bounds: { min: 1, max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX },
        ...AT_STARTUP,
        featureId: 'machines.tunnel.serverRouted',
        description: 'Largest raw payload in one frame, in bytes.',
    },
    machinesTunnelServerRoutedMaxFramedMessageBytes: {
        type: 'int',
        default: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAMED_MESSAGE_BYTES,
        bounds: { min: 1, max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX },
        ...AT_STARTUP,
        featureId: 'machines.tunnel.serverRouted',
        description: 'Largest framed message, in bytes.',
    },
    machinesTunnelServerRoutedMaxConcurrentSubstreams: {
        type: 'int',
        bounds: { min: 1 },
        ...AT_STARTUP,
        featureId: 'machines.tunnel.serverRouted',
        description: 'Most substreams one tunnel runs at once.',
    },
    machinesTunnelAllowedPorts: {
        type: 'list',
        ...AT_STARTUP,
        featureId: 'machines.tunnel',
        description: 'Ports tunnels may reach (comma or space separated); unset allows none beyond the defaults.',
    },

    localServicesEnabled: { ...ON, ...HOME },
    localServicesManagedEnabled: { ...ON, ...HOME },
    localServicesLauncherEnabled: { ...ON, ...HOME },
    localServicesActionsEnabled: { ...ON, ...HOME },
    localServicesActionsTerminateEnabled: { ...OFF, ...HOME },
    localServicesInventoryEnabled: { ...ON, ...HOME },
    localServicesPreviewEnabled: { ...ON, ...HOME },
    localServicesPreviewTokenTtlMs: {
        type: 'int',
        default: DEFAULT_LOCAL_SERVICE_PREVIEW_TOKEN_TTL_MS,
        bounds: { min: 1 },
        ...AT_STARTUP,
        featureId: 'localServices.preview',
        description: 'Lifetime of a private preview token, in milliseconds.',
    },
    localServicesPreviewHostOriginDomain: {
        type: 'string',
        ...AT_STARTUP,
        featureId: 'localServices.preview',
        description: 'Base domain that serves previews and public stored-content links on isolated origins. When unset, local-service and private Artifact previews are unavailable; public stored-content links require the separate Home opt-in to use its HTTPS address.',
    },
    localServicesPublicPreviewEnabled: { ...OFF, ...HOME },
    localServicesPublicPreviewAllowedModes: {
        type: 'list',
        ...AT_STARTUP,
        featureId: 'localServices.publicPreview',
        description: 'Public exposure modes the server allows (comma or space separated).',
    },
    localServicesPublicPreviewMaxTtlMs: {
        type: 'int',
        bounds: { min: 1 },
        ...AT_STARTUP,
        featureId: 'localServices.publicPreview',
        description: 'Longest a public preview stays exposed, in milliseconds. Unset leaves the protocol limit.',
    },
    localServicesPublicPreviewMaxConcurrentExposures: {
        type: 'int',
        bounds: { min: 1 },
        ...AT_STARTUP,
        featureId: 'localServices.publicPreview',
        description: 'Most public previews exposed at once. Unset leaves the protocol limit.',
    },
    localServicesPublicPreviewDnsTlsRequired: {
        ...ON,
        ...AT_STARTUP,
        featureId: 'localServices.publicPreview',
        description: 'Require an isolated secure preview origin. HTTPS is required except for HTTP on localhost names, including subdomains.',
    },
    localServicesPublicPreviewAuditSink: {
        type: 'string',
        ...AT_STARTUP,
        featureId: 'localServices.publicPreview',
        description: 'Durable audit sink for public previews: `jsonl_file`. Public previews need one.',
    },
    localServicesPublicPreviewAuditLogPath: {
        type: 'string',
        ...AT_STARTUP,
        featureId: 'localServices.publicPreview',
        description: 'File the `jsonl_file` audit sink appends to.',
    },
    localServicesPublicPreviewAllowTestAuditSink: {
        ...OFF,
        ...AT_STARTUP,
        featureId: 'localServices.publicPreview',
        description: 'Development only: accept the in-memory test audit sink (ignored in production).',
    },
    localServicesPublicPreviewRateLimitProfileIds: {
        type: 'list',
        ...AT_STARTUP,
        featureId: 'localServices.publicPreview',
        description: 'Rate-limit profiles public previews may use (comma or space separated).',
    },
    localServicesPublicPreviewRateLimitChecker: {
        type: 'string',
        ...AT_STARTUP,
        featureId: 'localServices.publicPreview',
        description: 'Rate-limit checker for public previews: `fixed_window`. Public previews need one.',
    },
    localServicesPublicPreviewRateLimitMaxRequests: {
        type: 'int',
        bounds: { min: 1 },
        ...AT_STARTUP,
        featureId: 'localServices.publicPreview',
        description: 'Requests the `fixed_window` checker allows per window.',
    },
    localServicesPublicPreviewRateLimitWindowMs: {
        type: 'int',
        bounds: { min: 1 },
        ...AT_STARTUP,
        featureId: 'localServices.publicPreview',
        description: 'Window of the `fixed_window` checker, in milliseconds.',
    },
    localServicesPublicPreviewAllowTestRateLimitChecker: {
        ...OFF,
        ...AT_STARTUP,
        featureId: 'localServices.publicPreview',
        description: 'Development only: accept the in-memory test rate-limit checker (ignored in production).',
    },

    providersEnabled: { ...ON, ...HOME },
    providersLocalDiscoveryEnabled: { ...ON, ...HOME },
    providersLocalModelManagementEnabled: { ...ON, ...HOME },

    searchEnabled: { ...ON, ...AT_STARTUP },

    browserEnabled: { ...ON, ...HOME },
    browserViewTargetsEnabled: { ...ON, ...HOME },
    browserInternalEnabled: { ...ON, ...HOME },
    browserSidecarEnabled: { ...ON, ...HOME },
    browserDiagnosticsEnabled: { ...ON, ...HOME },
    browserContextEnabled: { ...ON, ...HOME },
    browserRecordingEnabled: { ...ON, ...HOME },
    browserAutomationEnabled: { ...ON, ...HOME },

    pluginsEnabled: { ...ON, ...HOME },
    pluginsWebhooksEnabled: { ...OFF, ...HOME },
    pluginsWebhooksProcessMaxRequests: {
        type: 'int',
        default: 4,
        bounds: { min: 1, max: 4 },
        ...AT_STARTUP,
        featureId: 'plugins.webhooks',
        description: 'Most webhook requests this process handles at once.',
    },
    pluginsWebhooksProcessMaxWorkingBytes: {
        type: 'int',
        bounds: { min: 1 },
        ...AT_STARTUP,
        featureId: 'plugins.webhooks',
        description: 'Most working memory in-flight webhook requests may commit, in bytes. Unset: the worst case the request ceiling already permits.',
    },
    pluginsWebhooksRouteRatePerMinute: {
        type: 'int',
        default: 600,
        bounds: { min: 1, max: 600 },
        ...AT_STARTUP,
        featureId: 'plugins.webhooks',
        description: 'Webhook requests per minute on one route.',
    },
    pluginsWebhooksRouteConcurrency: {
        type: 'int',
        default: 16,
        bounds: { min: 1, max: 16 },
        ...AT_STARTUP,
        featureId: 'plugins.webhooks',
        description: 'Webhook requests in flight on one route.',
    },
    pluginsWebhooksEndpointRatePerMinute: {
        type: 'int',
        default: 300,
        bounds: { min: 1, max: 300 },
        ...AT_STARTUP,
        featureId: 'plugins.webhooks',
        description: 'Webhook requests per minute on one endpoint.',
    },
    pluginsWebhooksEndpointConcurrency: {
        type: 'int',
        default: 8,
        bounds: { min: 1, max: 8 },
        ...AT_STARTUP,
        featureId: 'plugins.webhooks',
        description: 'Webhook requests in flight on one endpoint.',
    },
    pluginsWebhooksAccountRatePerMinute: {
        type: 'int',
        default: 3_000,
        bounds: { min: 1, max: 3_000 },
        ...AT_STARTUP,
        featureId: 'plugins.webhooks',
        description: 'Webhook requests per minute for one account.',
    },
    pluginsWebhooksAccountConcurrency: {
        type: 'int',
        default: 32,
        bounds: { min: 1, max: 32 },
        ...AT_STARTUP,
        featureId: 'plugins.webhooks',
        description: 'Webhook requests in flight for one account.',
    },
    pluginsUiEnabled: { ...ON, ...HOME },
    pluginsUiHostedWebEnabled: { ...ON, ...HOME },
    pluginsUiReactNativeBundlesEnabled: { ...ON, ...HOME },
    pluginsUiArtifactHostingEnabled: {
        ...OFF,
        ...HOME,
        featureId: 'plugins.ui',
        description: 'Host plugin UI artifacts on this server. Needs both artifact limits.',
    },
    pluginsUiArtifactHostingMaxArtifactBytes: {
        type: 'int',
        bounds: { min: 1 },
        ...HOME,
        featureId: 'plugins.ui',
        description: 'Largest hosted plugin UI artifact, in bytes.',
    },
    pluginsUiArtifactHostingMaxAccountBytes: {
        type: 'int',
        bounds: { min: 1 },
        ...HOME,
        featureId: 'plugins.ui',
        description: 'Most hosted plugin UI artifact bytes one account may store.',
    },

    collectionMaxRowEncodedBytes: {
        type: 'int',
        default: PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1.maxRowEncodedBytes,
        bounds: { min: 1, max: PLUGIN_COLLECTION_LIMITS_V1.maximumStoredRowEncodedBytes },
        ...AT_STARTUP,
        featureId: 'plugins',
        description: 'Largest encoded plugin Collection row, in bytes.',
    },
    collectionMaxBatchBytes: {
        type: 'int',
        default: PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1.maxBatchBytes,
        bounds: { min: 1, max: PLUGIN_COLLECTION_LIMITS_V1.maximumMutationBatchEncodedBytes },
        ...AT_STARTUP,
        featureId: 'plugins',
        description: 'Largest plugin Collection mutation batch, in bytes.',
    },
    collectionMaxBatchRows: {
        type: 'int',
        default: PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1.maxBatchRows,
        bounds: { min: 1, max: PLUGIN_COLLECTION_LIMITS_V1.maximumMutationBatchRows },
        ...AT_STARTUP,
        featureId: 'plugins',
        description: 'Most rows in one plugin Collection mutation batch.',
    },
    collectionMaxAccountRows: {
        type: 'int',
        default: PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1.maxAccountRows,
        bounds: { min: 1, max: PLUGIN_COLLECTION_LIMITS_V1.maximumAccountRows },
        ...AT_STARTUP,
        featureId: 'plugins',
        description: 'Most plugin Collection rows one account may store.',
    },
    collectionMaxAccountBytes: {
        type: 'int',
        default: PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1.maxAccountBytes,
        bounds: { min: 1, max: PLUGIN_COLLECTION_LIMITS_V1.maximumAccountEncodedBytes },
        ...AT_STARTUP,
        featureId: 'plugins',
        description: 'Most plugin Collection bytes one account may store.',
    },

    devicesEnabled: { ...ON, ...HOME },
    devicesSimulatorPreviewEnabled: { ...ON, ...HOME },

    machinesLiveStreamDirectPeerEnabled: { ...ON, ...AT_STARTUP },
    machinesLiveStreamServerRoutedEnabled: {
        ...ON,
        ...AT_STARTUP,
        description: 'Relay live streams through the server. Optional limits below apply when configured.',
    },
    machinesLiveStreamServerRoutedMaxBitrateBps: {
        ...LIVE_STREAM_CAP,
        featureId: 'machines.liveStream.serverRouted',
        description: 'Highest relayed live-stream bitrate, in bits per second.',
    },
    machinesLiveStreamServerRoutedMaxFramesPerSecond: {
        ...LIVE_STREAM_CAP,
        featureId: 'machines.liveStream.serverRouted',
        description: 'Highest relayed live-stream frame rate.',
    },
    machinesLiveStreamServerRoutedMaxFrameBytes: {
        ...LIVE_STREAM_CAP,
        featureId: 'machines.liveStream.serverRouted',
        description: 'Largest relayed live-stream frame, in bytes.',
    },
    machinesLiveStreamServerRoutedMaxDurationMs: {
        ...LIVE_STREAM_CAP,
        featureId: 'machines.liveStream.serverRouted',
        description: 'Longest relayed live stream, in milliseconds.',
    },
    machinesLiveStreamServerRoutedMaxTotalBytes: {
        ...LIVE_STREAM_CAP,
        featureId: 'machines.liveStream.serverRouted',
        description: 'Most bytes one relayed live stream carries.',
    },
    machinesLiveStreamServerRoutedMaxConcurrentStreamsPerAccount: {
        ...LIVE_STREAM_CAP,
        featureId: 'machines.liveStream.serverRouted',
        description: 'Most relayed live streams one account runs at once.',
    },
    machinesLiveStreamServerRoutedMaxConcurrentStreamsPerSocket: {
        ...LIVE_STREAM_CAP,
        featureId: 'machines.liveStream.serverRouted',
        description: 'Most relayed live streams one socket runs at once.',
    },
    machinesLiveStreamServerRoutedMaxConcurrentStreamsPerMachine: {
        ...LIVE_STREAM_CAP,
        featureId: 'machines.liveStream.serverRouted',
        description: 'Most relayed live streams one machine runs at once.',
    },
    peerMediationRouteGrantSigningKeyId: {
        type: 'string',
        ...AT_STARTUP,
        featureId: 'machines.peerMediation',
        description: 'Id of the key that signs peer-mediation route grants. Peer mediation is off without a signing key.',
    },
    peerMediationRouteGrantSigningPrivateKey: {
        type: 'string',
        ...AT_STARTUP,
        sensitivity: 'secret',
        featureId: 'machines.peerMediation',
        description: 'Private key (base64url) that signs peer-mediation route grants.',
    },
    peerMediationRouteGrantSigningPublicKey: {
        type: 'string',
        ...AT_STARTUP,
        featureId: 'machines.peerMediation',
        description: 'Public key (base64url) matching the grant signing key; derived from the private key when unset.',
    },
    peerMediationRouteGrantSigningExpiresAt: {
        type: 'int',
        bounds: { min: 1 },
        ...AT_STARTUP,
        featureId: 'machines.peerMediation',
        description: 'When the grant signing key expires, as epoch milliseconds.',
    },

    terminalEmbeddedPtyEnabled: { ...ON, ...HOME },
    terminalTransportByteStreamEnabled: { ...ON, ...HOME },

    socialFriendsEnabled: { ...ON, ...HOME },
    socialFriendsAllowUsername: {
        ...ON,
        ...HOME,
        featureId: 'social.friends',
        description: 'Let people find friends by username as well as by linked identity.',
    },
    socialFriendsIdentityProvider: {
        type: 'string',
        default: 'github',
        ...HOME,
        featureId: 'social.friends',
        description: 'Identity provider used to match friends.',
    },

    authRecoveryProviderResetEnabled: {
        ...ON,
        ...POLICY,
        featureId: 'auth.recovery.providerReset',
        aliases: ['AUTH_RECOVERY_PROVIDER_RESET_ENABLED'],
    },
    authLoginKeyChallengeEnabled: {
        ...ON,
        ...POLICY,
        apply: 'restart',
        featureId: 'auth.login.keyChallenge',
    },
    authPairingDesktopQrMobileScanEnabled: {
        ...ON,
        ...POLICY,
        featureId: 'auth.pairing.desktopQrMobileScan',
    },
    authUiAutoRedirectEnabled: {
        ...OFF,
        ...POLICY,
        aliases: ['AUTH_UI_AUTO_REDIRECT'],
        description: 'Send sign-in straight to the auto-redirect provider.',
    },
    authUiAutoRedirectProviderId: {
        type: 'string',
        default: '',
        ...POLICY,
        aliases: ['AUTH_UI_AUTO_REDIRECT_PROVIDER_ID'],
        description: 'Provider the sign-in screen redirects to when auto-redirect is on.',
    },
    authUiRecoveryKeyReminderEnabled: {
        ...ON,
        ...POLICY,
        featureId: 'auth.ui.recoveryKeyReminder',
        aliases: ['AUTH_UI_RECOVERY_KEY_REMINDER_ENABLED'],
    },
    authEmailPasswordEnabled: {
        ...ON,
        ...POLICY,
        description: 'Offer email and password sign-in. The Home sign-in policy and mail readiness still decide.',
    },
    authEmailPasswordProvisionEnabled: {
        ...ON,
        ...POLICY,
        description: 'Allow self-service account creation with email and password.',
    },
    authMtlsEnabled: { ...OFF, ...POLICY },
    authMtlsMode: {
        type: 'enum',
        default: 'forwarded',
        bounds: { values: ['forwarded', 'direct'] },
        ...POLICY,
        featureId: 'auth.mtls',
        description: 'Where the client certificate is verified: `forwarded` (by a proxy) or `direct`.',
    },
    authMtlsAutoProvision: {
        ...OFF,
        ...POLICY,
        featureId: 'auth.mtls',
        description: 'Create an account on first mTLS sign-in.',
    },
    authMtlsTrustForwardedHeaders: {
        ...OFF,
        ...POLICY,
        featureId: 'auth.mtls',
        description: 'Trust the identity headers the proxy forwards.',
    },
    authMtlsIdentitySource: {
        type: 'enum',
        default: 'san_email',
        bounds: { values: ['san_email', 'san_upn', 'subject_cn', 'fingerprint'] },
        ...POLICY,
        featureId: 'auth.mtls',
        description: 'Certificate field that identifies the account.',
    },
    authMtlsAllowedEmailDomains: {
        type: 'list',
        ...POLICY,
        featureId: 'auth.mtls',
        description: 'Email domains allowed to sign in with mTLS (comma or space separated).',
    },
    authMtlsAllowedIssuers: {
        type: 'string',
        ...POLICY,
        featureId: 'auth.mtls',
        description: 'Certificate issuers allowed: CN values separated by commas, or DNs separated by semicolons or newlines.',
    },
    authMtlsForwardedEmailHeader: {
        type: 'string',
        default: 'x-happier-client-cert-email',
        ...POLICY,
        featureId: 'auth.mtls',
        description: 'Header carrying the certificate email in forwarded mode.',
    },
    authMtlsForwardedUpnHeader: {
        type: 'string',
        default: 'x-happier-client-cert-upn',
        ...POLICY,
        featureId: 'auth.mtls',
        description: 'Header carrying the certificate UPN in forwarded mode.',
    },
    authMtlsForwardedSubjectHeader: {
        type: 'string',
        default: 'x-happier-client-cert-subject',
        ...POLICY,
        featureId: 'auth.mtls',
        description: 'Header carrying the certificate subject in forwarded mode.',
    },
    authMtlsForwardedFingerprintHeader: {
        type: 'string',
        default: 'x-happier-client-cert-sha256',
        ...POLICY,
        featureId: 'auth.mtls',
        description: 'Header carrying the certificate SHA-256 fingerprint in forwarded mode.',
    },
    authMtlsForwardedIssuerHeader: {
        type: 'string',
        default: 'x-happier-client-cert-issuer',
        ...POLICY,
        featureId: 'auth.mtls',
        description: 'Header carrying the certificate issuer in forwarded mode.',
    },
    authMtlsReturnToAllowPrefixes: {
        type: 'list',
        ...POLICY,
        featureId: 'auth.mtls',
        description: 'Return addresses allowed after mTLS sign-in. Unset: the app scheme and the web app address.',
    },
    authMtlsClaimTtlSeconds: {
        type: 'int',
        default: 60,
        bounds: { min: 10, max: 3600 },
        ...POLICY,
        featureId: 'auth.mtls',
        description: 'Lifetime of an mTLS sign-in claim code, in seconds.',
    },

    authOauthKeylessEnabled: {
        ...OFF,
        ...POLICY,
        description: 'Allow OAuth sign-in for accounts without an encryption key.',
    },
    authOauthKeylessProviders: {
        type: 'list',
        ...POLICY,
        description: 'OAuth providers allowed for keyless sign-in (comma or space separated).',
    },
    authOauthKeylessAutoProvision: {
        ...OFF,
        ...POLICY,
        description: 'Create a keyless account on first OAuth sign-in.',
    },
    authManagedIdentityPrivateNetworkEnabled: {
        ...OFF,
        ...POLICY,
        description: 'Allow managed identity providers on private networks (the Home sets the allowlist).',
    },

    encryptionStoragePolicy: {
        type: 'enum',
        default: 'required_e2ee',
        bounds: { values: ['required_e2ee', 'optional', 'plaintext_only'] },
        ...POLICY,
        // Its readers include the synchronous session, pending-message, system-record, artifact and
        // settings storage owners, which read `process.env`: a live Home value would reach request
        // readers only. Applied at the next start instead (plan D-12; home owner console U4).
        apply: 'restart',
        featureId: 'encryption.plaintextStorage',
        description: 'Which accounts may store data without end-to-end encryption. Exact lower-case values.',
    },
    encryptionAllowAccountOptOut: {
        ...OFF,
        ...POLICY,
        featureId: 'encryption.accountOptOut',
        description: 'Let an account opt out of end-to-end encryption when storage policy allows it.',
    },
    encryptionDefaultAccountMode: {
        type: 'enum',
        default: 'e2ee',
        bounds: { values: ['e2ee', 'plain'] },
        ...POLICY,
        featureId: 'encryption.plaintextStorage',
        description: 'Encryption mode of new accounts. Exact lower-case values.',
    },
    encryptionPlainAccountSettingsAtRest: {
        type: 'enum',
        default: 'server_sealed',
        bounds: { values: ['none', 'server_sealed'] },
        ...POLICY,
        featureId: 'encryption.plaintextStorage',
        description: 'How plain accounts’ settings are stored at rest.',
    },
    encryptionPlainAccountCredentialsAtRest: {
        type: 'enum',
        default: 'server_sealed',
        bounds: { values: ['none', 'server_sealed'] },
        ...POLICY,
        featureId: 'encryption.plaintextStorage',
        description: 'How plain accounts’ credentials are stored at rest.',
    },
    encryptionPlainAccountArtifactsAtRest: {
        type: 'enum',
        default: 'server_sealed',
        bounds: { values: ['none', 'server_sealed'] },
        ...POLICY,
        featureId: 'encryption.plaintextStorage',
        description: 'How plain accounts’ artifacts are stored at rest.',
    },

    e2eeKeylessAccountsEnabled: {
        ...OFF,
        ...POLICY,
        featureId: 'e2ee.keylessAccounts',
    },
} as const satisfies Record<FeatureEnvProperty, FeatureConfigDeclaration>;
