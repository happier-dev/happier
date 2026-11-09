import { readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol/connect/connected-service-bindings';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import type { QualifiedConnectedAccountProfileV4, QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import { resolveConnectedAccountPrimaryNameV1 } from '@happier-dev/protocol/connect/connectedServiceProfilePreferences';

import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';

export type ConnectedServiceNotificationProfileSummary = Readonly<{
  profileId: string;
  status?: string | null;
  displayName?: string | null;
  providerEmail?: string | null;
  providerAccountId?: string | null;
}>;

export type ConnectedServiceNotificationAccountReader = (input: Readonly<{
  accounts: readonly QualifiedConnectedAccountRef[];
  signal?: AbortSignal;
}>) => Promise<Readonly<{
  accounts: readonly Pick<QualifiedConnectedAccountProfileV4, 'ref' | 'displayName' | 'providerIdentity'>[];
}>>;

function readNotificationService(serviceId: string): QualifiedConnectedAccountRef['service'] | null {
  const service = parseQualifiedPluginContributionKey(serviceId);
  if (service) return service;
  const legacyServiceKey = readBuiltInLegacyConnectedAccountServiceKeyIngress(serviceId);
  return legacyServiceKey ? parseQualifiedPluginContributionKey(legacyServiceKey) : null;
}

export function readConnectedServiceNotificationDisplayText(value: unknown): string | null {
  const normalized = resolvePluginLocalizedStringV2Text(value).replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

export function resolveConnectedServiceNotificationProfileLabel(
  profilesById: ReadonlyMap<string, ConnectedServiceNotificationProfileSummary>,
  profileId: string | null,
  serviceTitle: string = 'Provider',
): string | null {
  if (!profileId) return null;
  const profile = profilesById.get(profileId);
  return readConnectedServiceNotificationDisplayText(resolveConnectedAccountPrimaryNameV1({
    serviceTitle,
    displayName: profile?.displayName,
    email: profile?.providerEmail,
    providerAccountId: profile?.providerAccountId,
    accountId: profileId,
  }).name) ?? 'Connected account';
}

export function resolveConnectedServiceNotificationDisplayName(
  serviceId: string,
): string | null {
  const service = readNotificationService(serviceId);
  if (!service) return null;
  const contribution = readCurrentContributionRegistry()
    .connectedAccountDescriptors
    ?.find((candidate) => (
      candidate.pluginId === service.pluginId
      && candidate.definition.id === service.localId
    ));
  return readConnectedServiceNotificationDisplayText(
    contribution?.definition.title,
  );
}

export async function loadConnectedServiceNotificationProfilesById(input: Readonly<{
  serviceId: string;
  profileIds: readonly (string | null)[];
  signal?: AbortSignal;
  listQualifiedConnectedAccounts: ConnectedServiceNotificationAccountReader;
}>): Promise<ReadonlyMap<string, ConnectedServiceNotificationProfileSummary>> {
  input.signal?.throwIfAborted();
  const service = readNotificationService(input.serviceId);
  if (!service) return new Map();
  const accountIds = new Set(input.profileIds.filter((id): id is string => id !== null));
  if (accountIds.size === 0) return new Map();
  try {
    const result = await input.listQualifiedConnectedAccounts({
      accounts: [...accountIds].map((accountId) => ({ service, accountId })),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    input.signal?.throwIfAborted();
    return new Map(result.accounts.map((profile) => [profile.ref.accountId, {
      profileId: profile.ref.accountId,
      displayName: profile.displayName,
      providerEmail: profile.providerIdentity?.email,
      providerAccountId: profile.providerIdentity?.accountId,
    }]));
  } catch {
    input.signal?.throwIfAborted();
    return new Map();
  }
}
