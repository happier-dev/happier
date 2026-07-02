import { parseBooleanEnv, parseIntEnv } from '../../../config/env';
import {
  DEFAULT_MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES,
  DEFAULT_LOCAL_SERVICE_PREVIEW_TOKEN_TTL_MS,
  DEFAULT_MACHINE_TUNNEL_MAX_DURATION_MS,
  DEFAULT_MACHINE_TUNNEL_MAX_IDLE_MS,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_ALLOW_V1_FALLBACK,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_AGGREGATE_BYTES,
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET,
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
  DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_SUPPORTED_ENCODINGS,
  MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY,
  MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_HARD_MAX,
  MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET_HARD_MAX,
  MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX,
  MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX,
  MACHINE_TUNNEL_SERVER_ROUTED_MAX_SUBSTREAMS_HARD_MAX,
  MachineLiveStreamRelayCapsV1Schema,
  LocalServicePublicExposureModeV1Schema,
  normalizeMachineTunnelAllowedPorts,
  normalizeMachineTunnelPreferredEncoding,
  normalizeMachineTunnelPositiveInt,
  normalizeMachineTunnelSupportedEncodings,
  normalizeMachineTransferServerRoutedMaxBytes,
  PET_PACKAGE_LIMITS_V1,
  type MachineLiveStreamRelayCaps,
  type MachineTunnelSubstreamCapabilities,
  type LocalServicePublicExposureModeV1,
  type LocalServicePublicPolicyV1,
  type PeerTcpTunnelEncoding,
} from '@happier-dev/protocol';
import { resolvePeerMediationGrantSigningConfig } from '@/app/machines/peer/mediation/mintDirectRouteGrantV1';
import { resolveEffectiveWebappBaseUrl } from '../../serverUrls/effectiveServerUrls';
import { FEATURE_ENV_KEYS } from './featureEnvSchema';

export type AutomationsFeatureEnv = Readonly<{
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
  enabled: boolean;
  quotasEnabled: boolean;
  accountGroupsEnabled: boolean;
  accountFallbackEnabled: boolean;
}>;

export type SessionUsageLimitRecoveryFeatureEnv = Readonly<{
  enabled: boolean;
}>;

export type ChannelBridgesFeatureEnv = Readonly<{
  enabled: boolean;
  telegramEnabled: boolean;
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

export type SessionFoldersFeatureEnv = Readonly<{
  foldersEnabled: boolean;
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
  maxIdleMs: number;
  maxDurationMs: number;
  serverRoutedMaxBytes: number;
  serverRoutedMaxActiveTunnelsPerSocket: number;
  serverRoutedMaxFrameBytes: number;
  serverRoutedSupportedEncodings: readonly PeerTcpTunnelEncoding[];
  serverRoutedPreferredEncoding: PeerTcpTunnelEncoding;
  serverRoutedAllowV1Fallback: boolean;
  serverRoutedMaxBinaryHeaderBytes: number;
  serverRoutedMaxRawPayloadBytes: number;
  serverRoutedMaxFramedMessageBytes: number;
  serverRoutedSubstreams: MachineTunnelSubstreamCapabilities;
}>;

export type MachineRpcFeatureEnv = Readonly<{
  directPeerEnabled: boolean;
}>;

export type LocalServicesFeatureEnv = Readonly<{
  inventoryEnabled: boolean;
  previewEnabled: boolean;
  previewTokenTtlMs: number;
  previewHostOriginBaseDomain: string | null;
  publicPreviewEnabled: boolean;
  publicPolicy: LocalServicePublicPolicyV1;
}>;

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
}>;

export type TerminalFeatureEnv = Readonly<{
  embeddedPtyEnabled: boolean;
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

function readOptionalPositiveInt(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readTrimmedOptional(raw: string | undefined): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
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

export function readAutomationsFeatureEnv(env: NodeJS.ProcessEnv): AutomationsFeatureEnv {
  return {
    enabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.automationsEnabled], true),
  };
}

