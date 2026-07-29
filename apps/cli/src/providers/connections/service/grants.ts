import {
  ProviderSettingsV1Schema,
  readOwnRecordValue,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';

export function bindProviderConnectionSecret(input: Readonly<{
  settings: ProviderSettingsV1;
  connectionId: string;
  machineId?: string | null;
  slotId: string;
  savedSecretId: string | null;
}>): ProviderSettingsV1 {
  const previous = readOwnRecordValue(input.settings.secretBindingsByConnectionId, input.connectionId) ?? {};
  const account = { ...(previous.account ?? {}) };
  const byMachineId = { ...(previous.byMachineId ?? {}) };
  if (input.machineId) {
    const machine = { ...(byMachineId[input.machineId] ?? {}) };
    if (input.savedSecretId === null) delete machine[input.slotId];
    else machine[input.slotId] = input.savedSecretId;
    if (Object.keys(machine).length === 0) delete byMachineId[input.machineId];
    else byMachineId[input.machineId] = machine;
  } else if (input.savedSecretId === null) {
    delete account[input.slotId];
  } else {
    account[input.slotId] = input.savedSecretId;
  }
  const nextBinding = {
    ...(Object.keys(account).length > 0 ? { account } : {}),
    ...(Object.keys(byMachineId).length > 0 ? { byMachineId } : {}),
  };
  const secretBindingsByConnectionId: Record<string, typeof nextBinding> = {
    ...input.settings.secretBindingsByConnectionId,
  };
  if (Object.keys(nextBinding).length === 0) delete secretBindingsByConnectionId[input.connectionId];
  else secretBindingsByConnectionId[input.connectionId] = nextBinding;
  return ProviderSettingsV1Schema.parse({ ...input.settings, secretBindingsByConnectionId });
}

export function setProviderConnectionGrant(input: Readonly<{
  settings: ProviderSettingsV1;
  connectionId: string;
  machineId: string;
  scope: 'account' | 'machine' | 'connection';
  enabled: boolean;
  connectionSecurityFingerprint: string;
  endpointSetFingerprint: string;
  now: number;
}>): ProviderSettingsV1 {
  const accountGrants = input.scope === 'account' || input.scope === 'connection'
    ? input.settings.accountGrants.filter((entry) => entry.connectionId !== input.connectionId)
    : input.settings.accountGrants;
  const machineGrants = input.scope === 'connection'
    ? input.settings.machineGrants.filter((entry) => entry.connectionId !== input.connectionId)
    : input.scope === 'machine' || input.enabled
    ? input.settings.machineGrants.filter((entry) =>
        !(entry.connectionId === input.connectionId && entry.machineId === input.machineId))
    : input.settings.machineGrants;
  if (!input.enabled) return ProviderSettingsV1Schema.parse({ ...input.settings, accountGrants, machineGrants });
  return ProviderSettingsV1Schema.parse({
    ...input.settings,
    accountGrants: input.scope === 'account'
      ? [...accountGrants, {
          v: 1, connectionId: input.connectionId,
          connectionSecurityFingerprint: input.connectionSecurityFingerprint,
          confirmedAt: input.now,
        }]
      : accountGrants,
    machineGrants: input.scope === 'machine'
      ? [...machineGrants, {
          v: 1, connectionId: input.connectionId, machineId: input.machineId,
          connectionSecurityFingerprint: input.connectionSecurityFingerprint,
          endpointSetFingerprint: input.endpointSetFingerprint,
          confirmedAt: input.now,
        }]
      : machineGrants,
  });
}
