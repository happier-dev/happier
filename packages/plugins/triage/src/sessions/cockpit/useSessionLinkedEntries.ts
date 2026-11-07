import * as React from 'react';
import { useLivePluginResourceProjection, usePluginUiEphemeralSharedScope, useSurfaceContext, type PluginUiResourceProjectionSnapshot } from '@happier-dev/plugin-ui';

import { useTriageListWindow } from '../../ui/window/useTriageListWindow.js';
import { resolveTriageSourceWorkflowSubjectV1 } from '../../ui/detail/sourceSurface.js';
import type { TriageReadSourceSessionLinksResultV1, TriageSourceSessionLinksLaneV1 } from '../../actions/sessionLinksProtocol.js';
import { TRIAGE_SESSION_LINKS_RESOURCE_LOCAL_ID_V1 } from '../sessionLinksResource.js';
import { TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1 } from '../sessionLinksResourceProjection.js';
import { projectTriageSessionLinkedEntries, type TriageSessionLinkedEntriesViewV1 } from './linkedEntryRows.js';
import type { TriageSessionLinkedEntrySummaryBaselineV1 } from './linkedEntrySummary.js';

export type TriageSessionLinkedEntriesV1 = Readonly<{
    view: TriageSessionLinkedEntriesViewV1;
    /** Current admitted coverage, independent of whether any links exist. */
    sourceHealth: readonly TriageSourceSessionLinksLaneV1[] | undefined;
    refresh: () => Promise<void>;
    loadMore: () => Promise<void>;
}>;

const noMoreLinks = async (): Promise<void> => {};
const selectRelationSnapshot = (snapshot: PluginUiResourceProjectionSnapshot<TriageReadSourceSessionLinksResultV1>) => snapshot;

/**
 * The Session-scoped Resource is shared by the cockpit and its picker. Its
 * Account Action owns source/corpus selection and paging; qualified Action
 * dependencies keep it live without another raw corpus reader in the UI.
 */
export function useTriageSessionLinkedEntries(sessionId: string): TriageSessionLinkedEntriesV1 {
    const owner = usePluginUiEphemeralSharedScope();
    const summaryScope = React.useRef<{
        owner: typeof owner;
        sessionId: string;
        rows: TriageSessionLinkedEntrySummaryBaselineV1;
        view?: TriageSessionLinkedEntriesViewV1;
    }>({ owner, sessionId, rows: new Map() });
    if (summaryScope.current.owner !== owner || summaryScope.current.sessionId !== sessionId) {
        summaryScope.current = { owner, sessionId, rows: new Map() };
    }
    const window = useTriageListWindow();
    const { targetedContributions } = useSurfaceContext();
    const { value: resource, refresh } = useLivePluginResourceProjection(
        TRIAGE_SESSION_LINKS_RESOURCE_LOCAL_ID_V1, TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1, selectRelationSnapshot,
    );
    const admitted = React.useMemo(() => {
        if (resource.value === undefined) return null;
        return resource.value.links.every(link => link.sessionId === sessionId) ? resource.value : null;
    }, [resource.value, sessionId]);
    const view = React.useMemo(() => {
        const projected = projectTriageSessionLinkedEntries({
            links: admitted?.links ?? [],
            status: resource.error !== undefined || (resource.value !== undefined && admitted === null) ? 'failed'
                : admitted === null ? 'loading'
                    : resource.pending !== 'idle' ? 'loading'
                        : admitted.kind === 'complete' ? 'ready' : admitted.kind,
            lanes: admitted?.lanes,
            error: resource.error,
            entries: window.snapshot.window?.rows,
            workflowSubject: entryRef => resolveTriageSourceWorkflowSubjectV1(targetedContributions, entryRef),
            summaryBaseline: summaryScope.current.rows,
            previous: summaryScope.current.view,
        });
        summaryScope.current.view = projected;
        return projected;
    }, [admitted, owner, sessionId, resource.error, resource.pending, resource.value, targetedContributions, window.snapshot.window?.rows]);

    // Every selected corpus page is already included by the relation owner.
    const sourceHealth = resource.error === undefined && resource.pending === 'idle' ? admitted?.lanes : undefined;
    return React.useMemo(() => ({ view, sourceHealth, refresh, loadMore: noMoreLinks }), [view, sourceHealth, refresh]);
}