export function readBugReportsFeatureEnv(env: NodeJS.ProcessEnv): BugReportsFeatureEnv {
  return {
    enabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.bugReportsEnabled], true),
    providerUrlRaw:
      typeof env[FEATURE_ENV_KEYS.bugReportsProviderUrl] === 'string'
        ? (env[FEATURE_ENV_KEYS.bugReportsProviderUrl] ?? '').trim()
        : null,
    defaultIncludeDiagnostics: parseBooleanEnv(env[FEATURE_ENV_KEYS.bugReportsDefaultIncludeDiagnostics], true),
    maxArtifactBytes: parseIntEnv(env[FEATURE_ENV_KEYS.bugReportsMaxArtifactBytes], 10 * 1024 * 1024, { min: 1024 }),
    uploadTimeoutMs: parseIntEnv(env[FEATURE_ENV_KEYS.bugReportsUploadTimeoutMs], 120000, { min: 5000 }),
    acceptedArtifactKindsRaw: env[FEATURE_ENV_KEYS.bugReportsAcceptedArtifactKinds],
    contextWindowMs: parseIntEnv(env[FEATURE_ENV_KEYS.bugReportsContextWindowMs], 30 * 60 * 1000, {
      min: 1000,
      max: 24 * 60 * 60 * 1000,
    }),
  };
}

export function readVoiceFeatureEnv(env: NodeJS.ProcessEnv): VoiceFeatureEnv {
  const isProduction = env.NODE_ENV === 'production';
  return {
    enabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.voiceEnabled], true),
    requireSubscription: parseBooleanEnv(env[FEATURE_ENV_KEYS.voiceRequireSubscription], isProduction),
  };
}

export function readConnectedServicesFeatureEnv(env: NodeJS.ProcessEnv): ConnectedServicesFeatureEnv {
  return {
    enabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.connectedServicesEnabled], true),
    quotasEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.connectedServicesQuotasEnabled], true),
    accountGroupsEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.connectedServicesAccountGroupsEnabled], true),
    accountFallbackEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.connectedServicesAccountFallbackEnabled], true),
  };
}

export function readChannelBridgesFeatureEnv(env: NodeJS.ProcessEnv): ChannelBridgesFeatureEnv {
  return {
    enabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.channelBridgesEnabled], true),
    telegramEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.channelBridgesTelegramEnabled], true),
  };
}

export function readUpdatesFeatureEnv(env: NodeJS.ProcessEnv): UpdatesFeatureEnv {
  return {
    otaEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.updatesOtaEnabled], true),
  };
}

export function readAttachmentsUploadsFeatureEnv(env: NodeJS.ProcessEnv): AttachmentsUploadsFeatureEnv {
  return {
    enabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.attachmentsUploadsEnabled], true),
  };
}

export function readPetsFeatureEnv(env: NodeJS.ProcessEnv): PetsFeatureEnv {
  return {
    companionEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.petsCompanionEnabled], true),
    syncEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.petsSyncEnabled], false),
    maxManifestBytes: parseIntEnv(env[FEATURE_ENV_KEYS.petsSyncMaxManifestBytes], PET_PACKAGE_LIMITS_V1.maxManifestBytes, { min: 1 }),
    maxCanonicalSpritesheetBytes: parseIntEnv(
      env[FEATURE_ENV_KEYS.petsSyncMaxCanonicalSpritesheetBytes],
      PET_PACKAGE_LIMITS_V1.maxCanonicalSpritesheetBytes,
      { min: 1 },
    ),
    maxCanonicalPackageBytes: parseIntEnv(
      env[FEATURE_ENV_KEYS.petsSyncMaxCanonicalPackageBytes],
      PET_PACKAGE_LIMITS_V1.maxCanonicalPackageBytes,
      { min: 1 },
    ),
    maxImportedPetsPerAccount: parseIntEnv(
      env[FEATURE_ENV_KEYS.petsSyncMaxImportedPetsPerAccount],
      PET_PACKAGE_LIMITS_V1.maxImportedPetsPerAccount,
      { min: 1 },
    ),
    maxImportedPetBytesPerAccount: parseIntEnv(
      env[FEATURE_ENV_KEYS.petsSyncMaxImportedPetBytesPerAccount],
      PET_PACKAGE_LIMITS_V1.maxImportedPetBytesPerAccount,
      { min: 1 },
    ),
    encryptedCustomPetSyncPolicy: "disabled",
  };
}

