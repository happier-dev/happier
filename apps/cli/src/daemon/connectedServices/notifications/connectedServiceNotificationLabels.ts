import {
  ConnectedServiceIdSchema,
  parseQualifiedPluginContributionKey,
  type ConnectedAccountServiceKey,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

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
  const contribution = getResolvedContributionRegistry()
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
  listConnectedServiceProfiles(input: Readonly<{ serviceId: ConnectedServiceId }>): Promise<Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ReadonlyArray<ConnectedServiceNotificationProfileSummary>;
  }>>;
}>): Promise<ReadonlyMap<string, ConnectedServiceNotificationProfileSummary>> {
  const serviceIdParsed = ConnectedServiceIdSchema.safeParse(input.serviceId);
  if (!serviceIdParsed.success) return new Map();
  try {
    const result = await input.listConnectedServiceProfiles({ serviceId: serviceIdParsed.data });
    return new Map(result.profiles.map((profile) => [profile.profileId, profile]));
  } catch {
    return new Map();
  }
}
