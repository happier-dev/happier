export const FEATURE_ENV_KEYS = Object.freeze({
  accountPublicProfilesEnabled: 'HAPPIER_FEATURE_ACCOUNT_PUBLIC_PROFILES__ENABLED',
  machinesPoolsEnabled: 'HAPPIER_FEATURE_MACHINES_POOLS__ENABLED',
  teamsEnabled: 'HAPPIER_FEATURE_TEAMS__ENABLED',
  teamsCredentialResourcesEnabled: 'HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED',
  teamsCredentialResourcesExternalApiEnabled: 'HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_EXTERNAL_API__ENABLED',
  workflowsEnabled: 'HAPPIER_FEATURE_WORKFLOWS__ENABLED',
  deploymentsEnabled: 'HAPPIER_FEATURE_DEPLOYMENTS__ENABLED',
  botsEnabled: 'HAPPIER_FEATURE_BOTS__ENABLED',

  artifactRevisionRetentionCount: 'HAPPIER_ARTIFACT_REVISION_RETENTION_COUNT',
  artifactDocumentLimitBytes: 'HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES',
  artifactAccountLimitBytes: 'HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES',

  bugReportsEnabled: 'HAPPIER_FEATURE_BUG_REPORTS__ENABLED',
  bugReportsProviderUrl: 'HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL',
  bugReportsDefaultIncludeDiagnostics: 'HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS',
  bugReportsMaxArtifactBytes: 'HAPPIER_FEATURE_BUG_REPORTS__MAX_ARTIFACT_BYTES',
  bugReportsUploadTimeoutMs: 'HAPPIER_FEATURE_BUG_REPORTS__UPLOAD_TIMEOUT_MS',
  bugReportsAcceptedArtifactKinds: 'HAPPIER_FEATURE_BUG_REPORTS__ACCEPTED_ARTIFACT_KINDS',
  bugReportsContextWindowMs: 'HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS',

  voiceEnabled: 'HAPPIER_FEATURE_VOICE__ENABLED',
  voiceRequireSubscription: 'HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION',

  connectedServicesQuotasEnabled: 'HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED',
  connectedServicesAccountGroupsEnabled: 'HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED',
  connectedServicesAccountFallbackEnabled: 'HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED',

  updatesOtaEnabled: 'HAPPIER_FEATURE_UPDATES_OTA__ENABLED',

  attachmentsUploadsEnabled: 'HAPPIER_FEATURE_ATTACHMENTS_UPLOADS__ENABLED',

  petsCompanionEnabled: 'HAPPIER_FEATURE_PETS_COMPANION__ENABLED',
  petsSyncEnabled: 'HAPPIER_FEATURE_PETS_SYNC__ENABLED',
  petsSyncMaxManifestBytes: 'HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES',
  petsSyncMaxCanonicalSpritesheetBytes: 'HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_SPRITESHEET_BYTES',
  petsSyncMaxCanonicalPackageBytes: 'HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_PACKAGE_BYTES',
  petsSyncMaxImportedPetsPerAccount: 'HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PETS_PER_ACCOUNT',
  petsSyncMaxImportedPetBytesPerAccount: 'HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PET_BYTES_PER_ACCOUNT',
  petsSyncEncryptedCustomPetSyncPolicy: 'HAPPIER_FEATURE_PETS_SYNC__ENCRYPTED_CUSTOM_PET_SYNC_POLICY',

  sessionsHandoffEnabled: 'HAPPIER_FEATURE_SESSIONS_HANDOFF__ENABLED',
  sessionsEphemeralRunnerEnabled: 'HAPPIER_FEATURE_SESSIONS_EPHEMERAL_RUNNER__ENABLED',
  sessionsAgentSwitchingEnabled: 'HAPPIER_FEATURE_SESSIONS_AGENT_SWITCHING__ENABLED',
  sessionsDraftsEnabled: 'HAPPIER_FEATURE_SESSIONS_DRAFTS__ENABLED',
  sessionsFilteredListingEnabled: 'HAPPIER_FEATURE_SESSIONS_FILTERED_LISTING__ENABLED',
  sessionsBoardEnabled: 'HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED',
  sessionsFollowingEnabled: 'HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED',
  sessionsConversationsEnabled: 'HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED',
  sessionsUsageLimitRecoveryEnabled: 'HAPPIER_FEATURE_SESSIONS_USAGE_LIMIT_RECOVERY__ENABLED',
  machinesTransferDirectPeerEnabled: 'HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED',
  machinesRpcDirectPeerEnabled: 'HAPPIER_FEATURE_MACHINES_RPC_DIRECT_PEER__ENABLED',
  machinesPeerMediationObservabilityEnabled:
    'HAPPIER_FEATURE_MACHINES_PEER_MEDIATION_OBSERVABILITY__ENABLED',
  machinesTransferServerRoutedEnabled: 'HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__ENABLED',
  machinesTransferServerRoutedMaxBytes: 'HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES',
  machinesTransferServerRoutedMaxActiveTransfersPerSocket:
    'HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_ACTIVE_TRANSFERS_PER_SOCKET',
  machinesTunnelDirectPeerEnabled: 'HAPPIER_FEATURE_MACHINES_TUNNEL_DIRECT_PEER__ENABLED',
  machinesTunnelServerRoutedEnabled: 'HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED',
  machinesTunnelServerRoutedMaxActiveTunnelsPerSocket:
    'HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_ACTIVE_TUNNELS_PER_SOCKET',
  machinesTunnelServerRoutedMaxFrameBytes: 'HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAME_BYTES',
  machinesTunnelServerRoutedSupportedEncodings:
    'HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__SUPPORTED_ENCODINGS',
  machinesTunnelServerRoutedPreferredEncoding:
    'HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__PREFERRED_ENCODING',
  machinesTunnelServerRoutedMaxBinaryHeaderBytes:
    'HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BINARY_HEADER_BYTES',
  machinesTunnelServerRoutedMaxRawPayloadBytes:
    'HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_RAW_PAYLOAD_BYTES',
  machinesTunnelServerRoutedMaxFramedMessageBytes:
    'HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAMED_MESSAGE_BYTES',
  machinesTunnelServerRoutedMaxConcurrentSubstreams:
    'HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_CONCURRENT_SUBSTREAMS',
  machinesTunnelAllowedPorts: 'HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS',

  // Server-represented local-services settings. Preview availability also depends on
  // the canonical transport, origin, authorization and signing prerequisites.
  localServicesEnabled: 'HAPPIER_FEATURE_LOCAL_SERVICES__ENABLED',
  localServicesManagedEnabled: 'HAPPIER_FEATURE_LOCAL_SERVICES_MANAGED__ENABLED',
  localServicesLauncherEnabled: 'HAPPIER_FEATURE_LOCAL_SERVICES_LAUNCHER__ENABLED',
  localServicesActionsEnabled: 'HAPPIER_FEATURE_LOCAL_SERVICES_ACTIONS__ENABLED',
  localServicesActionsTerminateEnabled: 'HAPPIER_FEATURE_LOCAL_SERVICES_ACTIONS_TERMINATE__ENABLED',
  localServicesInventoryEnabled: 'HAPPIER_FEATURE_LOCAL_SERVICES_INVENTORY__ENABLED',
  localServicesPreviewEnabled: 'HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED',
  localServicesPreviewTokenTtlMs: 'HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__TOKEN_TTL_MS',
  localServicesPreviewHostOriginDomain: 'HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN',
  localServicesPublicPreviewEnabled: 'HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED',
  localServicesPublicPreviewAllowedModes: 'HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES',
  localServicesPublicPreviewMaxTtlMs: 'HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS',
  localServicesPublicPreviewMaxConcurrentExposures:
    'HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_CONCURRENT_EXPOSURES',
  localServicesPublicPreviewDnsTlsRequired: 'HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED',
  localServicesPublicPreviewAuditSink: 'HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_SINK',
  localServicesPublicPreviewAuditLogPath:
    'HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_LOG_PATH',
  localServicesPublicPreviewAllowTestAuditSink:
    'HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK',
  localServicesPublicPreviewRateLimitProfileIds:
    'HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS',
  localServicesPublicPreviewRateLimitChecker:
    'HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER',
  localServicesPublicPreviewRateLimitMaxRequests:
    'HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS',
  localServicesPublicPreviewRateLimitWindowMs:
    'HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS',
  localServicesPublicPreviewAllowTestRateLimitChecker:
    'HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER',

  providersEnabled: 'HAPPIER_FEATURE_PROVIDERS__ENABLED',
  providersLocalDiscoveryEnabled: 'HAPPIER_FEATURE_PROVIDERS_LOCAL_DISCOVERY__ENABLED',
  providersLocalModelManagementEnabled: 'HAPPIER_FEATURE_PROVIDERS_LOCAL_MODEL_MANAGEMENT__ENABLED',

  searchEnabled: 'HAPPIER_FEATURE_SEARCH__ENABLED',

  // Server-represented browser settings, including capture and automation. Defaults
  // are defined by the canonical feature settings owner, not validation status.
  browserEnabled: 'HAPPIER_FEATURE_BROWSER__ENABLED',
  browserViewTargetsEnabled: 'HAPPIER_FEATURE_BROWSER_VIEW_TARGETS__ENABLED',
  browserInternalEnabled: 'HAPPIER_FEATURE_BROWSER_INTERNAL__ENABLED',
  browserSidecarEnabled: 'HAPPIER_FEATURE_BROWSER_SIDECAR__ENABLED',
  browserDiagnosticsEnabled: 'HAPPIER_FEATURE_BROWSER_DIAGNOSTICS__ENABLED',
  browserContextEnabled: 'HAPPIER_FEATURE_BROWSER_CONTEXT__ENABLED',
  browserRecordingEnabled: 'HAPPIER_FEATURE_BROWSER_RECORDING__ENABLED',
  browserAutomationEnabled: 'HAPPIER_FEATURE_BROWSER_AUTOMATION__ENABLED',

  // Core plugin platform + UI projection gates (server-represented + default-allow). The plugin UI
  // tiers below are server-represented + default-ALLOW kill-switches (§4.1/§13.5.3): per-plugin
  // install/enable/trust/runtime derivation (5.1/5.2) governs actual availability.
  pluginsEnabled: 'HAPPIER_FEATURE_PLUGINS__ENABLED',
  pluginsWebhooksEnabled: 'HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED',
  pluginsWebhooksProcessMaxRequests: 'HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_REQUESTS',
  pluginsWebhooksProcessMaxWorkingBytes: 'HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_WORKING_BYTES',
  pluginsWebhooksRouteRatePerMinute: 'HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_RATE_PER_MINUTE',
  pluginsWebhooksRouteConcurrency: 'HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_CONCURRENCY',
  pluginsWebhooksEndpointRatePerMinute: 'HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_RATE_PER_MINUTE',
  pluginsWebhooksEndpointConcurrency: 'HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_CONCURRENCY',
  pluginsWebhooksAccountRatePerMinute: 'HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_RATE_PER_MINUTE',
  pluginsWebhooksAccountConcurrency: 'HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_CONCURRENCY',
  pluginsUiEnabled: 'HAPPIER_FEATURE_PLUGINS_UI__ENABLED',
  pluginsUiHostedWebEnabled: 'HAPPIER_FEATURE_PLUGINS_UI_HOSTED_WEB__ENABLED',
  pluginsUiReactNativeBundlesEnabled: 'HAPPIER_FEATURE_PLUGINS_UI_REACT_NATIVE_BUNDLES__ENABLED',
  pluginsUiArtifactHostingEnabled: 'HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__ENABLED',
  pluginsUiArtifactHostingMaxArtifactBytes: 'HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES',
  pluginsUiArtifactHostingMaxAccountBytes: 'HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES',

  collectionMaxRowEncodedBytes: 'HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES',
  collectionMaxBatchBytes: 'HAPPIER_COLLECTION_MAX_BATCH_BYTES',
  collectionMaxBatchRows: 'HAPPIER_COLLECTION_MAX_BATCH_ROWS',
  collectionMaxAccountRows: 'HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS',
  collectionMaxAccountBytes: 'HAPPIER_COLLECTION_MAX_ACCOUNT_BYTES',

  // Device/simulator preview gates (server-represented + default-allow per §4.1): viewing your own
  // simulator. The live-stream + browser.viewTargets dependency closure still gates availability.
  devicesEnabled: 'HAPPIER_FEATURE_DEVICES__ENABLED',
  devicesSimulatorPreviewEnabled: 'HAPPIER_FEATURE_DEVICES_SIMULATOR_PREVIEW__ENABLED',

  machinesLiveStreamDirectPeerEnabled: 'HAPPIER_FEATURE_MACHINES_LIVE_STREAM_DIRECT_PEER__ENABLED',
  machinesLiveStreamServerRoutedEnabled: 'HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__ENABLED',
  machinesLiveStreamServerRoutedMaxBitrateBps:
    'HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_BITRATE_BPS',
  machinesLiveStreamServerRoutedMaxFramesPerSecond:
    'HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAMES_PER_SECOND',
  machinesLiveStreamServerRoutedMaxFrameBytes:
    'HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAME_BYTES',
  machinesLiveStreamServerRoutedMaxDurationMs:
    'HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_DURATION_MS',
  machinesLiveStreamServerRoutedMaxTotalBytes:
    'HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_TOTAL_BYTES',
  machinesLiveStreamServerRoutedMaxConcurrentStreamsPerAccount:
    'HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_ACCOUNT',
  machinesLiveStreamServerRoutedMaxConcurrentStreamsPerSocket:
    'HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_SOCKET',
  machinesLiveStreamServerRoutedMaxConcurrentStreamsPerMachine:
    'HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_MACHINE',
  peerMediationRouteGrantSigningKeyId: 'HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID',
  peerMediationRouteGrantSigningPrivateKey: 'HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY',
  peerMediationRouteGrantSigningPublicKey: 'HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY',
  peerMediationRouteGrantSigningExpiresAt: 'HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT',

  terminalEmbeddedPtyEnabled: 'HAPPIER_FEATURE_TERMINAL_EMBEDDED_PTY__ENABLED',
  terminalTransportByteStreamEnabled: 'HAPPIER_FEATURE_TERMINAL_TRANSPORT_BYTE_STREAM__ENABLED',

  socialFriendsEnabled: 'HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED',
  socialFriendsAllowUsername: 'HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME',
  socialFriendsIdentityProvider: 'HAPPIER_FEATURE_SOCIAL_FRIENDS__IDENTITY_PROVIDER',

  authRecoveryProviderResetEnabled: 'HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED',
  authLoginKeyChallengeEnabled: 'HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED',
  authPairingDesktopQrMobileScanEnabled: 'HAPPIER_FEATURE_AUTH_PAIRING__DESKTOP_QR_MOBILE_SCAN_ENABLED',
  authUiAutoRedirectEnabled: 'HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_ENABLED',
  authUiAutoRedirectProviderId: 'HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_PROVIDER_ID',
  authUiRecoveryKeyReminderEnabled: 'HAPPIER_FEATURE_AUTH_UI__RECOVERY_KEY_REMINDER_ENABLED',
  // Native email/password deployment configuration. This is required server
  // configuration for the `email_password` method decision, not a published
  // per-method feature bit: no `auth.login.emailPassword` capability exists.
  // Both default on; the persisted Home governance policy and transactional-mail
  // readiness are the functional deciders, and these keys are the operator
  // opt-out for a deployment that wants the method off entirely.
  authEmailPasswordEnabled: 'HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED',
  authEmailPasswordProvisionEnabled: 'HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__PROVISION_ENABLED',
  authMtlsEnabled: 'HAPPIER_FEATURE_AUTH_MTLS__ENABLED',
  authMtlsMode: 'HAPPIER_FEATURE_AUTH_MTLS__MODE',
  authMtlsAutoProvision: 'HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION',
  authMtlsTrustForwardedHeaders: 'HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS',
  authMtlsIdentitySource: 'HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE',
  authMtlsAllowedEmailDomains: 'HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS',
  authMtlsAllowedIssuers: 'HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS',
  authMtlsForwardedEmailHeader: 'HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER',
  authMtlsForwardedUpnHeader: 'HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_UPN_HEADER',
  authMtlsForwardedSubjectHeader: 'HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_SUBJECT_HEADER',
  authMtlsForwardedFingerprintHeader: 'HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_FINGERPRINT_HEADER',
  authMtlsForwardedIssuerHeader: 'HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER',
  authMtlsReturnToAllowPrefixes: 'HAPPIER_FEATURE_AUTH_MTLS__RETURN_TO_ALLOW_PREFIXES',
  authMtlsClaimTtlSeconds: 'HAPPIER_FEATURE_AUTH_MTLS__CLAIM_TTL_SECONDS',

  authOauthKeylessEnabled: 'HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED',
  authOauthKeylessProviders: 'HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS',
  authOauthKeylessAutoProvision: 'HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_AUTO_PROVISION',
  authManagedIdentityPrivateNetworkEnabled:
    'HAPPIER_FEATURE_AUTH_MANAGED_IDENTITY__PRIVATE_NETWORK_ENABLED',

  encryptionStoragePolicy: 'HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY',
  encryptionAllowAccountOptOut: 'HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT',
  encryptionDefaultAccountMode: 'HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE',
  encryptionPlainAccountSettingsAtRest: 'HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST',
  encryptionPlainAccountCredentialsAtRest: 'HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST',
  encryptionPlainAccountArtifactsAtRest: 'HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST',

  e2eeKeylessAccountsEnabled: 'HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED',
});

export type FeatureEnvKey = (typeof FEATURE_ENV_KEYS)[keyof typeof FEATURE_ENV_KEYS];