export function readPeerMediationFeatureEnv(env: NodeJS.ProcessEnv): PeerMediationFeatureEnv {
  const signing = resolvePeerMediationGrantSigningConfig(env);
  if (!signing.ok) return { grantSigningKeys: [] };

  return {
    grantSigningKeys: [signing.capability],
  };
}

export function readSessionHandoffFeatureEnv(env: NodeJS.ProcessEnv): SessionHandoffFeatureEnv {
  return {
    handoffEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.sessionsHandoffEnabled], true),
  };
}

export function readSessionFoldersFeatureEnv(env: NodeJS.ProcessEnv): SessionFoldersFeatureEnv {
  return {
    foldersEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.sessionsFoldersEnabled], true),
  };
}

export function readSessionUsageLimitRecoveryFeatureEnv(env: NodeJS.ProcessEnv): SessionUsageLimitRecoveryFeatureEnv {
  return {
    enabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.sessionsUsageLimitRecoveryEnabled], true),
  };
}

export function readMachineTransferFeatureEnv(env: NodeJS.ProcessEnv): MachineTransferFeatureEnv {
  const configuredServerRoutedMaxBytes = normalizeMachineTransferServerRoutedMaxBytes(
    env[FEATURE_ENV_KEYS.machinesTransferServerRoutedMaxBytes] ?? env[MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY],
  );
  const resolvedServerRoutedMaxBytes = Math.min(
    configuredServerRoutedMaxBytes ?? DEFAULT_MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES,
    MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_HARD_MAX,
  );

  return {
    directPeerEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.machinesTransferDirectPeerEnabled], true),
    serverRoutedEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.machinesTransferServerRoutedEnabled], true),
    serverRoutedMaxBytes: resolvedServerRoutedMaxBytes,
    serverRoutedMaxActiveTransfersPerSocket: parseIntEnv(
      env[FEATURE_ENV_KEYS.machinesTransferServerRoutedMaxActiveTransfersPerSocket],
      128,
      { min: 1, max: 10_000 },
    ),
  };
}

