import {
  applyAccountSettingsSavedSecretMutation,
  resolveSavedSecretSlotBindingIdV1,
  type SecretStringV1,
} from '@happier-dev/protocol';

import { settingsParse, type Settings } from '@/sync/domains/settings/settings';

export type AccountVoiceCredentialSource = 'account' | 'machine_override';

export function resolveAccountVoiceCredential(
  settings: Pick<Settings, 'voice' | 'secrets'>,
  providerId: string,
  credentialSlotId: string,
  machineId?: string | null,
  requiredRecipientContractDigest?: string | null,
): Readonly<{ secretId: string; source: AccountVoiceCredentialSource }> | null {
  const binding = settings.voice.credentialBindings.find((candidate) => candidate.providerId === providerId);
  if (!binding) return null;
  if (requiredRecipientContractDigest
    && binding.approvedRecipientContractDigest !== requiredRecipientContractDigest) return null;
  if (machineId) {
    const secretId = resolveSavedSecretSlotBindingIdV1(binding.credentialBindings, machineId, credentialSlotId);
    if (!secretId || !settings.secrets.some((secret) => secret.id === secretId)) return null;
    const source = binding.credentialBindings.byMachineId?.[machineId]?.[credentialSlotId] === secretId
      ? 'machine_override' as const
      : 'account' as const;
    return { secretId, source };
  }
  const secretId = binding.credentialBindings.account?.[credentialSlotId] ?? null;
  return secretId && settings.secrets.some((secret) => secret.id === secretId)
    ? { secretId, source: 'account' }
    : null;
}

export function isAccountVoiceCredentialRecipientApprovalRequired(params: Readonly<{
  settings: Pick<Settings, 'voice' | 'secrets'>;
  providerId: string;
  credentialSlotId: string;
  machineId?: string | null;
  requiredRecipientContractDigest?: string | null;
}>): boolean {
  if (!params.requiredRecipientContractDigest) return false;
  const reference = resolveAccountVoiceCredential(
    params.settings,
    params.providerId,
    params.credentialSlotId,
    params.machineId,
  );
  if (!reference) return false;
  const binding = params.settings.voice.credentialBindings.find(
    (candidate) => candidate.providerId === params.providerId,
  );
  return binding?.approvedRecipientContractDigest !== params.requiredRecipientContractDigest;
}

export function materializeAccountVoiceCredential(params: Readonly<{
  settings: Pick<Settings, 'voice' | 'secrets'>;
  providerId: string;
  credentialSlotId: string;
  machineId?: string | null;
  requiredRecipientContractDigest?: string | null;
  decrypt: (value: SecretStringV1) => string | null;
}>): string | null {
  const reference = resolveAccountVoiceCredential(
    params.settings,
    params.providerId,
    params.credentialSlotId,
    params.machineId,
    params.requiredRecipientContractDigest,
  );
  if (!reference) return null;
  const record = params.settings.secrets.find((secret) => secret.id === reference.secretId);
  return record ? params.decrypt(record.encryptedValue) : null;
}

export function resolveExactAccountVoiceCredentialSecretId(params: Readonly<{
  settings: Pick<Settings, 'voice'>;
  providerId: string;
  credentialSlotId: string;
  machineId?: string | null;
}>): string | null {
  const binding = params.settings.voice.credentialBindings.find(
    (candidate) => candidate.providerId === params.providerId,
  );
  if (!binding) return null;
  return params.machineId
    ? binding.credentialBindings.byMachineId?.[params.machineId]
        ?.[params.credentialSlotId] ?? null
    : binding.credentialBindings.account?.[params.credentialSlotId] ?? null;
}

