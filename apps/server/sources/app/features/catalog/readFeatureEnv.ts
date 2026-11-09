import { parseBooleanEnv } from '../../../config/env';
import { MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY, normalizeMachineTransferServerRoutedMaxBytes } from '@happier-dev/protocol/features/payload/capabilities/machineTransferCapabilities';
import { MachineLiveStreamRelayCapsV1Schema, type MachineLiveStreamRelayCaps } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { LocalServicePublicExposureModeV1Schema, type LocalServicePublicExposureModeV1, type LocalServicePublicPolicyV1 } from '@happier-dev/protocol/local/services/public/v1';
import { PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1 } from '@happier-dev/protocol/plugins/webhooks/deliveryV1';
import { PluginDataCollectionsCapabilitiesSchema, type PluginDataCollectionsCapabilities } from '@happier-dev/protocol/features/payload/capabilities/pluginDataCollectionsCapabilities';
import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { normalizeMachineTunnelAllowedPorts, normalizeMachineTunnelPreferredEncoding, normalizeMachineTunnelPositiveInt, normalizeMachineTunnelSupportedEncodings, type MachineTunnelSubstreamCapabilities } from '@happier-dev/protocol/features/payload/capabilities/machineTunnelCapabilities';
import { type PeerTcpTunnelEncoding } from '@happier-dev/protocol/machines/peer/mediation/tunnel/encoding';
import { resolvePeerMediationGrantSigningConfig } from '@/app/machines/peer/mediation/mintDirectRouteGrantV1';
import { resolveEffectiveWebappBaseUrl } from '../../serverUrls/effectiveServerUrls';
import { chargePluginWebhookWorkingBytesV1 } from '@/app/plugins/webhooks/admission';
import { FEATURE_ENV_KEYS, type FeatureEnvKey } from './featureEnvSchema';
import { FEATURE_READER_DEFAULTS, type FeatureEnvProperty } from './featureReaderDefaults';
import { FEATURE_CONFIG } from './featureServerConfig';

export { FEATURE_READER_DEFAULTS };

export function readArtifactStorageEnv(env: NodeJS.ProcessEnv) {
  return {
    revisionRetentionCount: readFeatureConfig(env, 'artifactRevisionRetentionCount'),
    documentLimitBytes: readFeatureConfig(env, 'artifactDocumentLimitBytes') ?? null,
    accountLimitBytes: readFeatureConfig(env, 'artifactAccountLimitBytes') ?? null,
  };
}

/**
 * Reads one feature key through the server configuration registry codec, with the default and
 * bounds `FEATURE_READER_DEFAULTS` declares (the same parse `parseBooleanEnv`/`parseIntEnv` did).
 */
function readFeatureConfig<P extends FeatureEnvProperty>(env: NodeJS.ProcessEnv, property: P) {
  return readServerConfig(env, FEATURE_CONFIG[property]);
}

export type WorkflowsFeatureEnv = Readonly<{
  enabled: boolean;
}>;

export type BugReportsFeatureEnv = Readonly<{
  enabled: boolean;
  providerUrlRaw: string | null;
  defaultIncludeDiagnostics: boolean;
  maxArtifactBytes: number;
  uploadTimeoutMs: number;
  acceptedArtifactKindsRaw: string | undefined;
  contextWindowMs: number;
}>;

export type VoiceFeatureEnv = Readonly<{
  enabled: boolean;
  requireSubscription: boolean;
}>;

export type ConnectedServicesFeatureEnv = Readonly<{
  quotasEnabled: boolean;
  accountGroupsEnabled: boolean;
  accountFallbackEnabled: boolean;
}>;

export type SessionUsageLimitRecoveryFeatureEnv = Readonly<{
  enabled: boolean;
}>;

export type UpdatesFeatureEnv = Readonly<{
  otaEnabled: boolean;
}>;

export type AttachmentsUploadsFeatureEnv = Readonly<{
  enabled: boolean;
}>;

export type PetsFeatureEnv = Readonly<{
  companionEnabled: boolean;
  syncEnabled: boolean;
  maxManifestBytes: number;
  maxCanonicalSpritesheetBytes: number;
  maxCanonicalPackageBytes: number;
  maxImportedPetsPerAccount: number;
  maxImportedPetBytesPerAccount: number;
  encryptedCustomPetSyncPolicy: "disabled";
}>;

export type SessionHandoffFeatureEnv = Readonly<{
  handoffEnabled: boolean;
}>;

export type SessionAgentSwitchingFeatureEnv = Readonly<{
  agentSwitchingEnabled: boolean;
}>;

export type SessionDraftsFeatureEnv = Readonly<{
  draftsEnabled: boolean;
}>;

export type SessionFilteredListingFeatureEnv = Readonly<{
  filteredListingEnabled: boolean;
}>;

export type SessionFollowingFeatureEnv = Readonly<{
  followingEnabled: boolean;
}>;

export type SessionConversationsFeatureEnv = Readonly<{
  conversationsEnabled: boolean;
}>;

export type MachineTransferFeatureEnv = Readonly<{
  directPeerEnabled: boolean;
  serverRoutedEnabled: boolean;
  serverRoutedMaxBytes: number | null;
  serverRoutedMaxActiveTransfersPerSocket: number;
}>;

export type MachineTunnelFeatureEnv = Readonly<{
  directPeerEnabled: boolean;
  serverRoutedEnabled: boolean;
  allowedPorts: readonly number[];
  serverRoutedMaxActiveTunnelsPerSocket: number | undefined;
  serverRoutedMaxFrameBytes: number;
  serverRoutedSupportedEncodings: readonly PeerTcpTunnelEncoding[];
  serverRoutedPreferredEncoding: PeerTcpTunnelEncoding;
  serverRoutedMaxBinaryHeaderBytes: number;
  serverRoutedMaxRawPayloadBytes: number;
  serverRoutedMaxFramedMessageBytes: number;
  serverRoutedSubstreams: MachineTunnelSubstreamCapabilities;
}>;

export type MachineRpcFeatureEnv = Readonly<{
  directPeerEnabled: boolean;
}>;

export type MachinePoolsFeatureEnv = Readonly<{ enabled: boolean }>;

export type LocalServicesFeatureEnv = Readonly<{
  // Core product gates (default-allow): the server is the gate for the user-facing product.
  enabled: boolean;
  managedEnabled: boolean;
  launcherEnabled: boolean;
  actionsEnabled: boolean;
  actionsTerminateEnabled: boolean;
  inventoryEnabled: boolean;
  // Exposure gates (default-off, fail-closed): genuinely server-impacting surfaces.
  previewEnabled: boolean;
  previewTokenTtlMs: number;
  previewHostOriginBaseDomain: string | null;
  publicPreviewEnabled: boolean;
  publicPolicy: LocalServicePublicPolicyV1;
  publicAuditDependency: LocalServicePublicAuditDependencyEnv;
  publicAuditTestSinkAllowed: boolean;
  publicRateLimitDependency: LocalServicePublicRateLimitDependencyEnv;
  publicRateLimitTestCheckerAllowed: boolean;
}>;

