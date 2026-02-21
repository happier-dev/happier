import { parseBooleanEnv, parseIntEnv } from '@/config/env';
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
}>;

export type UpdatesFeatureEnv = Readonly<{
  otaEnabled: boolean;
}>;

export type AttachmentsUploadsFeatureEnv = Readonly<{
  enabled: boolean;
}>;

export type SocialFriendsFeatureEnv = Readonly<{
  enabled: boolean;
  allowUsername: boolean;
  identityProvider: string;
}>;

export type AuthFeatureEnv = Readonly<{
  recoveryProviderResetEnabled: boolean;
  loginKeyChallengeEnabled: boolean;
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
    quotasEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.connectedServicesQuotasEnabled], false),
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
  return {
    recoveryProviderResetEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.authRecoveryProviderResetEnabled], true),
    loginKeyChallengeEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.authLoginKeyChallengeEnabled], true),
    uiAutoRedirectEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.authUiAutoRedirectEnabled], false),
    uiAutoRedirectProviderId: (env[FEATURE_ENV_KEYS.authUiAutoRedirectProviderId] ?? '').trim().toLowerCase(),
    uiRecoveryKeyReminderEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.authUiRecoveryKeyReminderEnabled], true),
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
  const webUrl = (env.HAPPIER_WEBAPP_URL ?? env.HAPPY_WEBAPP_URL ?? "https://app.happier.dev").toString().trim();
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

  return {
    storagePolicy,
    allowAccountOptOut,
    defaultAccountMode,
  };
}

export function readE2eeFeatureEnv(env: NodeJS.ProcessEnv): E2eeFeatureEnv {
  return {
    keylessAccountsEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.e2eeKeylessAccountsEnabled], true),
  };
}
