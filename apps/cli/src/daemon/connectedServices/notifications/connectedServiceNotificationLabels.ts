import {
  ConnectedServiceIdSchema,
  readBuiltInLegacyConnectedAccountServiceKeyIngress,
  readBuiltInLegacyConnectedServiceIdForQualifiedService,
} from '@happier-dev/protocol/connect/connected-service-bindings';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedServiceId } from '@happier-dev/protocol';
import { resolveConnectedAccountPrimaryNameV1 } from '@happier-dev/protocol/connect/connectedServiceProfilePreferences';

import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';

export type ConnectedServiceNotificationProfileSummary = Readonly<{
  profileId: string;
  status?: string | null;
  displayName?: string | null;
  providerEmail?: string | null;
  providerAccountId?: string | null;
}>;

export function readConnectedServiceNotificationDisplayText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
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
  const qualifiedServiceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(serviceId);
  const service = qualifiedServiceId ? parseQualifiedPluginContributionKey(qualifiedServiceId) : null;
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

/** Read the retained scalar profile/quota ports without changing the notification's qualified identity. */
export function readLegacyConnectedServiceNotificationServiceId(value: string): ConnectedServiceId | null {
  const legacy = ConnectedServiceIdSchema.safeParse(value);
  if (legacy.success) return legacy.data;
  const service = parseQualifiedPluginContributionKey(value);
  return service ? readBuiltInLegacyConnectedServiceIdForQualifiedService(service) : null;
}

export async function loadConnectedServiceNotificationProfilesById(input: Readonly<{
  serviceId: string;
  signal?: AbortSignal;
  listConnectedServiceProfiles(input: Readonly<{ serviceId: ConnectedServiceId; signal?: AbortSignal }>): Promise<Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ReadonlyArray<ConnectedServiceNotificationProfileSummary>;
  }>>;
}>): Promise<ReadonlyMap<string, ConnectedServiceNotificationProfileSummary>> {
  input.signal?.throwIfAborted();
  const serviceId = readLegacyConnectedServiceNotificationServiceId(input.serviceId);
  if (!serviceId) return new Map();
  try {
    const result = await input.listConnectedServiceProfiles({ serviceId, ...(input.signal ? { signal: input.signal } : {}) });
    input.signal?.throwIfAborted();
    return new Map(result.profiles.map((profile) => [profile.profileId, profile]));
  } catch {
    input.signal?.throwIfAborted();
    return new Map();
  }
}
