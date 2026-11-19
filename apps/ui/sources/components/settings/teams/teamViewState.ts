import type { TeamSummaryV1 } from '@happier-dev/protocol/teams';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';
import type { TeamSnapshot } from '@/sync/store/teams/teamsSnapshots';

/**
 * What a Team screen should render for one exact Home and Team right now.
 *
 * Continuity is the controlling rule, exactly as it is for Home governance: once
 * a Team has answered, its projection keeps rendering through every refresh,
 * wake and failure. A surface that blanked on a dropped connection would make a
 * Team owner believe their Team or their authority had disappeared.
 *
 * `mutationsAvailable` closes writes on the same signal that keeps reads open: a
 * stale projection is fine to read and wrong to decide against, because the Home
 * has already moved past the capabilities being rendered.
 */
export type TeamViewState =
    /** This Team has never answered. Nothing is claimed about it. */
    | Readonly<{ kind: 'unobserved' }>
    /** A first observation is in flight; there is nothing retained to show. */
    | Readonly<{ kind: 'loading' }>
    /** The Home refused or could not be reached, and nothing was retained. */
    | Readonly<{ kind: 'unavailable'; error: ScopedSnapshotError; retryable: boolean }>
    | Readonly<{
        kind: 'ready';
        scope: ServerAccountScope;
        address: TeamAddress;
        team: TeamSummaryV1;
        refreshing: boolean;
        stale: boolean;
        lastObservedAt: number | null;
        mutationsAvailable: boolean;
        /**
         * An archived Team is read-only regardless of role. Restore is the one
         * exception, and it is decided by the server-projected capability, not
         * by re-deriving it from the archived flag here.
         */
        archived: boolean;
        error: ScopedSnapshotError | null;
    }>;

const UNOBSERVED: TeamViewState = Object.freeze({ kind: 'unobserved' as const });
const LOADING: TeamViewState = Object.freeze({ kind: 'loading' as const });

export function resolveTeamViewState(snapshot: TeamSnapshot | null | undefined, credentialBound = true): TeamViewState {
    if (!snapshot) return UNOBSERVED;

    if (!snapshot.data) {
        if (snapshot.error) {
            return Object.freeze({
                kind: 'unavailable' as const,
                error: snapshot.error,
                retryable: snapshot.error.retryable,
            });
        }
        return LOADING;
    }

    return Object.freeze({
        kind: 'ready' as const,
        scope: snapshot.scope,
        address: snapshot.address,
        team: snapshot.data,
        refreshing: snapshot.status === 'refreshing' || snapshot.status === 'loading',
        // Invalidation withdraws mutation authority before revalidation, but is not a failed
        // read. Only an actual failed refresh warrants the last-known-data warning.
        stale: snapshot.stale && snapshot.error !== null,
        lastObservedAt: snapshot.lastObservedAt,
        mutationsAvailable: credentialBound && !snapshot.stale && snapshot.reachability === 'reachable',
        archived: snapshot.data.archivedAt !== null,
        error: snapshot.error,
    });
}