export type ProvidersFeatureEnv = Readonly<{
  enabled: boolean;
  localDiscoveryEnabled: boolean;
  localModelManagementEnabled: boolean;
}>;

export type SearchFeatureEnv = Readonly<{
  enabled: boolean;
}>;

export type TeamsFeatureEnv = Readonly<{
  enabled: boolean;
  credentialResourcesEnabled: boolean;
  credentialResourcesExternalApiEnabled: boolean;
}>;

export type BrowserFeatureEnv = Readonly<{
  // Core product gates (default-allow).
  enabled: boolean;
  viewTargetsEnabled: boolean;
  internalEnabled: boolean;
  // Capability-available surfaces (default-ALLOW per §13.4; the dangerous agent-initiated exercise
  // is approval-gated, not flag-gated). The server can still disable any independently.
  diagnosticsEnabled: boolean;
  contextEnabled: boolean;
  recordingEnabled: boolean;
  automationEnabled: boolean;
  // The managed sidecar stays the lone fail-closed exception (heavy binary, agent-CDP only).
  sidecarEnabled: boolean;
}>;

export type PluginsFeatureEnv = Readonly<{
  // Core platform + UI projection gates (default-allow).
  enabled: boolean;
  // Public ingress is security-sensitive and remains disabled until the operator completes rollout.
  webhooksEnabled: boolean;
  webhookIngressPolicy: WebhookIngressPolicyV1;
  uiEnabled: boolean;
  // Plugin UI tier kill-switches (server-represented + default-ALLOW per §4.1/§13.5.3). These are
  // coarse server/build kill-switches only; per-plugin install/enable/trust/runtime derivation
  // (5.1/5.2) governs actual availability.
  uiHostedWebEnabled: boolean;
  uiReactNativeBundlesEnabled: boolean;
  // Operator infrastructure limits. Missing or incoherent values leave artifact hosting unavailable.
  uiArtifactHostingEnabled: boolean;
  uiArtifactHostingMaxArtifactBytes: number | undefined;
  uiArtifactHostingMaxAccountBytes: number | undefined;
  collectionLimits: PluginDataCollectionsCapabilities;
}>;

/**
 * The one server-owned ingress policy. These are operational ceilings only:
 * no manifest, endpoint, or plugin contribution can supply or raise them.
 */
export type WebhookIngressPolicyV1 = Readonly<{
  version: 1;
  process: Readonly<{
    maxRequests: number;
    /**
     * Aggregate ceiling on the working memory this process has committed to
     * in-flight webhook requests. One request costs a measured multiple of its
     * declared raw body, not the raw body alone. Its default is the exact worst
     * case the request ceiling already permits (`maxRequests` x the protocol
     * raw-body limit x that multiple), so the count is what binds by default
     * and this stays a real lever only for an operator who wants a tighter
     * memory bound than their replica's own budget.
     */
    maxWorkingBytes: number;
  }>;
  route: Readonly<{
    ratePerMinute: number;
    concurrency: number;
  }>;
  endpoint: Readonly<{
    ratePerMinute: number;
    concurrency: number;
  }>;
  account: Readonly<{
    ratePerMinute: number;
    concurrency: number;
  }>;
}>;

export type DevicesFeatureEnv = Readonly<{
  // Server-represented + default-allow (§4.1): viewing your own simulator. The live-stream +
  // browser.viewTargets dependency closure still gates availability at the decision runtime.
  enabled: boolean;
  simulatorPreviewEnabled: boolean;
}>;

export type LocalServicePublicAuditDependencyEnv =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'test_dev' }>
  | Readonly<{ kind: 'jsonl_file'; path: string }>;

export type LocalServicePublicRateLimitDependencyEnv =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'test_dev' }>
  | Readonly<{ kind: 'fixed_window'; maxRequests: number; windowMs: number }>;

export type MachineLiveStreamFeatureEnv = Readonly<{
  directPeerEnabled: boolean;
  serverRoutedEnabled: boolean;
  serverRoutedCaps: MachineLiveStreamRelayCaps | null;
  serverRoutedDisabledReason: 'relay_not_enabled' | 'relay_caps_missing';
}>;

export type PeerMediationGrantSigningKeyCapabilityEnv = Readonly<{
  keyId: string;
  publicKey: string;
  expiresAt: number | null;
}>;

export type PeerMediationFeatureEnv = Readonly<{
  grantSigningKeys: readonly PeerMediationGrantSigningKeyCapabilityEnv[];
  /**
   * Grant signing is the substrate's real master switch: without a signing key the grant-mint route
   * 404s and the preview tunnel throws `grant_signing_unavailable`, so `machines.peerMediation` is
   * derived from it rather than from a second, independently-settable variable.
   */
  substrateEnabled: boolean;
  observabilityEnabled: boolean;
}>;

export type TerminalFeatureEnv = Readonly<{
  embeddedPtyEnabled: boolean;
  transportByteStreamEnabled: boolean;
}>;

export type SocialFriendsFeatureEnv = Readonly<{
  enabled: boolean;
  allowUsername: boolean;
  identityProvider: string;
}>;

export type AuthFeatureEnv = Readonly<{
  recoveryProviderResetEnabled: boolean;
  loginKeyChallengeEnabled: boolean;
  pairingDesktopQrMobileScanEnabled: boolean;
  uiAutoRedirectEnabled: boolean;
  uiAutoRedirectProviderId: string;
  uiRecoveryKeyReminderEnabled: boolean;
}>;

export type AuthEmailPasswordFeatureEnv = Readonly<{
  enabled: boolean;
  provisionEnabled: boolean;
}>;

export type AuthMtlsIdentitySource = "san_email" | "san_upn" | "subject_cn" | "fingerprint";
export type AuthMtlsFeatureEnv = Readonly<{
  enabled: boolean;
  mode: "forwarded" | "direct";
  autoProvision: boolean;
  trustForwardedHeaders: boolean;
  identitySource: AuthMtlsIdentitySource;
  allowedEmailDomains: readonly string[];
  allowedIssuers: readonly string[];
  forwardedEmailHeader: string;
  forwardedUpnHeader: string;
  forwardedSubjectHeader: string;
  forwardedFingerprintHeader: string;
  forwardedIssuerHeader: string;
  returnToAllowPrefixes: readonly string[];
  claimTtlSeconds: number;
}>;

export type AuthOauthKeylessFeatureEnv = Readonly<{
  enabled: boolean;
  providers: readonly string[];
  autoProvision: boolean;
}>;

export type EncryptionFeatureEnv = Readonly<{
  storagePolicy: "required_e2ee" | "optional" | "plaintext_only";
  allowAccountOptOut: boolean;
  defaultAccountMode: "e2ee" | "plain";
  plainAccountSettingsAtRest: "none" | "server_sealed";
  plainAccountCredentialsAtRest: "none" | "server_sealed";
  plainAccountArtifactsAtRest: "none" | "server_sealed";
}>;

