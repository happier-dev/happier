import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { ProviderErrorV1 } from '@happier-dev/protocol';
import { listSecretReferenceOverlayV1BindingNames, readSecretReferenceOverlayV1Reference } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import type { SecretReferenceOverlayV1 } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { EnvVarRequirement } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { savedSecretOperationAdmissionReason, type SavedSecretCatalogResourceInputV1, type SavedSecretMaterializerV1, type SavedSecretOperationAdmissionFailureReason } from './savedSecretCatalog';

export type LaunchSecretReferenceOverlayFailureReasonV1 = 'undeclared_requirement' | SavedSecretOperationAdmissionFailureReason;

export class LaunchSecretReferenceOverlayError extends Error {
  constructor(readonly reason: LaunchSecretReferenceOverlayFailureReasonV1, readonly requirementName: string) {
    super(`Launch Saved Secret reference overlay is unusable for ${requirementName}`);
    this.name = 'LaunchSecretReferenceOverlayError';
  }
}

export function readLaunchSecretReferenceOverlayProviderErrorCodeV1(
  reason: LaunchSecretReferenceOverlayFailureReasonV1 | SavedSecretOperationAdmissionFailureReason,
): 'provider_settings_invalid' | 'provider_secret_missing' | 'provider_secret_unavailable' | 'provider_binding_changed' {
  switch (reason) {
    case 'undeclared_requirement': return 'provider_settings_invalid';
    case 'reference_missing': case 'reference_forbidden': case 'reference_deleted':
    case 'reference_mode_incompatible': case 'reference_repair_required': case 'reference_corrupt':
      return 'provider_secret_missing';
    case 'reference_unavailable': return 'provider_secret_unavailable';
    case 'reference_stale': case 'reference_collision_migration_required': return 'provider_binding_changed';
  }
}

/** Shared exact-reference behavior; Profile default/recovery policy stays in its owner. */
export function materializeSavedSecretReferenceBinding(params: Readonly<{
  requirementName: string;
  binding: Readonly<{ ref: string; revision?: number }>;
  materializer: SavedSecretMaterializerV1;
  exactReference: boolean;
  required?: boolean;
}>): string | null {
  if (params.exactReference && params.binding.revision === undefined
    && parseSavedSecretRefV1(params.binding.ref).kind === 'shared_resource') {
    throw new LaunchSecretReferenceOverlayError('reference_stale', params.requirementName);
  }
  if (params.exactReference && params.binding.revision !== undefined
    && !params.materializer.matchesSharedResourceRevision(params.binding.ref, params.binding.revision)) {
    throw new LaunchSecretReferenceOverlayError('reference_stale', params.requirementName);
  }
  const resolved = params.materializer.resolve(params.binding.ref);
  if (resolved.status === 'ready' && resolved.value.length > 0) return resolved.value;
  if (params.exactReference || params.required) {
    throw new LaunchSecretReferenceOverlayError(
      resolved.status === 'ready' ? 'reference_missing' : savedSecretOperationAdmissionReason(resolved.status),
      params.requirementName,
    );
  }
  return null;
}

export type SecretReferenceOverlayEnvironmentInput = Readonly<{
  accountSettings: Readonly<Record<string, unknown>>;
  settingsSecretsReadKeys: readonly Uint8Array[];
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
  savedSecretMaterializer: SavedSecretMaterializerV1 | null;
  secretReferenceOverlay: SecretReferenceOverlayV1;
}>;

/** Generic value-free one-launch binding owner; it imports no Profile/network reader. */
export function resolveSecretReferenceOverlayEnvironment(params: SecretReferenceOverlayEnvironmentInput): Readonly<Record<string, string>> {
  const materializer = params.savedSecretMaterializer;
  const environment: Record<string, string> = Object.create(null);
  for (const requirementName of listSecretReferenceOverlayV1BindingNames(params.secretReferenceOverlay)) {
    if (!materializer) throw new LaunchSecretReferenceOverlayError('reference_unavailable', requirementName);
    const binding = readSecretReferenceOverlayV1Reference(params.secretReferenceOverlay, requirementName)!;
    environment[requirementName] = materializeSavedSecretReferenceBinding({ requirementName, binding, materializer, exactReference: true })!;
  }
  return Object.freeze(environment);
}

export type ProjectSecretReferenceEnvironmentInput = Omit<SecretReferenceOverlayEnvironmentInput, 'secretReferenceOverlay'> & Readonly<{
  requirements: readonly (Pick<EnvVarRequirement, 'name'> & Partial<Pick<EnvVarRequirement, 'kind' | 'required'>>)[];
  secretReferenceOverlay?: SecretReferenceOverlayV1;
}>;

/** Project requirement policy over the same exact body used by Runs and Profiles. */
export function resolveProjectSecretReferenceEnvironment(params: ProjectSecretReferenceEnvironmentInput): Readonly<Record<string, string>> {
  const requirements = params.requirements.filter(requirement => (requirement.kind ?? 'secret') === 'secret');
  const declared = new Set(requirements.map(requirement => requirement.name));
  if (params.secretReferenceOverlay) {
    for (const name of listSecretReferenceOverlayV1BindingNames(params.secretReferenceOverlay)) {
      if (!declared.has(name)) throw new LaunchSecretReferenceOverlayError('undeclared_requirement', name);
    }
  }
  const environment = params.secretReferenceOverlay
    ? resolveSecretReferenceOverlayEnvironment({ ...params, secretReferenceOverlay: params.secretReferenceOverlay })
    : Object.freeze({});
  for (const requirement of requirements) {
    if (requirement.required !== false && !Object.prototype.hasOwnProperty.call(environment, requirement.name)) {
      throw new LaunchSecretReferenceOverlayError('reference_missing', requirement.name);
    }
  }
  return environment;
}

/** The launch projection as one Provider refusal; a Saved Secret reason rides along unchanged. */
export function createLaunchSecretReferenceOverlayProviderErrorV1(
  reason: LaunchSecretReferenceOverlayFailureReasonV1,
  context: Readonly<{ connectionId?: string; machineId?: string; sourceProfileId?: string }> = {},
): ProviderErrorV1 {
  return createProviderErrorV1(readLaunchSecretReferenceOverlayProviderErrorCodeV1(reason),
    reason === 'undeclared_requirement' ? context : { ...context, savedSecretReason: reason });
}
