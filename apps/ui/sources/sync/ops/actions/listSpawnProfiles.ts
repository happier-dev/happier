import { AGENT_IDS } from '@happier-dev/agents';
import { BackendTargetKeyV2Schema, parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { projectLaunchProfileListV1, type LaunchProfileListProjectionV1 } from '@happier-dev/protocol/profiles/listProjection';

import { readUiProfileCatalogSnapshot, type UiAiLaunchProfileSnapshot } from '@/sync/domains/profiles/aiLaunchProfileCollection';
import { getProfileCatalogSnapshot } from '@/sync/store/settings/profileCatalogSnapshot';
import { storage } from '@/sync/domains/state/storage';

/**
 * The Account's Launch Profiles, answered from its admitted scoped catalog.
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
    capturedSnapshot?: UiAiLaunchProfileSnapshot & Readonly<{ available: boolean }>,
): SpawnProfilesListResult {
    const state = storage.getState();
    const catalog = getProfileCatalogSnapshot(state.settingsScope);
    const snapshot = capturedSnapshot ?? (catalog ? readUiProfileCatalogSnapshot(catalog)
        : { profiles: [], unreadableCount: 0, available: false });
    const agentIds = new Set<string>(AGENT_IDS);
    for (const profile of snapshot.profiles) {
        // Only the historical V1 profile shape carries `compatibilityByTargetKey`; a V2
        // profile's `preferredAgentTargetKey` is unreachable from this branch (see the
        // lane report's listSpawnProfiles finding).
        if (!('compatibilityByTargetKey' in profile)) continue;
        const targetKeys = Object.keys(profile.compatibilityByTargetKey);
        for (const targetKey of targetKeys) {
            const parsedKey = BackendTargetKeyV2Schema.safeParse(targetKey);
            if (!parsedKey.success) continue;
            const parsedTarget = parseBackendTargetKeyV2(parsedKey.data);
            if (parsedTarget.kind !== 'agent') continue;
            agentIds.add(buildQualifiedPluginContributionKey(parsedTarget.identity));
        }
    }
    return projectLaunchProfileListV1(snapshot.profiles, {
        agentIds: [...agentIds],
        ...(args.agentId === undefined ? {} : { agentId: args.agentId }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        unreadableCount: snapshot.unreadableCount,
        available: snapshot.available,
    });
}