export type E2eeFeatureEnv = Readonly<{
  keylessAccountsEnabled: boolean;
}>;

function parseCsvList(raw: string | undefined): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(/[,\s]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCommaList(raw: string | undefined): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(/[,\n]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePortList(raw: string | undefined): readonly number[] {
  if (typeof raw !== "string") return [];
  const rawPorts = raw
    .split(/[,\s]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => Number.parseInt(entry, 10));
  return normalizeMachineTunnelAllowedPorts(rawPorts);
}

function parseLocalServicePublicExposureModes(raw: string | undefined): LocalServicePublicExposureModeV1[] {
  const modes: LocalServicePublicExposureModeV1[] = [];
  for (const item of parseCsvList(raw)) {
    const parsed = LocalServicePublicExposureModeV1Schema.safeParse(item);
    if (parsed.success && !modes.includes(parsed.data)) {
      modes.push(parsed.data);
    }
  }
  return modes;
}

function readTrimmedOptional(raw: string | undefined): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

function readLocalServicePublicAuditDependency(
  env: NodeJS.ProcessEnv,
  allowTestDevDependency: boolean,
): LocalServicePublicAuditDependencyEnv {
  const sink = readTrimmedOptional(env[FEATURE_ENV_KEYS.localServicesPublicPreviewAuditSink])?.toLowerCase() ?? '';
  if (sink === 'jsonl_file') {
    const path = readTrimmedOptional(env[FEATURE_ENV_KEYS.localServicesPublicPreviewAuditLogPath]);
    return path ? { kind: 'jsonl_file', path } : { kind: 'none' };
  }
  if (
    allowTestDevDependency
    && readFeatureConfig(env, 'localServicesPublicPreviewAllowTestAuditSink')
  ) {
    return { kind: 'test_dev' };
  }
  return { kind: 'none' };
}

function readLocalServicePublicRateLimitDependency(
  env: NodeJS.ProcessEnv,
  allowTestDevDependency: boolean,
): LocalServicePublicRateLimitDependencyEnv {
  const checker = readTrimmedOptional(env[FEATURE_ENV_KEYS.localServicesPublicPreviewRateLimitChecker])?.toLowerCase() ?? '';
  if (checker === 'fixed_window') {
    const maxRequests = readFeatureConfig(env, 'localServicesPublicPreviewRateLimitMaxRequests');
    const windowMs = readFeatureConfig(env, 'localServicesPublicPreviewRateLimitWindowMs');
    return maxRequests && windowMs
      ? { kind: 'fixed_window', maxRequests, windowMs }
      : { kind: 'none' };
  }
  if (
    allowTestDevDependency
    && readFeatureConfig(env, 'localServicesPublicPreviewAllowTestRateLimitChecker')
  ) {
    return { kind: 'test_dev' };
  }
  return { kind: 'none' };
}

function normalizeIssuerDnLower(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function extractIssuerCommonName(normalizedDnLower: string): string | null {
  const match = normalizedDnLower.match(/(?:^|,|\/)\s*cn\s*=\s*([^,\/]+)\s*(?:,|\/|$)/i);
  const cn = match?.[1]?.trim() ?? "";
  return cn || null;
}

function countRdnAssignments(normalizedDnLower: string): number {
  const matches = normalizedDnLower.match(/\b[a-z][a-z0-9-]*\s*=/g);
  return matches?.length ?? 0;
}

// Normalizes issuer allowlist entries into one of:
// - "cn=..." for CN-only matching
// - "dn=..." for exact DN matching (normalized)
export function normalizeAuthMtlsIssuerValue(raw: string): string {
  const normalized = normalizeIssuerDnLower(raw);
  if (!normalized) return "";

  // Ergonomic CN-only entries (either bare strings or "cn=...").
  const rdnCount = countRdnAssignments(normalized);
  const cn = extractIssuerCommonName(normalized);
  if (!normalized.includes("=")) {
    return `cn=${normalized}`;
  }
  if (rdnCount <= 1 && cn) {
    return `cn=${cn}`;
  }

  // Treat as an exact DN entry.
  return `dn=${normalized}`;
}

function parseIssuerAllowlist(raw: string | undefined): string[] {
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // DN strings commonly contain commas; avoid splitting on commas when the input looks DN-shaped.
  if (trimmed.includes("=")) {
    // Allow multiple DN entries via newline or semicolon separation.
    return trimmed
      .split(/[;\n]+/g)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Otherwise treat as a standard CSV/whitespace list of CN values.
  // CN strings commonly include spaces; split on comma/newline only.
  return parseCommaList(trimmed);
}

export function readPublicProfilesFeatureEnv(env: NodeJS.ProcessEnv): Readonly<{ enabled: boolean }> {
  return { enabled: readFeatureConfig(env, 'accountPublicProfilesEnabled') };
}

export function readWorkflowsFeatureEnv(env: NodeJS.ProcessEnv): WorkflowsFeatureEnv {
  return {
    enabled: readFeatureConfig(env, 'workflowsEnabled'),
  };
}

export function readBugReportsFeatureEnv(env: NodeJS.ProcessEnv): BugReportsFeatureEnv {
  return {
    enabled: readFeatureConfig(env, 'bugReportsEnabled'),
    providerUrlRaw:
      typeof env[FEATURE_ENV_KEYS.bugReportsProviderUrl] === 'string'
        ? (env[FEATURE_ENV_KEYS.bugReportsProviderUrl] ?? '').trim()
        : null,
    defaultIncludeDiagnostics: readFeatureConfig(env, 'bugReportsDefaultIncludeDiagnostics'),
    maxArtifactBytes: readFeatureConfig(env, 'bugReportsMaxArtifactBytes'),
    uploadTimeoutMs: readFeatureConfig(env, 'bugReportsUploadTimeoutMs'),
    acceptedArtifactKindsRaw: env[FEATURE_ENV_KEYS.bugReportsAcceptedArtifactKinds],
    contextWindowMs: readFeatureConfig(env, 'bugReportsContextWindowMs'),
  };
}

export function readVoiceFeatureEnv(env: NodeJS.ProcessEnv): VoiceFeatureEnv {
  const isProduction = env.NODE_ENV === 'production';
  return {
    enabled: readFeatureConfig(env, 'voiceEnabled'),
    requireSubscription: parseBooleanEnv(env[FEATURE_ENV_KEYS.voiceRequireSubscription], isProduction),
  };
}

export function readConnectedServicesFeatureEnv(env: NodeJS.ProcessEnv): ConnectedServicesFeatureEnv {
  return {
    quotasEnabled: readFeatureConfig(env, 'connectedServicesQuotasEnabled'),
    accountGroupsEnabled: readFeatureConfig(env, 'connectedServicesAccountGroupsEnabled'),
    accountFallbackEnabled: readFeatureConfig(env, 'connectedServicesAccountFallbackEnabled'),
  };
}

export function readUpdatesFeatureEnv(env: NodeJS.ProcessEnv): UpdatesFeatureEnv {
  return {
    otaEnabled: readFeatureConfig(env, 'updatesOtaEnabled'),
  };
}

export function readAttachmentsUploadsFeatureEnv(env: NodeJS.ProcessEnv): AttachmentsUploadsFeatureEnv {
  return {
    enabled: readFeatureConfig(env, 'attachmentsUploadsEnabled'),
  };
}

export function readPetsFeatureEnv(env: NodeJS.ProcessEnv): PetsFeatureEnv {
  return {
    companionEnabled: readFeatureConfig(env, 'petsCompanionEnabled'),
    syncEnabled: readFeatureConfig(env, 'petsSyncEnabled'),
    maxManifestBytes: readFeatureConfig(env, 'petsSyncMaxManifestBytes'),
    maxCanonicalSpritesheetBytes: readFeatureConfig(env, 'petsSyncMaxCanonicalSpritesheetBytes'),
    maxCanonicalPackageBytes: readFeatureConfig(env, 'petsSyncMaxCanonicalPackageBytes'),
    maxImportedPetsPerAccount: readFeatureConfig(env, 'petsSyncMaxImportedPetsPerAccount'),
    maxImportedPetBytesPerAccount: readFeatureConfig(env, 'petsSyncMaxImportedPetBytesPerAccount'),
    encryptedCustomPetSyncPolicy: FEATURE_READER_DEFAULTS.petsSyncEncryptedCustomPetSyncPolicy.default,
  };
}

export function readPeerMediationFeatureEnv(env: NodeJS.ProcessEnv): PeerMediationFeatureEnv {
  // Fail closed: an absent or malformed observability variable resolves to disabled.
  const observabilityEnabled = readFeatureConfig(env, 'machinesPeerMediationObservabilityEnabled');
  const signing = resolvePeerMediationGrantSigningConfig(env);
  if (!signing.ok) {
    return { grantSigningKeys: [], substrateEnabled: false, observabilityEnabled };
  }

  return {
    grantSigningKeys: [signing.capability],
    substrateEnabled: true,
    observabilityEnabled,
  };
}

export function readSessionHandoffFeatureEnv(env: NodeJS.ProcessEnv): SessionHandoffFeatureEnv {
  return {
    handoffEnabled: readFeatureConfig(env, 'sessionsHandoffEnabled'),
  };
}

export function readSessionEphemeralRunnerFeatureEnv(env: NodeJS.ProcessEnv): Readonly<{ ephemeralRunnerEnabled: boolean }> {
  return { ephemeralRunnerEnabled: readFeatureConfig(env, 'sessionsEphemeralRunnerEnabled') };
}

export function readSessionAgentSwitchingFeatureEnv(env: NodeJS.ProcessEnv): SessionAgentSwitchingFeatureEnv {
  return {
    agentSwitchingEnabled: readFeatureConfig(env, 'sessionsAgentSwitchingEnabled'),
  };
}

export function readSessionDraftsFeatureEnv(env: NodeJS.ProcessEnv): SessionDraftsFeatureEnv {
  return {
    draftsEnabled: readFeatureConfig(env, 'sessionsDraftsEnabled'),
  };
}

export function readSessionFilteredListingFeatureEnv(env: NodeJS.ProcessEnv): SessionFilteredListingFeatureEnv {
  return {
    filteredListingEnabled: readFeatureConfig(env, 'sessionsFilteredListingEnabled'),
  };
}

export function readSessionBoardFeatureEnv(env: NodeJS.ProcessEnv) {
  return { enabled: readFeatureConfig(env, 'sessionsBoardEnabled') };
}

export function readSessionFollowingFeatureEnv(env: NodeJS.ProcessEnv): SessionFollowingFeatureEnv {
  return {
    followingEnabled: readFeatureConfig(env, 'sessionsFollowingEnabled'),
  };
}

export function readSessionConversationsFeatureEnv(env: NodeJS.ProcessEnv): SessionConversationsFeatureEnv {
  return {
    conversationsEnabled: readFeatureConfig(env, 'sessionsConversationsEnabled'),
  };
}

export function readSessionUsageLimitRecoveryFeatureEnv(env: NodeJS.ProcessEnv): SessionUsageLimitRecoveryFeatureEnv {
  return {
    enabled: readFeatureConfig(env, 'sessionsUsageLimitRecoveryEnabled'),
  };
}

export function readMachineTransferFeatureEnv(env: NodeJS.ProcessEnv): MachineTransferFeatureEnv {
  const configuredServerRoutedMaxBytes = normalizeMachineTransferServerRoutedMaxBytes(
    env[FEATURE_ENV_KEYS.machinesTransferServerRoutedMaxBytes] ?? env[MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY],
  );
  const resolvedServerRoutedMaxBytes = Math.min(
    configuredServerRoutedMaxBytes ?? FEATURE_READER_DEFAULTS.machinesTransferServerRoutedMaxBytes.default,
    FEATURE_READER_DEFAULTS.machinesTransferServerRoutedMaxBytes.bounds.max,
  );

  return {
    directPeerEnabled: readFeatureConfig(env, 'machinesTransferDirectPeerEnabled'),
    serverRoutedEnabled: readFeatureConfig(env, 'machinesTransferServerRoutedEnabled'),
    serverRoutedMaxBytes: resolvedServerRoutedMaxBytes,
    serverRoutedMaxActiveTransfersPerSocket: readFeatureConfig(env, 'machinesTransferServerRoutedMaxActiveTransfersPerSocket'),
  };
}

export function readMachineTunnelFeatureEnv(env: NodeJS.ProcessEnv): MachineTunnelFeatureEnv {
  const serverRoutedSupportedEncodings = normalizeMachineTunnelSupportedEncodings(
    env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedSupportedEncodings],
  );
  return {
    directPeerEnabled: readFeatureConfig(env, 'machinesTunnelDirectPeerEnabled'),
    serverRoutedEnabled: readFeatureConfig(env, 'machinesTunnelServerRoutedEnabled'),
    allowedPorts: parsePortList(env[FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]),
    serverRoutedMaxActiveTunnelsPerSocket: readFeatureConfig(env, 'machinesTunnelServerRoutedMaxActiveTunnelsPerSocket'),
    serverRoutedMaxFrameBytes: normalizeMachineTunnelPositiveInt(
      env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxFrameBytes],
      FEATURE_READER_DEFAULTS.machinesTunnelServerRoutedMaxFrameBytes.default,
      { max: FEATURE_READER_DEFAULTS.machinesTunnelServerRoutedMaxFrameBytes.bounds.max },
    ),
    serverRoutedSupportedEncodings,
    serverRoutedPreferredEncoding: normalizeMachineTunnelPreferredEncoding(
      env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedPreferredEncoding],
      serverRoutedSupportedEncodings,
    ),
    serverRoutedMaxBinaryHeaderBytes: normalizeMachineTunnelPositiveInt(
      env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxBinaryHeaderBytes],
      FEATURE_READER_DEFAULTS.machinesTunnelServerRoutedMaxBinaryHeaderBytes.default,
      { max: FEATURE_READER_DEFAULTS.machinesTunnelServerRoutedMaxBinaryHeaderBytes.bounds.max },
    ),
    serverRoutedMaxRawPayloadBytes: normalizeMachineTunnelPositiveInt(
      env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxRawPayloadBytes],
      FEATURE_READER_DEFAULTS.machinesTunnelServerRoutedMaxRawPayloadBytes.default,
      { max: FEATURE_READER_DEFAULTS.machinesTunnelServerRoutedMaxRawPayloadBytes.bounds.max },
    ),
    serverRoutedMaxFramedMessageBytes: normalizeMachineTunnelPositiveInt(
      env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxFramedMessageBytes],
      FEATURE_READER_DEFAULTS.machinesTunnelServerRoutedMaxFramedMessageBytes.default,
      { max: FEATURE_READER_DEFAULTS.machinesTunnelServerRoutedMaxFramedMessageBytes.bounds.max },
    ),
    serverRoutedSubstreams: {
      maxConcurrentSubstreams: readFeatureConfig(env, 'machinesTunnelServerRoutedMaxConcurrentSubstreams'),
    },
  };
}

