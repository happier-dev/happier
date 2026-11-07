import { useEffect, useMemo, useRef } from 'react';
import { usePluginHostApi, usePluginUiEphemeralSharedScope, useSurfaceContext } from '@happier-dev/plugin-ui';

import { TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
import { projectTriageListWindow } from '../../ui/window/mountedWindow.js';
import { useTriageListWindow } from '../../ui/window/useTriageListWindow.js';
import { useTriageListWindowViewDemand } from '../../ui/window/useTriageListWindowViewDemand.js';
import { resolveTriageSourceWorkflowSubjectV1 } from '../../ui/detail/sourceSurface.js';
import { useTriageSessionLinkedEntries } from './useSessionLinkedEntries.js';
import type { TriageSessionLinkedEntrySummaryBaselineV1 } from './linkedEntrySummary.js';
import type { TriageSourceSessionLinksLaneV1 } from '../../actions/sessionLinksProtocol.js';
import {
    hasReadableTriageSessionLinkCoverageV1,
    projectTriageSessionLinkedEntryCandidates,
    type TriageSessionLinkedEntryCandidateV1,
} from './linkedEntrySearch.js';

export { linkTriageSessionEntry } from './linkedEntrySearch.js';

export type TriageSessionLinkCandidatesV1 = Readonly<{
    candidates: readonly TriageSessionLinkedEntryCandidateV1[];
    status: 'loading' | 'ready' | 'partial' | 'unavailable';
    /** Named source/instance/kind health for the existing picker presenter. */
    sourceHealth: readonly TriageSourceSessionLinksLaneV1[];
    /** Re-reads the Session's links, the one recovery for a source that could not be read. */
    refresh: () => Promise<void>;
}>;

const NO_CANDIDATES: readonly TriageSessionLinkedEntryCandidateV1[] = Object.freeze([]);
const NO_SOURCE_HEALTH: readonly TriageSourceSessionLinksLaneV1[] = Object.freeze([]);

/**
 * Mount this only while the link picker is open. Search projects the incumbent
 * retained acquisition through its default lens without changing the page's
 * lens. An open picker is a view of that one list window, so it sends the
 * window's own paced view demand: a Session opened before PRs & Issues still
 * gets entries to pick, and a recently read window is not read again (the
 * window owns pacing). Session links are read through their existing Account
 * pager; finish that relation before claiming an entry is not linked,
 * including links beyond page one.
 */
export function useTriageSessionLinkCandidates(
    sessionId: string,
    query: string,
): TriageSessionLinkCandidatesV1 {
    const host = usePluginHostApi();
    const scope = usePluginUiEphemeralSharedScope();
    const summaryScope = useRef<{ scope: typeof scope; rows: TriageSessionLinkedEntrySummaryBaselineV1; candidates?: readonly TriageSessionLinkedEntryCandidateV1[] }>({ scope, rows: new Map() });
    if (summaryScope.current.scope !== scope) summaryScope.current = { scope, rows: new Map() };
    const window = useTriageListWindow();
    const { targetedContributions } = useSurfaceContext();
    const links = useTriageSessionLinkedEntries(sessionId);
    const view = links.view;
    const sourceHealth = links.sourceHealth ?? NO_SOURCE_HEALTH;
    useTriageListWindowViewDemand(true, window.refresh, window.readiness, window.readOwner);

    useEffect(() => {
        if (view.kind === 'linked' && view.more && view.notice === null) {
            void links.loadMore();
        }
    }, [links.loadMore, view]);

    return useMemo(() => {
        const entries = projectTriageListWindow(TRIAGE_LIST_DEFAULT_LENS_V1, host, scope);
        const hasReadableCoverage = sourceHealth.some(hasReadableTriageSessionLinkCoverageV1);
        const partial = sourceHealth.some(lane => lane.health.kind !== 'complete' || lane.kindIds === undefined);
        const readingLinks = view.kind === 'loading'
            || (view.kind === 'linked' && (view.more || view.rows.some((row) => row.presentation.kind === 'reading')));
        if (readingLinks || (entries === undefined && window.snapshot.pending === 'initial')) {
            return Object.freeze({ candidates: NO_CANDIDATES, status: 'loading', sourceHealth, refresh: links.refresh });
        }
        if ((entries === undefined && window.snapshot.error !== undefined)
            || (!hasReadableCoverage && (view.kind === 'unavailable'
                || (view.kind === 'linked' && (view.notice !== null || view.rows.some((row) => row.presentation.kind === 'unreadable')))))) {
            return Object.freeze({ candidates: NO_CANDIDATES, status: 'unavailable', sourceHealth, refresh: links.refresh });
        }
        // PRs & Issues has read nothing on this mount yet: that is no candidates, not an unreadable link set.
        if (entries === undefined) return Object.freeze({ candidates: NO_CANDIDATES, status: partial ? 'partial' : 'ready', sourceHealth, refresh: links.refresh });
        const linked = view.kind === 'linked' ? view.rows.flatMap((row) => (
            row.presentation.kind === 'linked' ? [row.presentation.entryRef] : []
        )) : [];
        const candidates = projectTriageSessionLinkedEntryCandidates(entries.rows, query, linked,
            (entryRef) => resolveTriageSourceWorkflowSubjectV1(targetedContributions, entryRef), summaryScope.current.rows, summaryScope.current.candidates,
            links.sourceHealth);
        summaryScope.current.candidates = candidates;
        return Object.freeze({
            candidates,
            status: partial ? 'partial' : 'ready',
            sourceHealth,
            refresh: links.refresh,
        });
    }, [host, query, scope, targetedContributions, view, sourceHealth, links.sourceHealth, links.refresh, window.snapshot]);
}
