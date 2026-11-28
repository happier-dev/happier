import { isConnectedServiceProviderAccountAccessAllowed } from '@happier-dev/agents';
import type { ConnectedServiceId } from '@happier-dev/protocol';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

export function readActiveConnectedServicesAccountStatusByAgentId(): Readonly<Record<string, boolean>> | null {
  return getActiveAccountSettingsSnapshot()?.settings.connectedServicesAccountStatusByAgentIdV1 ?? null;
}

/**
 * The host's single answer to "may Happier read this account's provider status": the account is a
 * pool member, or the person turned on the account-status setting of an agent that declares the
 * service (the process's active account settings unless the caller holds them). Every quota,
 * probe and verification-lookup path asks here.
 */
export function isConnectedServiceAccountReadConsented(input: Readonly<{
  serviceId: ConnectedServiceId;
  poolMember: boolean;
  accountStatusByAgentId?: Readonly<Record<string, boolean>> | null;
}>): boolean {
  return isConnectedServiceProviderAccountAccessAllowed({
    serviceId: input.serviceId,
    poolMember: input.poolMember,
    accountStatusByAgentId: input.accountStatusByAgentId === undefined
      ? readActiveConnectedServicesAccountStatusByAgentId()
      : input.accountStatusByAgentId,
  });
}