export function readLocalServicesFeatureEnv(env: NodeJS.ProcessEnv): LocalServicesFeatureEnv {
  // PRV-1: private preview is the user's OWN dev server reached over loopback — there is no
  // internet exposure, proxy, or tunnel involved — so it defaults ON.
  // `publicPreview` (real internet exposure) stays fail-closed
  // default-off below: that is the explicit, per-use line.
  const previewEnabled = readFeatureConfig(env, 'localServicesPreviewEnabled');
  const publicPreviewEnabled = readFeatureConfig(env, 'localServicesPublicPreviewEnabled');
  const allowLocalPublicPreviewTestDependencies = env.NODE_ENV !== 'production';
  const publicAuditDependency = readLocalServicePublicAuditDependency(env, allowLocalPublicPreviewTestDependencies);
  const publicRateLimitDependency = readLocalServicePublicRateLimitDependency(env, allowLocalPublicPreviewTestDependencies);

  // Core product gates default to allow (the server is the gate); inventory no longer derives
  // from preview. Private `preview` defaults ON (loopback only); the `publicPreview` exposure
  // gate stays fail-closed default-off.
  const enabled = readFeatureConfig(env, 'localServicesEnabled');

  return {
    enabled,
    managedEnabled: readFeatureConfig(env, 'localServicesManagedEnabled'),
    launcherEnabled: readFeatureConfig(env, 'localServicesLauncherEnabled'),
    actionsEnabled: readFeatureConfig(env, 'localServicesActionsEnabled'),
    actionsTerminateEnabled: readFeatureConfig(env, 'localServicesActionsTerminateEnabled'),
    inventoryEnabled: readFeatureConfig(env, 'localServicesInventoryEnabled'),
    previewEnabled,
    previewTokenTtlMs: readFeatureConfig(env, 'localServicesPreviewTokenTtlMs'),
    previewHostOriginBaseDomain: readFeatureConfig(env, 'localServicesPreviewHostOriginDomain') ?? null,
    publicPreviewEnabled,
    publicPolicy: {
      enabled: publicPreviewEnabled,
      allowedModes: parseLocalServicePublicExposureModes(env[FEATURE_ENV_KEYS.localServicesPublicPreviewAllowedModes]),
      maxTtlMs: readFeatureConfig(env, 'localServicesPublicPreviewMaxTtlMs'),
      maxConcurrentExposures: readFeatureConfig(env, 'localServicesPublicPreviewMaxConcurrentExposures'),
      dnsTlsRequired: readFeatureConfig(env, 'localServicesPublicPreviewDnsTlsRequired'),
      // OE-4: not operator-configurable. The only non-default value (`false`) emitted the
      // `audit_required_disabled` DISABLED reason, so the knob could only ever be set to its
      // default. A public exposure always requires a durable audit sink.
      auditRequired: true,
      rateLimitProfileIds: parseCsvList(env[FEATURE_ENV_KEYS.localServicesPublicPreviewRateLimitProfileIds]),
    },
    publicAuditDependency,
    publicAuditTestSinkAllowed: publicAuditDependency.kind === 'test_dev',
    publicRateLimitDependency,
    publicRateLimitTestCheckerAllowed: publicRateLimitDependency.kind === 'test_dev',
  };
}

