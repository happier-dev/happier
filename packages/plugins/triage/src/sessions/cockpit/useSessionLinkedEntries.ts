import * as React from 'react';
import { useLivePluginResourceProjection, usePluginHostApi, usePluginSurfaceActivity, usePluginUiEphemeralSharedScope, useSurfaceContext, type PluginUiResourceProjectionSnapshot } from '@happier-dev/plugin-ui';

import { triageEntryRowKey, type TriageListRowV1 } from '../../projection/listWindow.js';
import { useTriageListWindow } from '../../ui/window/useTriageListWindow.js';
import { deriveTriageDetailMountInstanceKey } from '../../ui/detail/mountKey.js';
import { reobserveTriagePostMutationRow } from '../../ui/detail/postMutationReobservation.js';
import { resolveTriageSourceDescriptorV1, resolveTriageSourceWorkflowSubjectV1 } from '../../ui/detail/sourceSurface.js';
import type { TriageSourceSessionLinksLaneV1 } from '../../actions/sessionLinksProtocol.js';
import { TRIAGE_SESSION_LINKS_RESOURCE_LOCAL_ID_V1, type decodeTriageSessionLinksResource } from '../sessionLinksResource.js';
import { TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1 } from '../sessionLinksResourceProjection.js';
import { projectTriageSessionLinkedEntries, type TriageSessionLinkedEntriesViewV1 } from './linkedEntryRows.js';
import type { TriageSessionLinkedEntrySummaryBaselineV1 } from './linkedEntrySummary.js';

export type TriageSessionLinkedEntriesV1 = Readonly<{
    view: TriageSessionLinkedEntriesViewV1;
    /** Current admitted coverage, independent of whether any links exist. */
    sourceHealth: readonly TriageSourceSessionLinksLaneV1[] | undefined;
    refresh: () => Promise<void>;
    refreshRevision: number;
    loadMore: () => Promise<void>;
}>;

const noMoreLinks = async (): Promise<void> => {};
const selectRelationSnapshot = (snapshot: PluginUiResourceProjectionSnapshot<ReturnType<typeof decodeTriageSessionLinksResource>>) => snapshot;

/**
 * The Session-scoped Resource is shared by the cockpit and its picker. Its
 * Account Action owns source/corpus selection and paging; qualified Action
 * dependencies keep it live without another raw corpus reader in the UI.
 */