export function readMachineTunnelFeatureEnv(env: NodeJS.ProcessEnv): MachineTunnelFeatureEnv {
  const serverRoutedSupportedEncodings = normalizeMachineTunnelSupportedEncodings(
    env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedSupportedEncodings],
  );
  return {
    directPeerEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.machinesTunnelDirectPeerEnabled], true),
    serverRoutedEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled], false),
    allowedPorts: parsePortList(env[FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]),
    maxIdleMs: normalizeMachineTunnelPositiveInt(
      env[FEATURE_ENV_KEYS.machinesTunnelMaxIdleMs],
      DEFAULT_MACHINE_TUNNEL_MAX_IDLE_MS,
    ),
    maxDurationMs: normalizeMachineTunnelPositiveInt(
      env[FEATURE_ENV_KEYS.machinesTunnelMaxDurationMs],
      DEFAULT_MACHINE_TUNNEL_MAX_DURATION_MS,
    ),
    serverRoutedMaxBytes: normalizeMachineTunnelPositiveInt(
      env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxBytes],
      DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES,
      { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX },
    ),
    serverRoutedMaxActiveTunnelsPerSocket: normalizeMachineTunnelPositiveInt(
      env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxActiveTunnelsPerSocket],
      DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET,
      { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET_HARD_MAX },
    ),
    serverRoutedMaxFrameBytes: normalizeMachineTunnelPositiveInt(
      env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxFrameBytes],
      DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES,
      { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX },
    ),
    serverRoutedSupportedEncodings,
    serverRoutedPreferredEncoding: normalizeMachineTunnelPreferredEncoding(
      env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedPreferredEncoding],
      serverRoutedSupportedEncodings,
    ),
    serverRoutedAllowV1Fallback: parseBooleanEnv(
      env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedAllowV1Fallback],
      DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_ALLOW_V1_FALLBACK,
    ),
    serverRoutedMaxBinaryHeaderBytes: normalizeMachineTunnelPositiveInt(
      env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxBinaryHeaderBytes],
      DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BINARY_HEADER_BYTES,
      { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX },
    ),
    serverRoutedMaxRawPayloadBytes: normalizeMachineTunnelPositiveInt(
      env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxRawPayloadBytes],
      DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES,
      { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX },
    ),
    serverRoutedMaxFramedMessageBytes: normalizeMachineTunnelPositiveInt(
      env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxFramedMessageBytes],
      DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAMED_MESSAGE_BYTES,
      { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX },
    ),
    serverRoutedSubstreams: {
      maxConcurrentSubstreams: normalizeMachineTunnelPositiveInt(
        env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxConcurrentSubstreams],
        DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_CONCURRENT_SUBSTREAMS,
        { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET_HARD_MAX },
      ),
      maxTotalSubstreams: normalizeMachineTunnelPositiveInt(
        env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxTotalSubstreams],
        DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_TOTAL_SUBSTREAMS,
        { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_SUBSTREAMS_HARD_MAX },
      ),
      maxBytesPerSubstream: normalizeMachineTunnelPositiveInt(
        env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxBytesPerSubstream],
        DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_PER_SUBSTREAM,
        { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX },
      ),
      maxAggregateBytes: normalizeMachineTunnelPositiveInt(
        env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxAggregateBytes],
        DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_AGGREGATE_BYTES,
        { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX },
      ),
      maxSubstreamIdleMs: normalizeMachineTunnelPositiveInt(
        env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxSubstreamIdleMs],
        DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_SUBSTREAM_IDLE_MS,
      ),
      maxSessionIdleMs: normalizeMachineTunnelPositiveInt(
        env[FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxSessionIdleMs],
        DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_SESSION_IDLE_MS,
      ),
    },
  };
}

export function readLocalServicesFeatureEnv(env: NodeJS.ProcessEnv): LocalServicesFeatureEnv {
  const previewEnabled = parseBooleanEnv(env[FEATURE_ENV_KEYS.localServicesPreviewEnabled], false);
  const publicPreviewEnabled = parseBooleanEnv(env[FEATURE_ENV_KEYS.localServicesPublicPreviewEnabled], false);

  return {
    inventoryEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.localServicesInventoryEnabled], previewEnabled),
    previewEnabled,
    previewTokenTtlMs: parseIntEnv(
      env[FEATURE_ENV_KEYS.localServicesPreviewTokenTtlMs],
      DEFAULT_LOCAL_SERVICE_PREVIEW_TOKEN_TTL_MS,
      { min: 1 },
    ),
    previewHostOriginBaseDomain: readTrimmedOptional(env[FEATURE_ENV_KEYS.localServicesPreviewHostOriginDomain]),
    publicPreviewEnabled,
    publicPolicy: {
      enabled: publicPreviewEnabled,
      allowedModes: parseLocalServicePublicExposureModes(env[FEATURE_ENV_KEYS.localServicesPublicPreviewAllowedModes]),
      maxTtlMs: readOptionalPositiveInt(env[FEATURE_ENV_KEYS.localServicesPublicPreviewMaxTtlMs]),
      maxConcurrentExposures: readOptionalPositiveInt(env[FEATURE_ENV_KEYS.localServicesPublicPreviewMaxConcurrentExposures]),
      dnsTlsRequired: parseBooleanEnv(env[FEATURE_ENV_KEYS.localServicesPublicPreviewDnsTlsRequired], true),
      auditRequired: parseBooleanEnv(env[FEATURE_ENV_KEYS.localServicesPublicPreviewAuditRequired], true),
      rateLimitProfileIds: parseCsvList(env[FEATURE_ENV_KEYS.localServicesPublicPreviewRateLimitProfileIds]),
    },
  };
}

