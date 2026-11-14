import type { TeamDirectoryGroupV1, TeamDirectorySourceSummaryV1 } from '@happier-dev/protocol/teams';

import { t } from '@/text';

/** The directory reader supplies the mapped identity; its label opens only in the local viewer. */
export function directoryGroupMappingTargetLabel(
    mapping: TeamDirectoryGroupV1['mapping'],
    openedGroupDisplayName?: string | null,
): string {
    return mapping.state === 'bound' && openedGroupDisplayName !== null && openedGroupDisplayName !== undefined
        ? openedGroupDisplayName
        : t('identityAdministration.mappedGroupNotVisible');
}
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
