import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import {
    subscribeHomeAccountChange,
    type HomeAccountChangeEvent,
} from '@/sync/runtime/orchestration/homeAccountChange';

function accountChangeAffectsWorkflowRunList(event: HomeAccountChangeEvent, runId?: string, source: 'workflow' | 'automation' = 'workflow'): boolean {
    return event.entityIds === undefined
        || event.entityIds.some((entityId) => runId === undefined
            ? entityId.startsWith(source === 'automation' ? 'automation:' : 'workflow-run:')
            : entityId === `workflow-run:${runId}`);
}

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
    /** Exact source whose live grants determine this demanded Run's access. */
    sourceArtifactId?: string | null;
    source?: 'workflow' | 'automation';
    isVisibleWindowLoaded: () => boolean;
    invalidate: (options: Readonly<{ summaryCurrent: boolean }>) => void;
}>): () => void {
    const unsubscribe = subscribeHomeAccountChange((event) => {
        if (!params.lifetime.isCurrent()) return;
        if (!areServerProfileIdentifiersEquivalent(event.serverId, params.lifetime.scope.serverId)) return;
        // Grant changes publish the source Artifact, and membership changes publish
        // Teams; neither needs to mutate the Run or advance its revision.
        const accessChanged = (params.source ?? 'workflow') === 'workflow'
            && (params.runId === undefined || params.sourceArtifactId != null)
            && (event.entityIds?.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1) === true
                || event.changeKinds?.includes('artifact') === true
                    && (params.runId === undefined || typeof params.sourceArtifactId === 'string'
                        && event.entityIds?.includes(params.sourceArtifactId) === true));
        if (!accessChanged && params.runIds && event.entityIds !== undefined && event.source !== 'connected'
            && !params.runIds.some(runId => event.entityIds?.includes(`workflow-run:${runId}`))) return;
        if (!accessChanged && !accountChangeAffectsWorkflowRunList(event, params.runId, params.source)) return;
        if (!params.isVisibleWindowLoaded()) return;
        params.invalidate({ summaryCurrent: !accessChanged && event.workflowRunsMaterialized === true });
    }, { reconnect: 'refresh' });
    const retirement = params.lifetime.onRetire(unsubscribe);
    return () => {
        retirement.dispose();
        unsubscribe();
    };
}