export function upsertAccountVoiceCredential(params: Readonly<{
  settings: Settings;
  providerId: string;
  credentialSlotId: string;
  machineId?: string | null;
  value: string;
  generateId: () => string;
  now: number;
  expectedSecretId: string | null;
  expectedSecretUpdatedAt: number | null;
  approvedRecipientContractDigest?: string;
}>): Readonly<{
  settings: Settings;
  accountSettings: Record<string, unknown>;
  secretId: string;
}> {
  const value = params.value.trim();
  if (!value) throw new TypeError('Voice credential value must not be empty');
  const secretId = params.generateId();
  const existing = params.expectedSecretId
    ? params.settings.secrets.find((secret) => secret.id === params.expectedSecretId)
    : null;
  const { voice: _runtimeVoiceProjection, ...accountSettings } = params.settings;
  const result = applyAccountSettingsSavedSecretMutation(accountSettings, {
    kind: 'replaceVoiceCredentialSecret',
    target: {
      settingsKey: 'voiceSettingsV1',
      providerId: params.providerId,
      credentialSlotId: params.credentialSlotId,
      machineId: params.machineId ?? null,
    },
    expectedSecretId: params.expectedSecretId,
    expectedSecretUpdatedAt: params.expectedSecretUpdatedAt,
    secret: {
      id: secretId,
      name: existing?.name ?? `Voice: ${params.providerId}`,
      kind: 'apiKey',
      encryptedValue: { _isSecretValue: true, value },
      createdAt: params.now,
      updatedAt: params.now,
    },
    ...(params.approvedRecipientContractDigest === undefined
      ? {}
      : {
          approvedRecipientContractDigest:
            params.approvedRecipientContractDigest,
        }),
  });
  return {
    secretId,
    accountSettings: { ...result.settings },
    settings: settingsParse(result.settings),
  };
}

export function approveAccountVoiceCredentialRecipientContract(params: Readonly<{
  settings: Settings;
  providerId: string;
  credentialSlotId: string;
  machineId?: string | null;
  expectedSecretId: string;
  expectedSecretUpdatedAt: number;
  approvedRecipientContractDigest: string;
}>): Readonly<{
  settings: Settings;
  accountSettings: Record<string, unknown>;
}> {
  const { voice: _runtimeVoiceProjection, ...accountSettings } = params.settings;
  const result = applyAccountSettingsSavedSecretMutation(accountSettings, {
    kind: 'approveVoiceCredentialRecipientContract',
    target: {
      settingsKey: 'voiceSettingsV1',
      providerId: params.providerId,
      credentialSlotId: params.credentialSlotId,
      machineId: params.machineId ?? null,
    },
    expectedSecretId: params.expectedSecretId,
    expectedSecretUpdatedAt: params.expectedSecretUpdatedAt,
    approvedRecipientContractDigest:
      params.approvedRecipientContractDigest,
  });
  return {
    accountSettings: { ...result.settings },
    settings: settingsParse(result.settings),
  };
}

export function removeAccountVoiceCredential(params: Readonly<{
  settings: Settings;
  providerId: string;
  credentialSlotId: string;
  machineId?: string | null;
  expectedSecretId: string;
  expectedSecretUpdatedAt: number;
}>): Readonly<{
  settings: Settings;
  accountSettings: Record<string, unknown>;
  deletedSecret: boolean;
}> {
  const { voice: _runtimeVoiceProjection, ...accountSettings } = params.settings;
  const result = applyAccountSettingsSavedSecretMutation(accountSettings, {
    kind: 'removeVoiceCredentialSecret',
    target: {
      settingsKey: 'voiceSettingsV1',
      providerId: params.providerId,
      credentialSlotId: params.credentialSlotId,
      machineId: params.machineId ?? null,
    },
    expectedSecretId: params.expectedSecretId,
    expectedSecretUpdatedAt: params.expectedSecretUpdatedAt,
  });
  const settings = settingsParse(result.settings);
  return {
    accountSettings: { ...result.settings },
    deletedSecret: !settings.secrets.some(
      (candidate) => candidate.id === params.expectedSecretId,
    ),
    settings,
  };
}
