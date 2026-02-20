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

export type EncryptionFeatureEnv = Readonly<{
  storagePolicy: "required_e2ee" | "optional" | "plaintext_only";
  allowAccountOptOut: boolean;
  defaultAccountMode: "e2ee" | "plain";
}>;

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
