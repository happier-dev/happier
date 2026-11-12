import type { SecretReferenceOverlayV1 } from '@happier-dev/protocol';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import type { StoredCredentials } from '@/persistence';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
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

export type PreparedProfileProbeEnvironment = ProfileProbeEnvironment & Readonly<{
  materialize(signal?: AbortSignal): Promise<ProfileProbeEnvironment>;
}>;

export async function prepareProfileProbeEnvironment(params: Readonly<{
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
}>): Promise<PreparedProfileProbeEnvironment | null> {
  const profileId = typeof params.profileId === 'string' ? params.profileId.trim() : '';
  if (!profileId) return null;
  const { accountSettings, credentials } = params;
  if (!accountSettings || !credentials) {
    throw new Error('The selected profile cannot be resolved for this preflight probe');
  }

  const profileSnapshot = await readAccountLaunchProfiles(accountSettings, credentials, undefined, params.profileCatalog);
  const profile = profileSnapshot.visibleProfiles.find((candidate) => candidate.id === profileId);
  if (!profile || profile.enabled === false) {
    throw new Error(`Profile "${profileId}" is unavailable for this preflight probe`);
  }
  const requiredSecretRequirementNamesMissingBinding = new Set(
    readForegroundProfileRequiredSecretNamesMissingBinding({
      profile, accountSettings: accountSettings,
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
  const bindings = resolveEffectiveLaunchProfileSecretBindings({ profile, accountSettings: accountSettings,
    secretReferenceOverlay: params.secretReferenceOverlay });
  const references = Object.entries(bindings).filter(([name]) => !overlay.foregroundSatisfiedSecretRequirementNames.includes(name))
    .map(([, binding]) => binding);
  const materialize = async (signal?: AbortSignal): Promise<ProfileProbeEnvironment> => {
    const acquisitionSignal = params.signal && signal ? AbortSignal.any([params.signal, signal]) : params.signal ?? signal;
    acquisitionSignal?.throwIfAborted();
    const admitted = references.length > 0 ? await readSavedSecretMaterializerForOperation({
      expectedScopeKey: resolveAccountSettingsScopeKey(credentials), references,
      operationContext: params.savedSecretOperationContext, secretSources: params.secretSources, signal: acquisitionSignal,
      machineAdmission: params.machineAdmission,
    }) : null;
    const savedSecretEnvironment = resolveForegroundProfileSavedSecretEnvironment({
      profile,
      accountSettings: accountSettings,
      settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(credentials),
      foregroundSatisfiedSecretRequirementNames: overlay.foregroundSatisfiedSecretRequirementNames,
      secretReferenceOverlay: params.secretReferenceOverlay,
      savedSecretMaterializer: admitted?.materializer ?? null,
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
  };

  // Probe routing consumes deliberate Profile configuration before a plugin decides
  // whether it needs native work. Secret references remain unresolved until then.
  const routingEnvironment = expandEnvironmentVariables(
    overlay.envOverlayRaw,
    { ...params.processEnv, ...overlay.envOverlayRaw },
    { warnOnUndefined: false },
  );
  let materialization: Promise<ProfileProbeEnvironment> | undefined;
  return Object.freeze({
    cacheKey: profile.id,
    env: Object.freeze({ ...routingEnvironment, HAPPIER_SESSION_PROFILE_ID: profile.id }),
    materialize: (signal?: AbortSignal) => materialization ??= materialize(signal),
  });
}

export async function resolveProfileProbeEnvironment(
  params: Parameters<typeof prepareProfileProbeEnvironment>[0],
): Promise<ProfileProbeEnvironment | null> {
  const prepared = await prepareProfileProbeEnvironment(params);
  return prepared ? await prepared.materialize() : null;
}