export function readProvidersFeatureEnv(env: NodeJS.ProcessEnv): ProvidersFeatureEnv {
  return {
    enabled: readFeatureConfig(env, 'providersEnabled'),
    localDiscoveryEnabled: readFeatureConfig(env, 'providersLocalDiscoveryEnabled'),
    localModelManagementEnabled: readFeatureConfig(env, 'providersLocalModelManagementEnabled'),
  };
}

export function readSearchFeatureEnv(env: NodeJS.ProcessEnv): SearchFeatureEnv {
  return {
    enabled: readFeatureConfig(env, 'searchEnabled'),
  };
}

export function readTeamsFeatureEnv(env: NodeJS.ProcessEnv): TeamsFeatureEnv {
  return {
    enabled: readFeatureConfig(env, 'teamsEnabled'),
    credentialResourcesEnabled: readFeatureConfig(env, 'teamsCredentialResourcesEnabled'),
    credentialResourcesExternalApiEnabled: readFeatureConfig(env, 'teamsCredentialResourcesExternalApiEnabled'),
  };
}

export function readMachinePoolsFeatureEnv(env: NodeJS.ProcessEnv): MachinePoolsFeatureEnv {
  return { enabled: readFeatureConfig(env, 'machinesPoolsEnabled') };
}

export function readBrowserFeatureEnv(env: NodeJS.ProcessEnv): BrowserFeatureEnv {
  // One default posture (FINALIZATION-PLAN §4.1/§13.4): the browser capabilities are available by
  // default; the dangerous *agent-initiated* exercise stays approval-gated by the active agent
  // approval floor (`AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS`), and user-initiated forms never
  // prompt. So these gates are server-represented + default-ALLOW (the server can still disable any
  // of them independently for its users via its own bit):
  //   - diagnostics: read-only devtools on your own page (IMMEDIATE — split out of the dangerous
  //     group per §13.4; needs no approval prerequisite).
  //   - automation / context / recording: the *capability* is available by default now that the
  //     ActionExecutor front door + surface-keyed `session_agent` approval defaults have landed
  //     (Phase 3.1/3.2/3.4). Flipping them ON does NOT let an agent automate without consent — the
  //     agent path is approval-gated; only user-initiated forms run unprompted.
  // The managed Chromium sidecar is now source-backed and server-represented + default-ALLOW like
  // the rest of the browser branch. Servers can still explicitly disable `browser.sidecar`.
  return {
    enabled: readFeatureConfig(env, 'browserEnabled'),
    viewTargetsEnabled: readFeatureConfig(env, 'browserViewTargetsEnabled'),
    internalEnabled: readFeatureConfig(env, 'browserInternalEnabled'),
    sidecarEnabled: readFeatureConfig(env, 'browserSidecarEnabled'),
    diagnosticsEnabled: readFeatureConfig(env, 'browserDiagnosticsEnabled'),
    contextEnabled: readFeatureConfig(env, 'browserContextEnabled'),
    recordingEnabled: readFeatureConfig(env, 'browserRecordingEnabled'),
    automationEnabled: readFeatureConfig(env, 'browserAutomationEnabled'),
  };
}

