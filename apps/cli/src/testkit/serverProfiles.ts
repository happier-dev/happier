import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { updateSettings, writeServerProfileLastUsedAt } from '@/persistence';
import type { ServerProfile } from '@/server/serverProfiles';

/** Persist a valid exact Home at the settings boundary so target resolution stays real. */
export async function seedTestServerProfile(input: Readonly<{
  id: string;
  homeId: string;
  serverUrl: string;
  localServerUrl?: string;
  webappUrl?: string;
}>): Promise<ServerProfile> {
  const profile: ServerProfile = {
    id: input.id, name: input.id, serverUrl: input.serverUrl, webappUrl: input.webappUrl ?? input.serverUrl,
    ...(input.localServerUrl ? { localServerUrl: input.localServerUrl } : {}),
    createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
    homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({
      v: 1, homeServerIdentityId: input.homeId, canonicalServerUrl: input.serverUrl,
      revision: 1, endpoints: [{ kind: 'https', url: input.serverUrl }],
    }),
  };
  const { lastUsedAt, ...storedProfile } = profile;
  await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [profile.id]: storedProfile } }));
  await writeServerProfileLastUsedAt(profile.id, lastUsedAt);
  return profile;
}
