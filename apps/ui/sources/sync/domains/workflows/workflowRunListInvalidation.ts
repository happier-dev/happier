import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { buildAutomationRunSummaryChangeEntityIdV1, isAccountCurrentnessEntityIdV1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { workflowDefinitionArtifactSharingAdapterV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { homeAccountChangeAffectsArtifactKinds } from '@/sync/runtime/orchestration/changesPlanner';
import {
    subscribeHomeAccountChange,
    type HomeAccountChangeEvent,
} from '@/sync/runtime/orchestration/homeAccountChange';

function accountChangeAffectsWorkflowRunList(event: HomeAccountChangeEvent, runId?: string, source: 'workflow' | 'automation' = 'workflow'): boolean {
    return event.entityIds === undefined
        || (source === 'automation' && event.changeKinds?.includes('automation') === true)
        || event.entityIds.some((entityId) => runId === undefined
            ? entityId.startsWith(source === 'automation' ? 'automation:' : 'workflow-run:')
            : entityId === `workflow-run:${runId}`);
}

export type WorkflowRunListInvalidation = Readonly<{
    summaryCurrent: boolean;
    runIds?: readonly string[];
    sourceArtifactIds?: readonly string[];
}>;

/**
 * Observe the incumbent Home Account-change wake for a visible Runs window
 * or one demanded exact Run. Invocation-only writes use this same wake.
 *
 * This does not interpret Run state or own synchronization: the existing list
 * query remains authoritative for filter membership, including attention.
 */
export function subscribeVisibleWorkflowRunListInvalidation(params: Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    runId?: string;
    runIds?: readonly string[];
    occurrence?: Readonly<{ automationId: string; readNotCurrent: () => boolean }>;
    /** Exact source whose live grants determine this demanded Run's access. */
    sourceArtifactId?: string | null;
    /** Sources currently demanded by the query owner, including exact Run-set windows. */
    sourceArtifactIds?: () => readonly string[];
    /** List queries can discover Runs from newly granted sources, even in an empty window. */
    discoverSourceArtifacts?: boolean;
    source?: 'workflow' | 'automation';
    isVisibleWindowLoaded: () => boolean;
    /**
     * Run rows and their access facts are in the changes feed, so a primary-Home reconnect's
     * catch-up publishes each Run that changed while away. A reader that reports its read state
     * hears the reconnect only as a retry while its last read did not succeed; a reader without
     * one re-reads on every reconnect.
     */
    readNotCurrent?: () => boolean;
    invalidate: (options: WorkflowRunListInvalidation) => void;
}>): () => void {
    const readNotCurrent = params.occurrence?.readNotCurrent ?? params.readNotCurrent;
    const unsubscribe = subscribeHomeAccountChange((event) => {
        if (!params.lifetime.isCurrent()) return;
        if (!areServerProfileIdentifiersEquivalent(event.serverId, params.lifetime.scope.serverId)) return;
        // Grant changes publish the source Artifact, and membership changes publish
        // Teams; neither needs to mutate the Run or advance its revision.
        const teamsChanged = event.entityIds?.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1) === true;
        const hasArtifactChanges = event.changeKinds?.includes('artifact') === true;
        const demandedSources = hasArtifactChanges || teamsChanged
            ? params.sourceArtifactIds?.() ?? (params.sourceArtifactId ? [params.sourceArtifactId] : [])
            : [];
        const changedSources = hasArtifactChanges ? [...new Set([
            ...demandedSources.filter(id => event.entityIds?.includes(id)),
            ...(params.discoverSourceArtifacts === true && homeAccountChangeAffectsArtifactKinds(event,
                [workflowDefinitionArtifactSharingAdapterV1.kind]) ? event.changedWorkflowDefinitionIds ?? [] : []),
        ])] : [];
        const accessChanged = (params.source ?? 'workflow') === 'workflow'
            && (changedSources.length > 0 || (teamsChanged && (params.runId === undefined || demandedSources.length > 0)));
        if (!accessChanged && params.runIds && event.entityIds !== undefined && event.source !== 'connected'
            && !params.runIds.some(runId => event.entityIds?.includes(`workflow-run:${runId}`))) return;
        const occurrence = params.occurrence;
        const occurrenceChanged = occurrence !== undefined && params.runId !== undefined && event.entityIds?.some(id =>
            // The old coalescing key is still readable from retained change feeds.
            id === buildAutomationRunSummaryChangeEntityIdV1(occurrence.automationId, params.runId)
            || id === buildAutomationRunSummaryChangeEntityIdV1(occurrence.automationId)
            // Clearing history or deleting the Automation can remove this occurrence.
            || (id === occurrence.automationId && event.changeKinds?.includes('automation') === true)
            || isAccountCurrentnessEntityIdV1(id)) === true;
        if (!accessChanged && !occurrenceChanged && !accountChangeAffectsWorkflowRunList(event, params.runId, params.source)) return;
        if (!params.isVisibleWindowLoaded()) return;
        const runIds = !accessChanged && event.entityIds !== undefined && event.source !== 'connected'
            ? event.entityIds.filter(id => id.startsWith('workflow-run:')).map(id => id.slice('workflow-run:'.length))
                .filter(id => params.runId === undefined || params.runId === id)
                .filter(id => params.runIds === undefined || params.runIds.includes(id)) : undefined;
        params.invalidate({ summaryCurrent: !accessChanged && event.workflowRunsMaterialized === true,
            ...(runIds?.length ? { runIds } : {}),
            ...(changedSources.length ? { sourceArtifactIds: changedSources } : {}),
        });
    }, { reconnect: readNotCurrent ? { readNotCurrent } : 'refresh' });
    const retirement = params.lifetime.onRetire(unsubscribe);
    return () => {
        retirement.dispose();
        unsubscribe();
    };
}
