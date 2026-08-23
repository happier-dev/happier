import {
  AccountSettingsSavedSecretMutationError,
  SavedSecretSchema,
  applyAccountSettingsSavedSecretMutation,
  createProviderErrorV1,
  readProviderSettingsMutationBasisV1,
  writeProviderSettingsToAccountSettingsV1,
  type ProviderErrorV1,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';

import type { ProviderConnectionCreateInput } from './types';

const DIAGNOSTIC_DYNAMIC_PATH_OWNERS = [
  'secretBindingsByConnectionId',
  'manualModelsByConnectionId',
  'modelVisibilityByRef',
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
 * The CLI projection of the shared Provider-settings mutation basis. The
 * decision itself lives in Protocol so the encrypted client CAS paths — which
 * cannot call into the CLI at all — refuse exactly the same diagnostic state.
 */
export function readSettings(
  raw: Readonly<Record<string, unknown>>,
  errorContext?: Readonly<{ connectionId?: string; machineId?: string }>,
): ProviderSettingsV1 {
  const basis = readProviderSettingsMutationBasisV1(raw);
  if (basis.status === 'refused') {
    throw errorContext
      ? createProviderErrorV1('provider_settings_invalid', errorContext)
      : createProviderErrorV1('provider_settings_invalid');
  }
  return basis.settings;
}

export class ProviderConnectionValidationError extends Error {}

export function replaceSettings(
  raw: Readonly<Record<string, unknown>>,
  settings: ProviderSettingsV1,
): Record<string, unknown> {
  return writeProviderSettingsToAccountSettingsV1(raw, settings);
}

export function savedSecretExists(raw: Readonly<Record<string, unknown>>, id: string): boolean {
  return Array.isArray(raw.secrets) && raw.secrets.some((entry) =>
    entry !== null && typeof entry === 'object'
      && Object.prototype.hasOwnProperty.call(entry, 'id')
      && (entry as { id?: unknown }).id === id);
}

export function addPreparedSavedSecret(
  raw: Readonly<Record<string, unknown>>,
  prepared: ProviderConnectionCreateInput['preparedSavedSecret'],
): Record<string, unknown> {
  if (!prepared) return { ...raw };
  const record = SavedSecretSchema.parse(prepared.record);
  if (prepared.id !== record.id || savedSecretExists(raw, prepared.id)) {
    throw new ProviderConnectionValidationError('Allocated SavedSecret id is already used or inconsistent');
  }
  try {
    const applied = applyAccountSettingsSavedSecretMutation(
      raw,
      { kind: 'add', secret: record },
    );
    return { ...applied.settings };
  } catch (error) {
    if (error instanceof AccountSettingsSavedSecretMutationError) {
      throw new ProviderConnectionValidationError(
        'Prepared SavedSecret could not be added to Account Settings',
      );
    }
    throw error;
  }
}

export function isProviderError(value: unknown): value is ProviderErrorV1 {
  return value !== null && typeof value === 'object' && (value as { v?: unknown }).v === 1
    && typeof (value as { code?: unknown }).code === 'string';
}
