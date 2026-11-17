import { createRelayUrlComparableKeySafe } from '@happier-dev/protocol/server/relayDrift';
import { SystemTaskExecutionError } from '../runSystemTask.js';
import type { HappierJsonExecutor } from './happierJsonExecutor.js';

/** An explicit Home: its URLs and, when known, its server identity (RV-11). */
export type LocalServerProfileTarget = Readonly<{
  serverUrl: string;
  localServerUrl?: string | null;
  serverIdentityId?: string | null;
  /** Retained credentials must have an observed Home identity before reuse. */
  requireRecordedHomeIdentity?: boolean;
}>;

type ServerProfileSummary = Readonly<{
  id: string;
  serverUrl: string;
  localServerUrl: string | null;
  /** The Home identity the CLI recorded for this profile; absent until its daemon observed one. */
  homeServerIdentityId: string | null;
}>;

function readProfiles(parsed: unknown): Readonly<{ activeServerId: string | null; profiles: readonly ServerProfileSummary[] }> {
  const data = parsed && typeof parsed === 'object'
    ? (parsed as { data?: { activeServerId?: unknown; profiles?: unknown } }).data
    : undefined;
  const activeServerId = typeof data?.activeServerId === 'string' && data.activeServerId.trim()
    ? data.activeServerId.trim()
    : null;
  const profiles = Array.isArray(data?.profiles)
    ? data.profiles.flatMap((entry): ServerProfileSummary[] => {
        const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null;
        const id = typeof record?.id === 'string' ? record.id.trim() : '';
        const serverUrl = typeof record?.serverUrl === 'string' ? record.serverUrl.trim() : '';
        if (!id || !serverUrl) return [];
        const localServerUrl = typeof record?.localServerUrl === 'string' && record.localServerUrl.trim()
          ? record.localServerUrl.trim()
          : null;
        const homeServerIdentityId = typeof record?.homeServerIdentityId === 'string' && record.homeServerIdentityId.trim()
          ? record.homeServerIdentityId.trim()
          : null;
        return [{ id, serverUrl, localServerUrl, homeServerIdentityId }];
      })
    : [];
  return { activeServerId, profiles };
}

/**
 * The one saved profile that is `target`. The CLI keeps identity-distinct profiles that share one
 * endpoint (a Personal Home erased and recreated at the same loopback URL), so the Home identity
 * decides when it is known: the profile carrying it, else the one profile that has none yet (its
 * daemon has not recorded one). A match that stays ambiguous is refused, never resolved by order.
 */
function selectTargetProfile(
  profiles: readonly ServerProfileSummary[],
  target: LocalServerProfileTarget,
): ServerProfileSummary | null {
  const targetKeys = new Set([createRelayUrlComparableKeySafe(target.serverUrl), createRelayUrlComparableKeySafe(target.localServerUrl)].filter(
    (key): key is string => key !== null,
  ));
  const urlMatches = profiles.filter((profile) => (
    targetKeys.has(createRelayUrlComparableKeySafe(profile.serverUrl) ?? '')
    || (profile.localServerUrl !== null && targetKeys.has(createRelayUrlComparableKeySafe(profile.localServerUrl) ?? ''))
  ));
  const identity = target.serverIdentityId?.trim() || null;
  const candidates = identity
    ? (() => {
        const exact = urlMatches.filter((profile) => profile.homeServerIdentityId === identity);
        return exact.length > 0 || target.requireRecordedHomeIdentity ? exact
          : urlMatches.filter((profile) => profile.homeServerIdentityId === null);
      })()
    : urlMatches;
  if (candidates.length > 1) {
    throw new SystemTaskExecutionError(
      'server_profile_ambiguous',
      `The Happier CLI has ${candidates.length} saved profiles for ${target.serverUrl} (${candidates.map((profile) => profile.id).join(', ')}), so it cannot tell which one is this Home.`,
    );
  }
  return candidates[0] ?? null;
}

/** Saved Home identity selection is shared by browser enrollment and Node service control. */
export async function readLocalServerProfileIdentity(
  executor: HappierJsonExecutor,
  target: LocalServerProfileTarget,
): Promise<Readonly<{ serverId: string | null; activeServerId: string | null }>> {
  const { activeServerId, profiles } = readProfiles(await executor.runHappierJson(['server', 'list', '--json']));
  return { serverId: selectTargetProfile(profiles, target)?.id ?? null, activeServerId };
}