export function useTriageSessionLinkedEntries(sessionId: string, resolveEntries = false): TriageSessionLinkedEntriesV1 {
    const owner = usePluginUiEphemeralSharedScope();
    const host = usePluginHostApi();
    const { active } = usePluginSurfaceActivity();
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
    const { value: resource, refresh: refreshRelation } = useLivePluginResourceProjection(
        TRIAGE_SESSION_LINKS_RESOURCE_LOCAL_ID_V1, TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1, selectRelationSnapshot,
    );
    const admitted = React.useMemo(() => {
        if (resource.value === undefined) return null;
        return resource.value.links.every(link => link.sessionId === sessionId)
            && !resource.value.channels?.links.some(link => link.sessionId !== sessionId) ? resource.value : null;
    }, [resource.value, sessionId]);
    const readOwner = window.readOwner;
    const links = admitted?.links;
    const [rowRevision, rowChanged] = React.useReducer(revision => revision + 1, 0);
    React.useLayoutEffect(() => {
        if (links === undefined || readOwner === null) return;
        const stop = links.map(link => readOwner.subscribeRow(triageEntryRowKey(link.entryRef), rowChanged));
        return () => { for (const unsubscribe of stop) unsubscribe(); };
    }, [links, readOwner]);
    // These leases belong to rendered links. Keep them through a detail open
    // and drop them when the link, pane, or host scope leaves.
    type OpeningRead = { controller: AbortController; row?: TriageListRowV1 | null };
    const openingReads = React.useMemo(() => new Map<string, OpeningRead>(), [host, owner, sessionId]);
    const [refreshRevision, refreshRequested] = React.useReducer(revision => revision + 1, 0);
    const refresh = React.useCallback(() => {
        for (const [key, read] of openingReads) {
            if (read.row === null) openingReads.delete(key);
        }
        refreshRequested();
        return refreshRelation();
    }, [openingReads, refreshRelation]);
    const [exactRevision, exactChanged] = React.useReducer(revision => revision + 1, 0);
    React.useEffect(() => () => {
        for (const read of openingReads.values()) read.controller.abort();
        openingReads.clear();
    }, [openingReads]);
    const readMissingEntries = React.useEffectEvent(() => {
        if (!active) return;
        const needed = new Set<string>();
        if (resolveEntries && links !== undefined) {
            for (const { entryRef, sourceInstanceId } of links) {
                if (sourceInstanceId === undefined || readOwner?.getRow(triageEntryRowKey(entryRef)) != null) continue;
                const key = deriveTriageDetailMountInstanceKey(entryRef, sourceInstanceId);
                needed.add(key);
                if (openingReads.has(key)) continue;
                const controller = new AbortController();
                const read: OpeningRead = { controller };
                openingReads.set(key, read);
                const kind = resolveTriageSourceDescriptorV1(targetedContributions, entryRef.source)
                    ?.kinds.find(candidate => candidate.id === entryRef.kindId);
                const lanes = window.snapshot.window?.lanes ?? [];
                void reobserveTriagePostMutationRow(host, { entryRef }, lanes, sourceInstanceId, {
                    sharedScope: owner, linkedRowLifetime: controller.signal,
                    includeTaskFieldChoices: kind?.taskCapabilities?.fieldChoices === true,
                }).then(row => {
                    if (controller.signal.aborted) return;
                    read.row = row;
                    if (row !== null) exactChanged();
                });
            }
        }
        for (const [key, read] of openingReads) {
            if (needed.has(key)) continue;
            read.controller.abort();
            openingReads.delete(key);
        }
    });
    React.useEffect(() => { readMissingEntries(); }, [resolveEntries, active, openingReads, links, readOwner, rowRevision, refreshRevision]);
    const view = React.useMemo(() => {
        // The Session relation names the entries. The list lens only names which ones it is displaying.
        const entries = links?.flatMap(link => {
            const row = readOwner?.getRow(triageEntryRowKey(link.entryRef))
                ?? (link.sourceInstanceId === undefined ? null
                    : openingReads.get(deriveTriageDetailMountInstanceKey(link.entryRef, link.sourceInstanceId))?.row);
            return row == null ? [] : [row];
        });
        const sourceError = admitted?.sourceReadError;
        const pending = resource.pending !== 'idle';
        // The store retains the withdrawal while fresh admission is pending.
        const readError = pending ? undefined : resource.error;
        const projected = projectTriageSessionLinkedEntries({
            links: admitted?.links ?? [],
            nativePullRequests: admitted?.channels?.links,
            readFailureCodes: admitted?.channels?.failures?.map(failure => failure.code),
            status: pending ? 'loading'
                : readError !== undefined || (resource.value !== undefined && admitted === null) ? 'failed'
                    : admitted === null ? 'loading'
                        : admitted.kind === 'complete' ? (admitted.channels?.failures?.length ? 'partial' : 'ready') : admitted.kind,
            lanes: admitted?.lanes,
            error: readError ?? (sourceError === undefined ? undefined : {
                code: sourceError.code, message: sourceError.code, retryable: sourceError.retryable,
                ...(sourceError.requestId === undefined ? {} : { details: { requestId: sourceError.requestId } }),
            }),
            entries,
            workflowSubject: entryRef => resolveTriageSourceWorkflowSubjectV1(targetedContributions, entryRef),
            summaryBaseline: summaryScope.current.rows,
            previous: summaryScope.current.view,
        });
        summaryScope.current.view = projected;
        return projected;
    }, [admitted, owner, sessionId, resource.error, resource.pending, resource.value, targetedContributions, links, readOwner, rowRevision, openingReads, exactRevision]);

    // Every selected corpus page is already included by the relation owner.
    const sourceHealth = resource.error === undefined && resource.pending === 'idle' ? admitted?.lanes : undefined;
    return React.useMemo(() => ({ view, sourceHealth, refresh, refreshRevision, loadMore: noMoreLinks }), [view, sourceHealth, refresh, refreshRevision]);
}
