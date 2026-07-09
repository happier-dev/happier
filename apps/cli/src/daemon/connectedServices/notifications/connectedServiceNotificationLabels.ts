import type { ConnectedServiceId } from '@happier-dev/protocol';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol';

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
