import type { TeamDirectorySourceRemovalImpactV1, TeamDirectorySourceSummaryV1 } from '@happier-dev/protocol/teams';

import { t } from '@/text';

export type DirectorySourcePresentationState =
    | 'initializing'
    | 'syncing'
    | 'failed'
    | 'stale'
    | 'never_synced'
    | 'active'
    | 'paused'
    | 'needs_attention';

/**
 * The server projects lifecycle `state`, `sync.attempt` and `sync.freshness`
 * as three facets on purpose, and this is their one presentation precedence:
 * lifecycle first, then the outstanding attempt, then a recorded failure, then
 * freshness. An outstanding run is not a recorded failure merely because it
 * exceeds a freshness target. A source whose worker has not succeeded in twice
 * its target window reads stale rather than active when no attempt is running.
 * Clocks never enter this decision.
 */
export function directorySourcePresentationState(
    source: TeamDirectorySourceSummaryV1,
): DirectorySourcePresentationState {
    if (source.state === 'paused') return 'paused';
    if (source.state === 'needs_attention') return 'needs_attention';
    if (source.sync.attempt === 'syncing') return 'syncing';
    if (source.sync.attempt === 'failed' || source.error !== null) return 'failed';
    if (source.state === 'initializing') return 'initializing';
    if (source.sync.attempt === 'never' || source.sync.freshness === 'never_synced') return 'never_synced';
    if (source.sync.freshness === 'stale') return 'stale';
    return 'active';
}

/** A directory source's presentation state in words. */
export function directorySourceStateLabel(state: DirectorySourcePresentationState): string {
    switch (state) {
        case 'initializing': return t('teams.authentication.directory.state.initializing');
        case 'syncing': return t('teams.authentication.directory.state.syncing');
        case 'failed': return t('teams.authentication.directory.state.failed');
        case 'stale': return t('teams.authentication.directory.freshness.stale');
        case 'never_synced': return t('teams.authentication.directory.freshness.never_synced');
        case 'active': return t('teams.authentication.directory.state.active');
        case 'paused': return t('teams.authentication.directory.state.paused');
        case 'needs_attention': return t('teams.authentication.directory.state.needsAttention');
    }
}

/**
 * What removing a directory source does, as sentences: who leaves the Team and which Group
 * memberships go (each only when it happens), then what is always kept. The preview's internal
 * contribution counts stay out of the copy; they describe mechanism, not consequence.
 */
export function directorySourceRemovalBody(impact: TeamDirectorySourceRemovalImpactV1): string {
    const lines: string[] = [];
    if (impact.teamMembershipsRemoved > 0) {
        lines.push(t('teams.authentication.directory.actions.removeMembers', { count: impact.teamMembershipsRemoved }));
    }
    if (impact.groupMembershipsRemoved > 0) {
        lines.push(t('teams.authentication.directory.actions.removeGroupMemberships', { count: impact.groupMembershipsRemoved }));
    }
    if (lines.length === 0) lines.push(t('teams.authentication.directory.actions.removeNothing'));
    lines.push(t('teams.authentication.directory.actions.removeKept'));
    return lines.join('\n');
}
