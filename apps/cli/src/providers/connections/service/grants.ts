import { ProviderSettingsV1Schema } from '@happier-dev/protocol/providers/settings/v1';
import type { ProviderSettingsV1 } from '@happier-dev/protocol';

export { bindProviderConnectionSecretV1 as bindProviderConnectionSecret } from '@happier-dev/protocol/providers/settings/operationsV1';

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
