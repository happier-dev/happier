import type { ConnectedServiceId, QualifiedConnectedAccountRef } from '@happier-dev/protocol';

export type BoundProfile = Readonly<{ serviceId: ConnectedServiceId; profileId: string }>;
export function bindingKey(binding: BoundProfile): string {
  return `${binding.serviceId}/${binding.profileId}`;
}

export function qualifiedAccountKey(account: QualifiedConnectedAccountRef): string {
  return JSON.stringify([
    account.service.pluginId,
    account.service.localId,
    account.accountId,
  ]);
}
