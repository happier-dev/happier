import {
  ConnectedServiceIdSchema,
  readBuiltInLegacyConnectedServiceIdForQualifiedService,
} from '@happier-dev/protocol/connect/connected-service-bindings';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedAccountServiceKey, ConnectedServiceId } from '@happier-dev/protocol';

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
): string | null {
  if (!profileId) return null;
  const profile = profilesById.get(profileId);
  return readConnectedServiceNotificationDisplayText(profile?.displayName)
    ?? readConnectedServiceNotificationDisplayText(profile?.providerEmail)
    ?? readConnectedServiceNotificationDisplayText(profileId);
}

export function resolveConnectedServiceNotificationDisplayName(
  serviceId: ConnectedAccountServiceKey,
): string | null {
  const service = parseQualifiedPluginContributionKey(serviceId);
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
  listConnectedServiceProfiles(input: Readonly<{ serviceId: ConnectedServiceId }>): Promise<Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ReadonlyArray<ConnectedServiceNotificationProfileSummary>;
  }>>;
}>): Promise<ReadonlyMap<string, ConnectedServiceNotificationProfileSummary>> {
  const serviceId = readLegacyConnectedServiceNotificationServiceId(input.serviceId);
  if (!serviceId) return new Map();
  try {
    const result = await input.listConnectedServiceProfiles({ serviceId });
    return new Map(result.profiles.map((profile) => [profile.profileId, profile]));
  } catch {
    return new Map();
  }
}