function readLoweredWebhookIngressLimit(
  env: NodeJS.ProcessEnv,
  key: FeatureEnvKey,
  ceiling: number,
): number {
  const raw = env[key];
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/u.test(raw.trim())) return ceiling;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value <= ceiling ? value : ceiling;
}

function readWebhookIngressPolicyV1(env: NodeJS.ProcessEnv): WebhookIngressPolicyV1 {
  const maxRequests = readLoweredWebhookIngressLimit(
    env,
    FEATURE_ENV_KEYS.pluginsWebhooksProcessMaxRequests,
    FEATURE_READER_DEFAULTS.pluginsWebhooksProcessMaxRequests.default,
  );
  return Object.freeze({
    version: 1,
    process: Object.freeze({
      maxRequests,
      maxWorkingBytes: readLoweredWebhookIngressLimit(
        env,
        FEATURE_ENV_KEYS.pluginsWebhooksProcessMaxWorkingBytes,
        chargePluginWebhookWorkingBytesV1(maxRequests * PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1),
      ),
    }),
    route: Object.freeze({
      ratePerMinute: readLoweredWebhookIngressLimit(env, FEATURE_ENV_KEYS.pluginsWebhooksRouteRatePerMinute, FEATURE_READER_DEFAULTS.pluginsWebhooksRouteRatePerMinute.default),
      concurrency: readLoweredWebhookIngressLimit(env, FEATURE_ENV_KEYS.pluginsWebhooksRouteConcurrency, FEATURE_READER_DEFAULTS.pluginsWebhooksRouteConcurrency.default),
    }),
    endpoint: Object.freeze({
      ratePerMinute: readLoweredWebhookIngressLimit(env, FEATURE_ENV_KEYS.pluginsWebhooksEndpointRatePerMinute, FEATURE_READER_DEFAULTS.pluginsWebhooksEndpointRatePerMinute.default),
      concurrency: readLoweredWebhookIngressLimit(env, FEATURE_ENV_KEYS.pluginsWebhooksEndpointConcurrency, FEATURE_READER_DEFAULTS.pluginsWebhooksEndpointConcurrency.default),
    }),
    account: Object.freeze({
      ratePerMinute: readLoweredWebhookIngressLimit(env, FEATURE_ENV_KEYS.pluginsWebhooksAccountRatePerMinute, FEATURE_READER_DEFAULTS.pluginsWebhooksAccountRatePerMinute.default),
      concurrency: readLoweredWebhookIngressLimit(env, FEATURE_ENV_KEYS.pluginsWebhooksAccountConcurrency, FEATURE_READER_DEFAULTS.pluginsWebhooksAccountConcurrency.default),
    }),
  });
}

function readCollectionDeploymentPositiveInt(input: Readonly<{
  env: NodeJS.ProcessEnv;
  key: FeatureEnvKey;
  fallback: number;
  maximum: number;
}>): number {
  const raw = input.env[input.key];
  if (raw === undefined) return input.fallback;
  const value = raw.trim();
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${input.key} must be a positive safe integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > input.maximum) {
    throw new Error(`${input.key} must be at most ${input.maximum}.`);
  }
  return parsed;
}

/**
 * The one operator-configured Collection deployment policy. It is read by
 * feature projection, activation readiness, and mutation enforcement; none
 * of those consumers parses environment variables independently.
 */
function readPluginDataCollectionsDeploymentLimits(env: NodeJS.ProcessEnv): PluginDataCollectionsCapabilities {
  const limits = {
    maxRowEncodedBytes: readCollectionDeploymentPositiveInt({
      env,
      key: FEATURE_ENV_KEYS.collectionMaxRowEncodedBytes,
      fallback: FEATURE_READER_DEFAULTS.collectionMaxRowEncodedBytes.default,
      maximum: FEATURE_READER_DEFAULTS.collectionMaxRowEncodedBytes.bounds.max,
    }),
    maxBatchBytes: readCollectionDeploymentPositiveInt({
      env,
      key: FEATURE_ENV_KEYS.collectionMaxBatchBytes,
      fallback: FEATURE_READER_DEFAULTS.collectionMaxBatchBytes.default,
      maximum: FEATURE_READER_DEFAULTS.collectionMaxBatchBytes.bounds.max,
    }),
    maxBatchRows: readCollectionDeploymentPositiveInt({
      env,
      key: FEATURE_ENV_KEYS.collectionMaxBatchRows,
      fallback: FEATURE_READER_DEFAULTS.collectionMaxBatchRows.default,
      maximum: FEATURE_READER_DEFAULTS.collectionMaxBatchRows.bounds.max,
    }),
    maxAccountRows: readCollectionDeploymentPositiveInt({
      env,
      key: FEATURE_ENV_KEYS.collectionMaxAccountRows,
      fallback: FEATURE_READER_DEFAULTS.collectionMaxAccountRows.default,
      maximum: FEATURE_READER_DEFAULTS.collectionMaxAccountRows.bounds.max,
    }),
    maxAccountBytes: readCollectionDeploymentPositiveInt({
      env,
      key: FEATURE_ENV_KEYS.collectionMaxAccountBytes,
      fallback: FEATURE_READER_DEFAULTS.collectionMaxAccountBytes.default,
      maximum: FEATURE_READER_DEFAULTS.collectionMaxAccountBytes.bounds.max,
    }),
  } satisfies PluginDataCollectionsCapabilities;
  const parsed = PluginDataCollectionsCapabilitiesSchema.safeParse(limits);
  if (!parsed.success) {
    throw new Error(
      'HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES, HAPPIER_COLLECTION_MAX_BATCH_BYTES, '
      + 'HAPPIER_COLLECTION_MAX_BATCH_ROWS, HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS, and '
      + 'HAPPIER_COLLECTION_MAX_ACCOUNT_BYTES must form a coherent Collection deployment policy.',
    );
  }
  return Object.freeze(parsed.data);
}