export function readMachineRpcFeatureEnv(env: NodeJS.ProcessEnv): MachineRpcFeatureEnv {
  return {
    directPeerEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.machinesRpcDirectPeerEnabled], true),
  };
}

function parseOptionalPositiveIntFromEnv(env: NodeJS.ProcessEnv, key: string): number | null {
  const raw = env[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function readMachineLiveStreamFeatureEnv(env: NodeJS.ProcessEnv): MachineLiveStreamFeatureEnv {
  const serverRoutedRequested = parseBooleanEnv(env[FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedEnabled], false);
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
  const parsedCaps = MachineLiveStreamRelayCapsV1Schema.safeParse(capsCandidate);
  const serverRoutedCaps = serverRoutedRequested && parsedCaps.success ? parsedCaps.data : null;

  return {
    directPeerEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.machinesLiveStreamDirectPeerEnabled], true),
    serverRoutedEnabled: serverRoutedRequested && serverRoutedCaps !== null,
    serverRoutedCaps,
    serverRoutedDisabledReason: serverRoutedRequested ? 'relay_caps_missing' : 'relay_not_enabled',
  };
}

export function readTerminalFeatureEnv(env: NodeJS.ProcessEnv): TerminalFeatureEnv {
  return {
    embeddedPtyEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.terminalEmbeddedPtyEnabled], true),
  };
}

export function readSocialFriendsFeatureEnv(env: NodeJS.ProcessEnv): SocialFriendsFeatureEnv {
  const rawIdentityProvider =
    typeof env[FEATURE_ENV_KEYS.socialFriendsIdentityProvider] === 'string' && env[FEATURE_ENV_KEYS.socialFriendsIdentityProvider]?.trim()
      ? env[FEATURE_ENV_KEYS.socialFriendsIdentityProvider]!.trim()
      : 'github';

  return {
    enabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.socialFriendsEnabled], true),
    allowUsername: parseBooleanEnv(env[FEATURE_ENV_KEYS.socialFriendsAllowUsername], true),
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
      true,
    ),
    loginKeyChallengeEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.authLoginKeyChallengeEnabled], true),
    pairingDesktopQrMobileScanEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.authPairingDesktopQrMobileScanEnabled], true),
    uiAutoRedirectEnabled: parseBooleanEnv(
      env[FEATURE_ENV_KEYS.authUiAutoRedirectEnabled] ?? legacyUiAutoRedirectEnabled,
      false,
    ),
    uiAutoRedirectProviderId: (
      env[FEATURE_ENV_KEYS.authUiAutoRedirectProviderId] ?? legacyUiAutoRedirectProviderId ?? ''
    )
      .trim()
      .toLowerCase(),
    uiRecoveryKeyReminderEnabled: parseBooleanEnv(
      env[FEATURE_ENV_KEYS.authUiRecoveryKeyReminderEnabled] ?? legacyUiRecoveryKeyReminderEnabled,
      true,
    ),
  };
}

