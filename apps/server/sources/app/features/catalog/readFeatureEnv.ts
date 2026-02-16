import { parseBooleanEnv, parseIntEnv } from '@/config/env';
import { FEATURE_ENV_KEYS } from './featureEnvSchema';

export type AutomationsFeatureEnv = Readonly<{
  enabled: boolean;
  existingSessionTarget: boolean;
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

export type SocialFriendsFeatureEnv = Readonly<{
  enabled: boolean;
  allowUsername: boolean;
  identityProvider: string;
}>;

export type AuthFeatureEnv = Readonly<{
  recoveryProviderResetEnabled: boolean;
  uiAutoRedirectEnabled: boolean;
  uiAutoRedirectProviderId: string;
  uiRecoveryKeyReminderEnabled: boolean;
}>;

export function readAutomationsFeatureEnv(env: NodeJS.ProcessEnv): AutomationsFeatureEnv {
  return {
    enabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.automationsEnabled], true),
    existingSessionTarget: parseBooleanEnv(env[FEATURE_ENV_KEYS.automationsExistingSessionTarget], false),
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
  };
}

export function readUpdatesFeatureEnv(env: NodeJS.ProcessEnv): UpdatesFeatureEnv {
  return {
    otaEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.updatesOtaEnabled], true),
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
    uiAutoRedirectEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.authUiAutoRedirectEnabled], false),
    uiAutoRedirectProviderId: (env[FEATURE_ENV_KEYS.authUiAutoRedirectProviderId] ?? '').trim().toLowerCase(),
    uiRecoveryKeyReminderEnabled: parseBooleanEnv(env[FEATURE_ENV_KEYS.authUiRecoveryKeyReminderEnabled], true),
  };
}
