import { isCanonicalProviderSavedSecretIdV1 } from '@happier-dev/protocol/providers/settings/v1';
import { listSecretReferenceOverlayV1BindingNames, readSecretReferenceOverlayV1Reference } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { AIBackendProfile, LaunchProfileV2, AiLaunchProfileSourceV1, SecretReferenceOverlayV1 } from '@happier-dev/protocol';

import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import {
  createSavedSecretMaterializerV1,
  type SavedSecretCatalogResourceInputV1,
} from '@/settings/secrets/savedSecretCatalog';
import type { SavedSecretOperationAdmissionFailureReason } from '@/settings/secrets/hydrateSavedSecretCatalog';

export class ForegroundProfileSecretRecoveryRequiredError extends Error {
  readonly requirementNames: readonly string[];

  constructor(requirementNames: readonly string[]) {
    super('Foreground Profile saved-secret recovery requires new foreground input');
    this.name = 'ForegroundProfileSecretRecoveryRequiredError';
    this.requirementNames = Object.freeze([...requirementNames]);
  }
}

/**
 * Why the one-shot overlay fails, stated so the launch owner can map it onto
 * the incumbent Provider error vocabulary instead of inventing a second one.
 */
export type LaunchSecretReferenceOverlayFailureReasonV1 =
  | 'undeclared_requirement'
  | 'reference_missing'
  | 'reference_unavailable'
  | 'reference_stale'
  | 'reference_collision_migration_required';

export class LaunchSecretReferenceOverlayError extends Error {
  readonly reason: LaunchSecretReferenceOverlayFailureReasonV1;
  readonly requirementName: string;

  constructor(
    reason: LaunchSecretReferenceOverlayFailureReasonV1,
    requirementName: string,
  ) {
    super(`Launch Saved Secret reference overlay is unusable for ${requirementName}`);
    this.name = 'LaunchSecretReferenceOverlayError';
    this.reason = reason;
    this.requirementName = requirementName;
  }
}

export function readLaunchSecretReferenceOverlayProviderErrorCodeV1(
  reason: LaunchSecretReferenceOverlayFailureReasonV1 | SavedSecretOperationAdmissionFailureReason,
): 'provider_settings_invalid' | 'provider_secret_missing'
  | 'provider_secret_unavailable' | 'provider_binding_changed' {
  switch (reason) {
    case 'undeclared_requirement':
      return 'provider_settings_invalid';
    // Operation admission names why a reference is unusable; launch still
    // refuses every non-transient, non-binding case as a missing secret.
    case 'reference_missing':
    case 'reference_forbidden':
    case 'reference_deleted':
    case 'reference_mode_incompatible':
    case 'reference_repair_required':
    case 'reference_corrupt':
      return 'provider_secret_missing';
    case 'reference_unavailable':
      return 'provider_secret_unavailable';
    case 'reference_stale':
    case 'reference_collision_migration_required':
      return 'provider_binding_changed';
  }
}

function listDeclaredSecretRequirements(
  profile: AIBackendProfile | LaunchProfileV2,
): readonly Readonly<{ name: string; required: boolean }>[] {
  return (profile.envVarRequirements ?? [])
    .filter((requirement) => (requirement.kind ?? 'secret') === 'secret')
    .map((requirement) => Object.freeze({
      name: requirement.name,
      required: requirement.required === true,
    }));
}

function materializeSavedSecretReferenceBinding(params: Readonly<{
  requirementName: string;
  binding: Readonly<{ ref: string; revision?: number }>;
  materializer: ReturnType<typeof createSavedSecretMaterializerV1>;
  exactReference: boolean;
}>): string | null {
  if (
    params.exactReference
    && params.binding.revision === undefined
    && parseSavedSecretRefV1(params.binding.ref).kind === 'shared_resource'
  ) {
    throw new LaunchSecretReferenceOverlayError('reference_stale', params.requirementName);
  }
  if (
    params.exactReference
    && params.binding.revision !== undefined
    && !params.materializer.matchesSharedResourceRevision(
      params.binding.ref,
      params.binding.revision,
    )
  ) {
    throw new LaunchSecretReferenceOverlayError('reference_stale', params.requirementName);
  }
  const resolved = params.materializer.resolve(params.binding.ref);
  if (resolved.status === 'ready' && resolved.value.length > 0) {
    return resolved.value;
  }
  if (params.exactReference) {
    throw new LaunchSecretReferenceOverlayError(
      resolved.status === 'temporarily_unavailable'
        ? 'reference_unavailable'
        : 'reference_missing',
      params.requirementName,
    );
  }
  return null;
}

/** Materializes an Execution Run's direct, value-free one-launch bindings. */
export function resolveSecretReferenceOverlayEnvironment(params: Readonly<{
  accountSettings: Readonly<Record<string, unknown>>;
  settingsSecretsReadKeys: readonly Uint8Array[];
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
  secretReferenceOverlay: SecretReferenceOverlayV1;
}>): Readonly<Record<string, string>> {
  const materializer = createSavedSecretMaterializerV1({
    accountSettings: params.accountSettings,
    settingsSecretsReadKeys: params.settingsSecretsReadKeys,
    ...(params.savedSecretResources ? { resources: params.savedSecretResources } : {}),
  });
  const environment: Record<string, string> = Object.create(null);
  for (const requirementName of listSecretReferenceOverlayV1BindingNames(params.secretReferenceOverlay)) {
    const binding = readSecretReferenceOverlayV1Reference(
      params.secretReferenceOverlay,
      requirementName,
    )!;
    environment[requirementName] = materializeSavedSecretReferenceBinding({
      requirementName,
      binding,
      materializer,
      exactReference: true,
    })!;
  }
  return Object.freeze(environment);
}

