import { AGENT_IDS } from '@happier-dev/agents';
import { projectLaunchProfileListV1, type LaunchProfileListProjectionV1 } from '@happier-dev/protocol';

import { readUiAiLaunchProfileSnapshot } from '@/sync/domains/profiles/aiLaunchProfileCollection';
import { storage } from '@/sync/domains/state/storage';

/**
 * The Account's Launch Profiles, answered from the settings this client already
 * holds.
 *
 * `sessions.spawn.profiles.list` had exactly one implementation — the CLI's —
 * so a mounted plugin surface asking the app for the profile it was configured
 * with got `unsupported_action` and every profile-referencing configuration
 * silently did nothing. The row shape is the Protocol-owned projection both
 * hosts now compose, so which host answered cannot change what a caller reads.
 *
 * It probes nothing and resolves nothing: a profile is a set of PREFERENCES,
 * and turning one into an execution target, a checkout or an agent belongs to
 * the caller that is launching, against the facts it holds at that moment.
 */

export type SpawnProfilesListResult = LaunchProfileListProjectionV1;

export function listSpawnProfilesForActions(
    args: Readonly<{ agentId?: string; backendTargetKey?: string; limit?: number }>,
): SpawnProfilesListResult {
    const state = storage.getState();
    const snapshot = readUiAiLaunchProfileSnapshot(state.settings.profiles);
    return projectLaunchProfileListV1(snapshot.profiles, {
        agentIds: AGENT_IDS,
        ...(args.agentId === undefined ? {} : { agentId: args.agentId }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        unreadableCount: snapshot.unreadableCount,
        available: state.settingsVersion !== null,
    });
}
