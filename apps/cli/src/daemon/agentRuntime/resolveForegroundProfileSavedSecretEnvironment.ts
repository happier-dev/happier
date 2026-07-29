import {
  decryptSecretValueWithKeysV1,
  isCanonicalProviderSavedSecretIdV1,
  type AIBackendProfile,
  type LaunchProfileV2,
} from '@happier-dev/protocol';

import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import { indexSavedSecretsByIdFromAccountSettings } from '@/settings/secrets/indexSavedSecretsById';

export class ForegroundProfileSecretRecoveryRequiredError extends Error {
  readonly requirementNames: readonly string[];

  constructor(requirementNames: readonly string[]) {
    super('Foreground Profile saved-secret recovery requires new foreground input');
    this.name = 'ForegroundProfileSecretRecoveryRequiredError';
    this.requirementNames = Object.freeze([...requirementNames]);
  }
}

export function readForegroundProfileRequiredSecretNamesMissingBinding(
  params: Readonly<{
    profile: AIBackendProfile | LaunchProfileV2;
    accountSettings: Readonly<Record<string, unknown>>;
  }>,
): readonly string[] {
  const { secretBindingsByProfileId } =
    readProfilesFromAccountSettings(params.accountSettings);
  const bindings = secretBindingsByProfileId[params.profile.id] ?? {};
  return Object.freeze(
    (params.profile.envVarRequirements ?? [])
      .filter((requirement) =>
        (requirement.kind ?? 'secret') === 'secret'
        && requirement.required === true
        && (
          !isCanonicalProviderSavedSecretIdV1(
            bindings[requirement.name],
          )
        )
      )
      .map((requirement) => requirement.name),
  );
}

export function resolveForegroundProfileSavedSecretEnvironment(
  params: Readonly<{
    profile: AIBackendProfile | LaunchProfileV2;
    accountSettings: Readonly<Record<string, unknown>>;
    settingsSecretsReadKeys: readonly Uint8Array[];
    foregroundSatisfiedSecretRequirementNames: readonly string[];
  }>,
): Readonly<Record<string, string>> {
  const secretRequirements = (params.profile.envVarRequirements ?? [])
    .filter((requirement) =>
      (requirement.kind ?? 'secret') === 'secret'
    );
  const secretRequirementNames = new Set(
    secretRequirements.map((requirement) => requirement.name),
  );
  const foregroundNames = new Set(
    params.foregroundSatisfiedSecretRequirementNames,
  );
  if (
    foregroundNames.size
      !== params.foregroundSatisfiedSecretRequirementNames.length
    || [...foregroundNames].some((name) => !secretRequirementNames.has(name))
  ) {
    throw new Error(
      'Foreground Profile secret satisfaction must contain unique canonical requirement names',
    );
  }
  const { secretBindingsByProfileId } =
    readProfilesFromAccountSettings(params.accountSettings);
  const savedSecretsById =
    indexSavedSecretsByIdFromAccountSettings(params.accountSettings);
  const overlay: Record<string, string> = {};
  const recoveryRequirementNames: string[] = [];

  for (const requirement of secretRequirements) {
    if (foregroundNames.has(requirement.name)) {
      continue;
    }
    const secretId =
      secretBindingsByProfileId[params.profile.id]?.[requirement.name];
    if (!secretId) continue;
    const plaintext = decryptSecretValueWithKeysV1(
      savedSecretsById.get(secretId) ?? null,
      params.settingsSecretsReadKeys,
    );
    if (typeof plaintext === 'string' && plaintext.trim().length > 0) {
      overlay[requirement.name] = plaintext.trim();
      continue;
    }
    if (requirement.required === true) {
      recoveryRequirementNames.push(requirement.name);
    }
  }

  if (recoveryRequirementNames.length > 0) {
    throw new ForegroundProfileSecretRecoveryRequiredError(
      recoveryRequirementNames,
    );
  }

  return Object.freeze(overlay);
}
