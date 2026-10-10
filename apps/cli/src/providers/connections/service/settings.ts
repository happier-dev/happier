import { ProviderErrorV1Schema, createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { ProviderSettingsV1Schema } from '@happier-dev/protocol/providers/settings/v1';
import { SavedSecretSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import type { AccountSettingsMutationResult, ProviderErrorV1, ProviderSettingsV1 } from '@happier-dev/protocol';
import { applyProviderDefaultModelSelectionV1, type ProviderDefaultModelSelectionMutationV1 } from '@happier-dev/protocol/providers/selection/v1';
import type { StoredCredentials } from '@/persistence';
import { updateAccountSettingsV2OnceAgainstLatest } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import {
  createSavedSecretMaterializerV1,
  type SavedSecretCatalogResourceInputV1,
  type SavedSecretCatalogState,
} from '@/settings/secrets/savedSecretCatalog';

import type { ProviderConnectionCreateInput, ProviderConnectionServiceSnapshot } from './types';

/** A selected model is Account preference intent, never catalog authority. */
export function setDefaultProviderModelSelection(input: ProviderDefaultModelSelectionMutationV1 & Readonly<{
  credentials: StoredCredentials;
  signal?: AbortSignal;
}>): Promise<AccountSettingsMutationResult> {
  return updateAccountSettingsV2OnceAgainstLatest({
    credentials: input.credentials,
    signal: input.signal,
    mutate: raw => applyProviderDefaultModelSelectionV1(raw, { agentTargetKey: input.agentTargetKey, selection: input.selection }),
  });
}

const DIAGNOSTIC_DYNAMIC_PATH_OWNERS = [
  'secretBindingsByConnectionId',
  'manualModelsByConnectionId',
  'modelVisibilityByRef',
  'modelPickerVisibilityByConnectionId',
  'defaultsByAgentTargetKey',
] as const;

export function redactProviderSettingsDiagnostic(
  diagnostic: Readonly<{ path: string; reason: string }>,
): Readonly<{ path: string; reason: string }> {
  const dynamicOwner = DIAGNOSTIC_DYNAMIC_PATH_OWNERS.find((owner) =>
    diagnostic.path === owner || diagnostic.path.startsWith(`${owner}.`));
  const structuralPath = dynamicOwner ?? diagnostic.path;
  const boundedPath = structuralPath.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 512).trim();
  const boundedReason = diagnostic.reason.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 128).trim();
  return {
    path: boundedPath || 'providerSettingsV1',
    reason: boundedReason || 'invalid_record',
  };
}

/**
 * Validate the typed domain view at the canonical Provider schema. Raw Account
 * Settings are neither a read source nor a mutation target for this service.
 */
export function readSettings(
  settings: ProviderSettingsV1,
  errorContext?: Readonly<{ connectionId?: string; machineId?: string }>,
  diagnostics: readonly Readonly<{ path: string; reason: string }>[] = [],
): ProviderSettingsV1 {
  const parsed = ProviderSettingsV1Schema.safeParse(settings);
  if (!parsed.success || diagnostics.length > 0) {
    throw errorContext
      ? createProviderErrorV1('provider_settings_invalid', errorContext)
      : createProviderErrorV1('provider_settings_invalid');
  }
  return parsed.data;
}

export function readSnapshotSettings(snapshot: ProviderConnectionServiceSnapshot): ProviderSettingsV1 {
  return readSettings(snapshot.providerSettings, undefined, snapshot.providerSettingsDiagnostics);
}

export class ProviderConnectionValidationError extends Error {}

/**
 * Validates an opaque Saved Secret reference through the one Account-scoped
 * catalog resolver. Shared-resource metadata retained during a failed refresh
 * is deliberately unavailable rather than sufficient authorization.
 */
export function requireSavedSecretReferenceReady(input: Readonly<{
  rawAccountSettings: Readonly<Record<string, unknown>>;
  savedSecretId: string;
  savedSecretResources: readonly SavedSecretCatalogResourceInputV1[] | undefined;
  savedSecretCatalogState: SavedSecretCatalogState | undefined;
  connectionId: string;
  machineId: string;
  preparedSavedSecret?: ProviderConnectionCreateInput['preparedSavedSecret'];
}>): void {
  const materializer = createSavedSecretMaterializerV1({
    accountSettings: input.rawAccountSettings,
    settingsSecretsReadKeys: [],
    resources: input.savedSecretResources,
    resourceCatalogState: input.savedSecretCatalogState,
  });
  const inspected = materializer.inspect(input.savedSecretId);
  if (input.preparedSavedSecret) {
    const prepared = SavedSecretSchema.parse(input.preparedSavedSecret.record);
    if (prepared.id !== input.preparedSavedSecret.id || prepared.id !== input.savedSecretId
      || inspected.status !== 'missing') {
      throw new ProviderConnectionValidationError('Prepared SavedSecret identity is inconsistent or already used');
    }
    return;
  }
  if (inspected.status === 'ready') return;
  throw createProviderErrorV1(
    inspected.status === 'temporarily_unavailable'
      ? 'provider_secret_unavailable'
      : 'provider_secret_missing',
    { connectionId: input.connectionId, machineId: input.machineId },
  );
}

export function parseProviderError(value: unknown): ProviderErrorV1 | null {
  const parsed = ProviderErrorV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
