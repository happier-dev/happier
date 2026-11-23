import {
  qualifyTranscriptAccountActor,
  type TranscriptAccountActor,
} from '@happier-dev/session-core/messages';

import { useActiveServerAccountScope, useFriend, useUser } from '@/sync/store/hooks';
import {
  areServerAccountScopesEqual,
  type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';

/**
 * An Account id as the viewer may see it on one Home: the applied Home's already-authorized profile
 * projection, qualified to that Home, or null when this device has no profile for it. Never a lookup
 * that widens what the viewer can read; an unknown Account stays unknown.
 */
export function useKnownAccountActor(
  serverId: string | null,
  accountId: string | null | undefined,
): Readonly<{
  viewerScope: ServerAccountScope | null;
  actor: TranscriptAccountActor | null;
}> {
  const viewerScope = useActiveServerAccountScope(serverId);
  const profileScope = useActiveServerAccountScope();
  // The scope owner has verified local aliases against the applied canonical Home.
  const qualifiedServerId = viewerScope?.serverId ?? serverId;
  const id = accountId?.trim() || undefined;
  const profileMatchesHome = areServerAccountScopesEqual(viewerScope, profileScope);
  const knownUser = useUser(id);
  const friend = useFriend(profileMatchesHome && !knownUser ? id : undefined);
  const profile = knownUser ?? friend;
  const actor =
    id &&
    qualifiedServerId &&
    profile?.id === id &&
    profileMatchesHome
      ? qualifyTranscriptAccountActor(
          {
            v: 1,
            accountId: id,
            profile: {
              name: profile.name,
              firstName: profile.firstName,
              lastName: profile.lastName,
              username: profile.username,
              avatarUrl: null,
            },
          },
          qualifiedServerId,
        )
      : null;
  return { viewerScope, actor: actor ?? null };
}