export function readPluginsFeatureEnv(env: NodeJS.ProcessEnv): PluginsFeatureEnv {
  // Core plugin platform + UI projection default to allow (server is the gate). The plugin UI tiers
  // are also server-represented + default-ALLOW kill-switches (§4.1/§13.5.3): the server/build can
  // disable a tier for its users, but per-plugin install/enable/trust/runtime derivation (5.1/5.2)
  // governs actual render.
  return {
    enabled: readFeatureConfig(env, 'pluginsEnabled'),
    webhooksEnabled: readFeatureConfig(env, 'pluginsWebhooksEnabled'),
    webhookIngressPolicy: readWebhookIngressPolicyV1(env),
    uiEnabled: readFeatureConfig(env, 'pluginsUiEnabled'),
    uiHostedWebEnabled: readFeatureConfig(env, 'pluginsUiHostedWebEnabled'),
    uiReactNativeBundlesEnabled: readFeatureConfig(env, 'pluginsUiReactNativeBundlesEnabled'),
    uiArtifactHostingEnabled: readFeatureConfig(env, 'pluginsUiArtifactHostingEnabled'),
    uiArtifactHostingMaxArtifactBytes: readFeatureConfig(env, 'pluginsUiArtifactHostingMaxArtifactBytes'),
    uiArtifactHostingMaxAccountBytes: readFeatureConfig(env, 'pluginsUiArtifactHostingMaxAccountBytes'),
    collectionLimits: readPluginDataCollectionsDeploymentLimits(env),
  };
}

export function readDevicesFeatureEnv(env: NodeJS.ProcessEnv): DevicesFeatureEnv {
  // Server-represented + default-allow (§4.1): the device/simulator preview product is on by
  // default (viewing your own simulator); the server/build can disable it for its users.
  return {
    enabled: readFeatureConfig(env, 'devicesEnabled'),
    simulatorPreviewEnabled: readFeatureConfig(env, 'devicesSimulatorPreviewEnabled'),
  };
}

export function readMachineRpcFeatureEnv(env: NodeJS.ProcessEnv): MachineRpcFeatureEnv {
  return {
    directPeerEnabled: readFeatureConfig(env, 'machinesRpcDirectPeerEnabled'),
  };
}

