import * as React from 'react';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useSessionListRowSelector, useSessionSelector } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

import { useSessionMessageViewerScope } from './useSessionMessageViewerScope';

export type SessionMessageAuthorshipScope = Readonly<{
    /** The Account whose messages read as "You", resolved for the exact Home. */
    viewerScope: ServerAccountScope | null;
    /** Whether this Session's audience contains another named human Account. */
    hasOtherNamedCollaborator: boolean;
}>;

/**
 * The one owner of the two facts every transcript authorship byline needs.
 *
 * Both are Home-qualified: raw Session IDs repeat across Homes, so resolving
 * either from the active Home can name the wrong viewer ("You" versus a
 * colleague) or suppress the byline entirely because the *other* Home's Session
 * happens to be solo. Committed messages and the pending/discarded queue both
 * consume this owner so they cannot disagree about authorship for one row that
 * crosses over from pending to committed.
 *
 * `sessionServerId` is the exact Home carried by the mounted transcript host.
 * When it is absent the resolution keeps its historical active-Home behavior
 * rather than guessing a Home.
 */
export function useSessionMessageAuthorshipScope(
    sessionId: string,
    sessionServerId?: string | null,
): SessionMessageAuthorshipScope {
    const exactSessionServerId = sessionServerId?.trim() || null;
    // Subscribe to the fact itself: Session records and list rows change on every turn write.
    const rowHasOtherNamedCollaborator = useSessionListRowSelector(exactSessionServerId, sessionId,
        (row) => row ? row.hasOtherNamedCollaborator === true : null);
    const sessionHasOtherNamedCollaborator = useSessionSelector(sessionId, sessionServerId, (session) => (
        session !== null
        && (!exactSessionServerId || areServerProfileIdentifiersEquivalent(session.serverId, exactSessionServerId))
        && session.hasOtherNamedCollaborator === true
    ));
    const viewerScope = useSessionMessageViewerScope(sessionId, sessionServerId);
    const hasOtherNamedCollaborator = rowHasOtherNamedCollaborator ?? sessionHasOtherNamedCollaborator;
    return React.useMemo(
        () => ({ viewerScope, hasOtherNamedCollaborator }),
        [hasOtherNamedCollaborator, viewerScope],
    );
}
