import type { SecretReferenceOverlayV1 } from '@happier-dev/protocol';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import type { StoredCredentials } from '@/persistence';
import { readForegroundProfileRequiredSecretNamesMissingBinding, resolveEffectiveLaunchProfileSecretBindings, resolveForegroundProfileSavedSecretEnvironment } from '@/daemon/agentRuntime/resolveForegroundProfileSavedSecretEnvironment';
import { readSavedSecretMaterializerForOperation } from '@/settings/secrets/savedSecretCatalogRead';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import {
  buildProfileEnvOverlay,
  expandProfileEnvOverlay,
} from '@/settings/profiles/buildProfileEnvOverlay';
import { readAccountLaunchProfiles } from '@/settings/profiles/readProfilesFromAccountSettings';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';

export type ProfileProbeEnvironment = Readonly<{
  cacheKey: string;
  env: Readonly<Record<string, string>>;
}>;

export async function resolveProfileProbeEnvironment(params: Readonly<{
  agentId: CatalogAgentLookupId;
  profileId?: unknown;
  secretReferenceOverlay?: SecretReferenceOverlayV1;
  accountSettings: Readonly<Record<string, unknown>> | null;
  profileCatalog?: ProfileCatalogSnapshotV1;
  credentials: StoredCredentials | null;
  savedSecretOperationContext?: import('@/settings/secrets/savedSecretOperationContext').SavedSecretOperationContextV1;
  machineAdmission?: import('@/settings/secrets/savedSecretOperationContext').SavedSecretOperationContextV1['machineAdmission'];
  secretSources?: import('@/plugins/runtime/lifecycle/contributions/targetSecretSources').TargetSecretSourcesV1;
  signal?: AbortSignal;
  processEnv: NodeJS.ProcessEnv;
}>): Promise<ProfileProbeEnvironment | null> {
  const profileId = typeof params.profileId === 'string' ? params.profileId.trim() : '';
  if (!profileId) return null;
  if (!params.accountSettings || !params.credentials) {
    throw new Error('The selected profile cannot be resolved for this preflight probe');
  }

  const profileSnapshot = await readAccountLaunchProfiles(params.accountSettings, params.credentials, undefined, params.profileCatalog);
  const profile = profileSnapshot.visibleProfiles.find((candidate) => candidate.id === profileId);
  if (!profile || profile.enabled === false) {
    throw new Error(`Profile "${profileId}" is unavailable for this preflight probe`);
  }
  const requiredSecretRequirementNamesMissingBinding = new Set(
    readForegroundProfileRequiredSecretNamesMissingBinding({
      profile, accountSettings: params.accountSettings,
      secretReferenceOverlay: params.secretReferenceOverlay,
    }),
  );
  const overlay = await buildProfileEnvOverlay({
    agentId: params.agentId,
    profile,
    processEnv: params.processEnv,
    promptSecretFn: null,
    reservedEnvironmentVariableNames: new Set(),
    requiredSecretRequirementNamesMissingBinding,
  });
  const bindings = resolveEffectiveLaunchProfileSecretBindings({ profile, accountSettings: params.accountSettings,
    secretReferenceOverlay: params.secretReferenceOverlay });
  const references = Object.entries(bindings).filter(([name]) => !overlay.foregroundSatisfiedSecretRequirementNames.includes(name))
    .map(([, binding]) => binding);
  const admitted = references.length > 0 ? await readSavedSecretMaterializerForOperation({
    expectedScopeKey: resolveAccountSettingsScopeKey(params.credentials), references,
    operationContext: params.savedSecretOperationContext, secretSources: params.secretSources, signal: params.signal,
    machineAdmission: params.machineAdmission,
  }) : null;
  const savedSecretEnvironment = resolveForegroundProfileSavedSecretEnvironment({
    profile,
    accountSettings: params.accountSettings,
    settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(params.credentials),
    foregroundSatisfiedSecretRequirementNames: overlay.foregroundSatisfiedSecretRequirementNames,
    secretReferenceOverlay: params.secretReferenceOverlay,
    ...(admitted ? { savedSecretMaterializer: admitted.materializer } : {}),
  });
  const expandedOverlay = expandProfileEnvOverlay({
    profile,
    envOverlayRaw: overlay.envOverlayRaw,
    processEnv: params.processEnv,
    resolvedEnvironment: savedSecretEnvironment,
  });

  return Object.freeze({
    cacheKey: profile.id,
    env: Object.freeze({
      ...expandedOverlay,
      ...savedSecretEnvironment,
      HAPPIER_SESSION_PROFILE_ID: profile.id,
    }),
  });
}