function parseOptionalPositiveIntFromEnv(env: NodeJS.ProcessEnv, key: string): number | null | undefined {
  const raw = env[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function readMachineLiveStreamFeatureEnv(env: NodeJS.ProcessEnv): MachineLiveStreamFeatureEnv {
  const serverRoutedRequested = readFeatureConfig(env, 'machinesLiveStreamServerRoutedEnabled');
  const capsCandidate = {
    maxBitrateBps: parseOptionalPositiveIntFromEnv(env, FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxBitrateBps),
    maxFramesPerSecond: parseOptionalPositiveIntFromEnv(
      env,
      FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxFramesPerSecond,
    ),
    maxFrameBytes: parseOptionalPositiveIntFromEnv(env, FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxFrameBytes),
    maxDurationMs: parseOptionalPositiveIntFromEnv(env, FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxDurationMs),
    maxTotalBytes: parseOptionalPositiveIntFromEnv(env, FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxTotalBytes),
    maxConcurrentStreamsPerAccount: parseOptionalPositiveIntFromEnv(
      env,
      FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxConcurrentStreamsPerAccount,
    ),
    maxConcurrentStreamsPerSocket: parseOptionalPositiveIntFromEnv(
      env,
      FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxConcurrentStreamsPerSocket,
    ),
    maxConcurrentStreamsPerMachine: parseOptionalPositiveIntFromEnv(
      env,
      FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxConcurrentStreamsPerMachine,
    ),
  };
  const parsedCaps = MachineLiveStreamRelayCapsV1Schema.safeParse(
    Object.fromEntries(Object.entries(capsCandidate).filter(([, value]) => value !== undefined)),
  );
  const serverRoutedCaps = serverRoutedRequested && parsedCaps.success ? parsedCaps.data : null;

  return {
    directPeerEnabled: readFeatureConfig(env, 'machinesLiveStreamDirectPeerEnabled'),
    serverRoutedEnabled: serverRoutedRequested && serverRoutedCaps !== null,
    serverRoutedCaps,
    serverRoutedDisabledReason: serverRoutedRequested ? 'relay_caps_missing' : 'relay_not_enabled',
  };
}

export function readTerminalFeatureEnv(env: NodeJS.ProcessEnv): TerminalFeatureEnv {
  const embeddedPtyEnabled = readFeatureConfig(env, 'terminalEmbeddedPtyEnabled');
  return {
    embeddedPtyEnabled,
    transportByteStreamEnabled: embeddedPtyEnabled
      && readFeatureConfig(env, 'terminalTransportByteStreamEnabled'),
  };
}

export function readSocialFriendsFeatureEnv(env: NodeJS.ProcessEnv): SocialFriendsFeatureEnv {
  const rawIdentityProvider = readFeatureConfig(env, 'socialFriendsIdentityProvider');

  return {
    enabled: readFeatureConfig(env, 'socialFriendsEnabled'),
    allowUsername: readFeatureConfig(env, 'socialFriendsAllowUsername'),
    identityProvider: rawIdentityProvider,
  };
}

export function readAuthFeatureEnv(env: NodeJS.ProcessEnv): AuthFeatureEnv {
  const legacyRecoveryProviderResetEnabled = env.AUTH_RECOVERY_PROVIDER_RESET_ENABLED;
  const legacyUiAutoRedirectEnabled = env.AUTH_UI_AUTO_REDIRECT;
  const legacyUiAutoRedirectProviderId = env.AUTH_UI_AUTO_REDIRECT_PROVIDER_ID;
  const legacyUiRecoveryKeyReminderEnabled = env.AUTH_UI_RECOVERY_KEY_REMINDER_ENABLED;

  return {
    recoveryProviderResetEnabled: parseBooleanEnv(
      env[FEATURE_ENV_KEYS.authRecoveryProviderResetEnabled] ?? legacyRecoveryProviderResetEnabled,
      FEATURE_READER_DEFAULTS.authRecoveryProviderResetEnabled.default,
    ),
    loginKeyChallengeEnabled: readFeatureConfig(env, 'authLoginKeyChallengeEnabled'),
    pairingDesktopQrMobileScanEnabled: readFeatureConfig(env, 'authPairingDesktopQrMobileScanEnabled'),
    uiAutoRedirectEnabled: parseBooleanEnv(
      env[FEATURE_ENV_KEYS.authUiAutoRedirectEnabled] ?? legacyUiAutoRedirectEnabled,
      FEATURE_READER_DEFAULTS.authUiAutoRedirectEnabled.default,
    ),
    uiAutoRedirectProviderId: (
      env[FEATURE_ENV_KEYS.authUiAutoRedirectProviderId]
      ?? legacyUiAutoRedirectProviderId
      ?? FEATURE_READER_DEFAULTS.authUiAutoRedirectProviderId.default
    )
      .trim()
      .toLowerCase(),
    uiRecoveryKeyReminderEnabled: parseBooleanEnv(
      env[FEATURE_ENV_KEYS.authUiRecoveryKeyReminderEnabled] ?? legacyUiRecoveryKeyReminderEnabled,
      FEATURE_READER_DEFAULTS.authUiRecoveryKeyReminderEnabled.default,
    ),
  };
}

/**
 * Native email/password deployment configuration. Both values default to
 * enabled, with the env keys as the operator opt-out — the same shape every
 * other shipped program bit uses. What actually decides availability is the
 * persisted Home governance policy (`enabledMethodIds`) for the method and
 * transactional-mail readiness for self-service provisioning; the effective
 * auth-method decision owner folds both in, so this reader must not add a
 * second, deployment-only "off" answer for the same fact.
 */
export function readAuthEmailPasswordFeatureEnv(env: NodeJS.ProcessEnv): AuthEmailPasswordFeatureEnv {
  return {
    enabled: readFeatureConfig(env, 'authEmailPasswordEnabled'),
    provisionEnabled: readFeatureConfig(env, 'authEmailPasswordProvisionEnabled'),
  };
}

export function readAuthMtlsFeatureEnv(env: NodeJS.ProcessEnv): AuthMtlsFeatureEnv {
  const enabled = readFeatureConfig(env, 'authMtlsEnabled');
  const mode = readFeatureConfig(env, 'authMtlsMode') as AuthMtlsFeatureEnv["mode"];

  const autoProvision = readFeatureConfig(env, 'authMtlsAutoProvision');
  const trustForwardedHeaders = readFeatureConfig(env, 'authMtlsTrustForwardedHeaders');

  const identitySource = readFeatureConfig(env, 'authMtlsIdentitySource') as AuthMtlsFeatureEnv["identitySource"];

  const allowedEmailDomains = Object.freeze(parseCsvList(env[FEATURE_ENV_KEYS.authMtlsAllowedEmailDomains]).map((s) => s.toLowerCase()));
  const allowedIssuers = Object.freeze(parseIssuerAllowlist(env[FEATURE_ENV_KEYS.authMtlsAllowedIssuers]).map(normalizeAuthMtlsIssuerValue).filter(Boolean));

  const forwardedEmailHeader = (env[FEATURE_ENV_KEYS.authMtlsForwardedEmailHeader] ?? FEATURE_READER_DEFAULTS.authMtlsForwardedEmailHeader.default)
    .toString()
    .trim()
    .toLowerCase();
  const forwardedUpnHeader = (env[FEATURE_ENV_KEYS.authMtlsForwardedUpnHeader] ?? FEATURE_READER_DEFAULTS.authMtlsForwardedUpnHeader.default)
    .toString()
    .trim()
    .toLowerCase();
  const forwardedSubjectHeader = (env[FEATURE_ENV_KEYS.authMtlsForwardedSubjectHeader] ?? FEATURE_READER_DEFAULTS.authMtlsForwardedSubjectHeader.default)
    .toString()
    .trim()
    .toLowerCase();
  const forwardedFingerprintHeader = (env[FEATURE_ENV_KEYS.authMtlsForwardedFingerprintHeader] ?? FEATURE_READER_DEFAULTS.authMtlsForwardedFingerprintHeader.default)
    .toString()
    .trim()
    .toLowerCase();
  const forwardedIssuerHeader = (env[FEATURE_ENV_KEYS.authMtlsForwardedIssuerHeader] ?? FEATURE_READER_DEFAULTS.authMtlsForwardedIssuerHeader.default)
    .toString()
    .trim()
    .toLowerCase();

  const allowPrefixesFromEnv = parseCsvList(env[FEATURE_ENV_KEYS.authMtlsReturnToAllowPrefixes]);
  const webUrl = resolveEffectiveWebappBaseUrl(env).trim();
  const returnToAllowPrefixes = Object.freeze(
    (allowPrefixesFromEnv.length > 0 ? allowPrefixesFromEnv : ["happier://", webUrl])
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const claimTtlSeconds = readFeatureConfig(env, 'authMtlsClaimTtlSeconds');

  return {
    enabled,
    mode,
    autoProvision,
    trustForwardedHeaders,
    identitySource,
    allowedEmailDomains,
    allowedIssuers,
    forwardedEmailHeader,
    forwardedUpnHeader,
    forwardedSubjectHeader,
    forwardedFingerprintHeader,
    forwardedIssuerHeader,
    returnToAllowPrefixes,
    claimTtlSeconds,
  };
}

export function readAuthOauthKeylessFeatureEnv(env: NodeJS.ProcessEnv): AuthOauthKeylessFeatureEnv {
  const enabled = readFeatureConfig(env, 'authOauthKeylessEnabled');
  const providers = Object.freeze(parseCsvList(env[FEATURE_ENV_KEYS.authOauthKeylessProviders]).map((s) => s.toLowerCase()));
  const autoProvision = readFeatureConfig(env, 'authOauthKeylessAutoProvision');
  return {
    enabled,
    providers,
    autoProvision,
  };
}

export function readEncryptionFeatureEnv(env: NodeJS.ProcessEnv): EncryptionFeatureEnv {
  const rawStoragePolicy = (env[FEATURE_ENV_KEYS.encryptionStoragePolicy] ?? "").toString().trim();
  const storagePolicy: EncryptionFeatureEnv["storagePolicy"] =
    rawStoragePolicy === "optional" || rawStoragePolicy === "plaintext_only" || rawStoragePolicy === "required_e2ee"
      ? rawStoragePolicy
      : FEATURE_READER_DEFAULTS.encryptionStoragePolicy.default;

  const allowAccountOptOut = readFeatureConfig(env, 'encryptionAllowAccountOptOut');
  const rawDefaultAccountMode = (env[FEATURE_ENV_KEYS.encryptionDefaultAccountMode] ?? "").toString().trim();
  const defaultAccountMode: EncryptionFeatureEnv["defaultAccountMode"] =
    rawDefaultAccountMode === "plain" || rawDefaultAccountMode === "e2ee"
      ? rawDefaultAccountMode
      : FEATURE_READER_DEFAULTS.encryptionDefaultAccountMode.default;

  const plainAccountSettingsAtRest = readFeatureConfig(env, 'encryptionPlainAccountSettingsAtRest') as EncryptionFeatureEnv["plainAccountSettingsAtRest"];

  const plainAccountCredentialsAtRest = readFeatureConfig(env, 'encryptionPlainAccountCredentialsAtRest') as EncryptionFeatureEnv["plainAccountCredentialsAtRest"];

  const plainAccountArtifactsAtRest = readFeatureConfig(env, 'encryptionPlainAccountArtifactsAtRest') as EncryptionFeatureEnv["plainAccountArtifactsAtRest"];

  return {
    storagePolicy,
    allowAccountOptOut,
    defaultAccountMode,
    plainAccountSettingsAtRest,
    plainAccountCredentialsAtRest,
    plainAccountArtifactsAtRest,
  };
}

export function readE2eeFeatureEnv(env: NodeJS.ProcessEnv): E2eeFeatureEnv {
  return {
    keylessAccountsEnabled: readFeatureConfig(env, 'e2eeKeylessAccountsEnabled'),
  };
}
