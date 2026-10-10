import type { z } from 'zod';
import { ACCOUNT_SETTING_DEFINITIONS } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingMutationV1Schema } from '@happier-dev/protocol/account/settings/accountSettingMutationV1';
import { SettingsDeclarationActionInputSchemasV1, SettingsDeclarationMutationReversalV1Schema, SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { parseBuiltInAccountSettingValueV1, readBuiltInAccountSettingValueV1,
  type PortableSettingDeclarationV1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';
import { readRawSettingScalarV1 } from '@happier-dev/protocol/actions';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { StoredCredentials } from '@/persistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readAccountSettingsV2Raw, updateAccountSettingsV2Once } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';

const refuse = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
class SettingReversalRefused extends Error {
  constructor(readonly errorCode: 'credential_scope_retired' | 'account_settings_conflict') {
    super(errorCode);
  }
}

/** Exact scalar receipts use one observed-version CAS, never a default-valued reset approximation. */
export async function executeCliScalarSettingReversal(params: Readonly<{
  declaration: PortableSettingDeclarationV1;
  requested: z.output<typeof SettingsDeclarationActionInputSchemasV1['settings.set']>;
  credentials: StoredCredentials;
  serverId?: string;
  signal?: AbortSignal;
  isCredentialCurrent?: () => boolean | Promise<boolean>;
}>) {
  const { declaration, requested } = params;
  const storage = declaration.storage;
  const key = storage?.key;
  const definition = Object.entries(ACCOUNT_SETTING_DEFINITIONS).find(([candidate]) => candidate === key)?.[1];
  const accountId = readAccountIdFromToken(params.credentials.token);
  const reversal = requested.reversal;
  if (!reversal || !key || storage?.scope !== 'account' || storage.kind || storage.path || storage.owner
    || !definition || !params.serverId || !accountId) return refuse('setting_conditional_mutation_unsupported');
  const scope = { serverId: params.serverId, accountId };
  if (reversal.kind === 'restore' && !sameStrictJsonValue(scope, reversal.scope)) return refuse('setting_reversal_scope_mismatch');
  const value = reversal.kind === 'restore' ? { success: true as const, value: requested.value }
    : parseBuiltInAccountSettingValueV1(declaration, requested.value);
  if (!value.success) return refuse('invalid_setting_value');
  const snapshot = await readAccountSettingsV2Raw({ credentials: params.credentials, signal: params.signal });
  params.signal?.throwIfAborted();
  if (params.isCredentialCurrent && !await params.isCredentialCurrent()) return refuse('credential_scope_retired');
  const before = readRawSettingScalarV1(snapshot.raw, key);
  if (!before || 'value' in before && !definition.parseMutationValue(before.value).success) return refuse('invalid_setting_value');
  if (reversal.kind === 'restore' && (!sameStrictJsonValue(before, reversal.applied) || snapshot.version !== reversal.appliedVersion)) return refuse('account_settings_conflict');
  const restore = reversal.kind === 'restore' ? reversal.before : undefined;
  if (restore && 'value' in restore && !definition.parseMutationValue(restore.value).success) return refuse('invalid_setting_value');
  const applied = restore ?? readRawSettingScalarV1({ [key]: storage.invertBoolean ? !value.value : value.value }, key);
  if (!applied) return refuse('setting_conditional_mutation_unsupported');
  const mutation = AccountSettingMutationV1Schema.parse({ operations: [
    restore && 'unset' in restore ? { op: 'reset', key } : { op: 'set', key, value: 'value' in applied ? applied.value : null },
  ] });
  let result: Awaited<ReturnType<typeof updateAccountSettingsV2Once>>;
  try {
    result = await updateAccountSettingsV2Once({ credentials: params.credentials,
    expectedVersion: reversal.kind === 'restore' ? reversal.appliedVersion : requested.expectedSettingsVersion ?? snapshot.version,
    prepareMutation: async raw => {
      params.signal?.throwIfAborted();
      if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw new SettingReversalRefused('credential_scope_retired');
      if (!sameStrictJsonValue(readRawSettingScalarV1(raw, key), before)) throw new SettingReversalRefused('account_settings_conflict');
      return mutation;
    }, signal: params.signal });
  } catch (error) {
    if (error instanceof SettingReversalRefused) return refuse(error.errorCode);
    throw error;
  }
  if (result.status !== 'applied' && result.status !== 'unchanged') return { ...refuse(`account_settings_${result.status}`), details: result };
  const projected = readBuiltInAccountSettingValueV1(declaration, result.settings);
  const response = { anchor: declaration.anchor,
    ...(projected === undefined ? { unset: true as const } : { value: SettingsDeclarationValueV1Schema.parse(projected) }), settingsVersion: result.version };
  if (reversal.kind === 'restore') return response;
  if (result.status === 'unchanged') return { ...response, reversalUnavailableReason: 'no_change' as const };
  const receipt = SettingsDeclarationMutationReversalV1Schema.safeParse({ scope, beforeVersion: snapshot.version,
    appliedVersion: result.version, before, applied });
  return receipt.success ? { ...response, reversal: receipt.data } : response;
}
