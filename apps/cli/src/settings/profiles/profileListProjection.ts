import { AGENT_IDS } from '@happier-dev/agents';
import {
  mapAiLaunchProfileToListItemV1,
  projectLaunchProfileListV1,
  type AiLaunchProfile,
  type LaunchProfileListItemV1,
  type LaunchProfileListProjectionV1,
} from '@happier-dev/protocol';

/**
 * The CLI's binding of the one Protocol-owned profile inventory projection.
 *
 * The projection itself moved to `packages/protocol/src/profiles/listProjection.ts`
 * because the app answers the same Action from its own Account settings; only
 * the agent catalog is supplied here, because that catalog is a host package.
 */
export type ProfilesListItem = LaunchProfileListItemV1;

export function mapProfileToListItem(profile: AiLaunchProfile): ProfilesListItem {
  return mapAiLaunchProfileToListItemV1(profile, { agentIds: AGENT_IDS });
}

/**
 * The CLI's binding of the whole-list projection, filter, order and
 * completeness included, so the app and the CLI cannot answer
 * `sessions.spawn.profiles.list` differently.
 */
export function projectProfilesListForActions(
  profiles: readonly AiLaunchProfile[],
  params: Readonly<{
    agentId?: unknown;
    limit?: unknown;
    unreadableCount?: number;
    available?: boolean;
  }>,
): LaunchProfileListProjectionV1 {
  return projectLaunchProfileListV1(profiles, {
    agentIds: AGENT_IDS,
    ...(typeof params.agentId === 'string' ? { agentId: params.agentId } : {}),
    ...(params.limit === undefined ? {} : { limit: params.limit }),
    ...(params.unreadableCount === undefined ? {} : { unreadableCount: params.unreadableCount }),
    ...(params.available === undefined ? {} : { available: params.available }),
  });
}