/**
 * The one merge for a launch's effective Saved Secret bindings. The optional
 * one-shot overlay overrides the persisted Profile binding for the exact
 * requirements it names and for this launch only; every other requirement
 * keeps its Profile/default binding. Nothing here writes a Profile.
 */
export function resolveEffectiveLaunchProfileSecretBindings(
  params: Readonly<{
    profile: (AIBackendProfile | LaunchProfileV2) & AiLaunchProfileSourceV1;
    accountSettings: Readonly<Record<string, unknown>>;
    secretReferenceOverlay?: SecretReferenceOverlayV1 | undefined;
  }>,
): Readonly<Record<string, Readonly<{ ref: string; revision?: number }>>> {
  const { secretBindingsByProfileId } =
    readProfilesFromAccountSettings(params.accountSettings);
  const profileBindings = { ...params.profile.secretBindings, ...secretBindingsByProfileId[params.profile.id] };
  const declared = listDeclaredSecretRequirements(params.profile);
  const declaredNames = new Set(declared.map((requirement) => requirement.name));

  const effective: Record<string, Readonly<{ ref: string; revision?: number }>> =
    Object.create(null);
  for (const requirement of declared) {
    const persisted = profileBindings[requirement.name];
    if (isCanonicalProviderSavedSecretIdV1(persisted)) {
      effective[requirement.name] = Object.freeze({ ref: persisted });
    }
  }

  const overlay = params.secretReferenceOverlay;
  if (!overlay) return Object.freeze(effective);

  for (const name of listSecretReferenceOverlayV1BindingNames(overlay)) {
    if (!declaredNames.has(name)) {
      // A one-shot override for something this Profile does not declare as a
      // secret requirement is a stale or wrong launch composition. Silently
      // dropping it would launch with different credentials than the caller
      // chose, so it fails closed before any materialization.
      throw new LaunchSecretReferenceOverlayError('undeclared_requirement', name);
    }
    const reference = readSecretReferenceOverlayV1Reference(overlay, name)!;
    effective[name] = Object.freeze(
      reference.revision === undefined
        ? { ref: reference.ref }
        : { ref: reference.ref, revision: reference.revision },
    );
  }
  return Object.freeze(effective);
}

export function readForegroundProfileRequiredSecretNamesMissingBinding(
  params: Readonly<{
    profile: AIBackendProfile | LaunchProfileV2;
    accountSettings: Readonly<Record<string, unknown>>;
    secretReferenceOverlay?: SecretReferenceOverlayV1 | undefined;
  }>,
): readonly string[] {
  const effective = resolveEffectiveLaunchProfileSecretBindings(params);
  return Object.freeze(
    listDeclaredSecretRequirements(params.profile)
      .filter((requirement) => (
        requirement.required
        && !Object.prototype.hasOwnProperty.call(effective, requirement.name)
      ))
      .map((requirement) => requirement.name),
  );
}

export function resolveLaunchProfileSavedSecretEnvironment(
  params: Readonly<{
    profile: AIBackendProfile | LaunchProfileV2;
    accountSettings: Readonly<Record<string, unknown>>;
    settingsSecretsReadKeys: readonly Uint8Array[];
    foregroundSatisfiedSecretRequirementNames: readonly string[];
    savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
    secretReferenceOverlay?: SecretReferenceOverlayV1 | undefined;
    /** Foreground admission alone needs to prompt for an unbound required secret. */
    requireEveryRequiredBinding?: boolean;
  }>,
): Readonly<Record<string, string>> {
  const secretRequirements = listDeclaredSecretRequirements(params.profile);
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
  const effectiveBindings = resolveEffectiveLaunchProfileSecretBindings(params);
  const overlayNames = new Set(
    params.secretReferenceOverlay
      ? listSecretReferenceOverlayV1BindingNames(params.secretReferenceOverlay)
      : [],
  );
  const materializer = createSavedSecretMaterializerV1({
    accountSettings: params.accountSettings,
    settingsSecretsReadKeys: params.settingsSecretsReadKeys,
    ...(params.savedSecretResources
      ? { resources: params.savedSecretResources }
      : {}),
  });
  const overlay: Record<string, string> = {};
  const recoveryRequirementNames: string[] = [];

  for (const requirement of secretRequirements) {
    if (foregroundNames.has(requirement.name)) {
      continue;
    }
    const binding = effectiveBindings[requirement.name];
    if (!binding) continue;
    const isOverlayBinding = overlayNames.has(requirement.name);
    const resolvedValue = materializeSavedSecretReferenceBinding({
      requirementName: requirement.name,
      binding,
      materializer,
      exactReference: isOverlayBinding,
    });
    if (resolvedValue !== null) {
      overlay[requirement.name] = resolvedValue;
      continue;
    }
    if (requirement.required && params.requireEveryRequiredBinding === true) {
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

export function resolveForegroundProfileSavedSecretEnvironment(
  params: Readonly<{
    profile: AIBackendProfile | LaunchProfileV2;
    accountSettings: Readonly<Record<string, unknown>>;
    settingsSecretsReadKeys: readonly Uint8Array[];
    foregroundSatisfiedSecretRequirementNames: readonly string[];
    savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
    secretReferenceOverlay?: SecretReferenceOverlayV1 | undefined;
  }>,
): Readonly<Record<string, string>> {
  return resolveLaunchProfileSavedSecretEnvironment({
    ...params,
    requireEveryRequiredBinding: true,
  });
}