export function readAuthMtlsFeatureEnv(env: NodeJS.ProcessEnv): AuthMtlsFeatureEnv {
  const enabled = parseBooleanEnv(env[FEATURE_ENV_KEYS.authMtlsEnabled], false);
  const rawMode = (env[FEATURE_ENV_KEYS.authMtlsMode] ?? "").toString().trim().toLowerCase();
  const mode: AuthMtlsFeatureEnv["mode"] = rawMode === "direct" ? "direct" : "forwarded";

  const autoProvision = parseBooleanEnv(env[FEATURE_ENV_KEYS.authMtlsAutoProvision], false);
  const trustForwardedHeaders = parseBooleanEnv(env[FEATURE_ENV_KEYS.authMtlsTrustForwardedHeaders], false);

  const rawIdentitySource = (env[FEATURE_ENV_KEYS.authMtlsIdentitySource] ?? "").toString().trim().toLowerCase();
  const identitySource: AuthMtlsFeatureEnv["identitySource"] =
    rawIdentitySource === "san_upn" || rawIdentitySource === "subject_cn" || rawIdentitySource === "fingerprint" || rawIdentitySource === "san_email"
      ? (rawIdentitySource as AuthMtlsFeatureEnv["identitySource"])
      : "san_email";

  const allowedEmailDomains = Object.freeze(parseCsvList(env[FEATURE_ENV_KEYS.authMtlsAllowedEmailDomains]).map((s) => s.toLowerCase()));
  const allowedIssuers = Object.freeze(parseIssuerAllowlist(env[FEATURE_ENV_KEYS.authMtlsAllowedIssuers]).map(normalizeAuthMtlsIssuerValue).filter(Boolean));

  const forwardedEmailHeader = (env[FEATURE_ENV_KEYS.authMtlsForwardedEmailHeader] ?? "x-happier-client-cert-email")
    .toString()
    .trim()
    .toLowerCase();
  const forwardedUpnHeader = (env[FEATURE_ENV_KEYS.authMtlsForwardedUpnHeader] ?? "x-happier-client-cert-upn")
    .toString()
    .trim()
    .toLowerCase();
  const forwardedSubjectHeader = (env[FEATURE_ENV_KEYS.authMtlsForwardedSubjectHeader] ?? "x-happier-client-cert-subject")
    .toString()
    .trim()
    .toLowerCase();
  const forwardedFingerprintHeader = (env[FEATURE_ENV_KEYS.authMtlsForwardedFingerprintHeader] ?? "x-happier-client-cert-sha256")
    .toString()
    .trim()
    .toLowerCase();
  const forwardedIssuerHeader = (env[FEATURE_ENV_KEYS.authMtlsForwardedIssuerHeader] ?? "x-happier-client-cert-issuer")
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

  const claimTtlSeconds = parseIntEnv(env[FEATURE_ENV_KEYS.authMtlsClaimTtlSeconds], 60, { min: 10, max: 3600 });

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
  const enabled = parseBooleanEnv(env[FEATURE_ENV_KEYS.authOauthKeylessEnabled], false);
  const providers = Object.freeze(parseCsvList(env[FEATURE_ENV_KEYS.authOauthKeylessProviders]).map((s) => s.toLowerCase()));
  const autoProvision = parseBooleanEnv(env[FEATURE_ENV_KEYS.authOauthKeylessAutoProvision], false);
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
      : "required_e2ee";

  const allowAccountOptOut = parseBooleanEnv(env[FEATURE_ENV_KEYS.encryptionAllowAccountOptOut], false);
  const rawDefaultAccountMode = (env[FEATURE_ENV_KEYS.encryptionDefaultAccountMode] ?? "").toString().trim();
  const defaultAccountMode: EncryptionFeatureEnv["defaultAccountMode"] =
    rawDefaultAccountMode === "plain" || rawDefaultAccountMode === "e2ee" ? rawDefaultAccountMode : "e2ee";

  const rawSettingsAtRest = (env[FEATURE_ENV_KEYS.encryptionPlainAccountSettingsAtRest] ?? "").toString().trim().toLowerCase();
  const plainAccountSettingsAtRest: EncryptionFeatureEnv["plainAccountSettingsAtRest"] =
    rawSettingsAtRest === "none" || rawSettingsAtRest === "server_sealed" ? (rawSettingsAtRest as any) : "server_sealed";

  const rawCredentialsAtRest = (env[FEATURE_ENV_KEYS.encryptionPlainAccountCredentialsAtRest] ?? "").toString().trim().toLowerCase();
  const plainAccountCredentialsAtRest: EncryptionFeatureEnv["plainAccountCredentialsAtRest"] =
    rawCredentialsAtRest === "none" || rawCredentialsAtRest === "server_sealed" ? (rawCredentialsAtRest as any) : "server_sealed";

  return {
    storagePolicy,
    allowAccountOptOut,
    defaultAccountMode,
    plainAccountSettingsAtRest,
    plainAccountCredentialsAtRest,
  };
}

export function readE2eeFeatureEnv(env: NodeJS.ProcessEnv): E2eeFeatureEnv {
  return {
    keylessAccountsEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.e2eeKeylessAccountsEnabled], false),
  };
}
