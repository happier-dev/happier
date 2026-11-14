import type { SessionTriggerListRequestV1, WorkflowTriggerListRequestV1, WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { isWorkflowTriggerSourceGoneV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { readManagedMachineTriggerAction } from '@happier-dev/protocol/actions/executor/workflowTriggerActions';

/** The same identity owns hook demand, list publication and store membership. */
export function workflowTriggerQueryKey(request: WorkflowTriggerListRequestV1 | SessionTriggerListRequestV1): string {
    if ('sessionId' in request) return `session:${request.sessionId}`;
    if ('workflow' in request) return `workflow:${request.workflow}`;
    if ('managedTarget' in request) return `managed:${JSON.stringify([request.managedTarget.homeId, request.managedTarget.managedId])}`;
    if ('scope' in request) return request.scope;
    return '';
}

export function workflowTriggerRequestForQueryKey(queryKey: string): WorkflowTriggerListRequestV1 | null {
    if (queryKey.startsWith('workflow:')) return { workflow: queryKey.slice('workflow:'.length) };
    if (queryKey.startsWith('managed:')) {
        const [homeId, managedId]: [string, string] = JSON.parse(queryKey.slice('managed:'.length));
        return { managedTarget: { homeId, managedId } };
    }
    return queryKey === 'account_all' || queryKey === 'account_inline' || queryKey === 'account_source_unavailable' ? { scope: queryKey } : null;
}

/** Undefined means an unavailable private source supplies no new target authority. */
export function matchesWorkflowTriggerQuery(queryKey: string, set: WorkflowTriggerSetV1 | undefined): boolean | undefined {
    if (queryKey === 'account_source_unavailable') return set !== undefined && !set.scopeSessionId && isWorkflowTriggerSourceGoneV1(set);
    if (queryKey.startsWith('managed:')) {
        if (!set?.target) return undefined;
        const managed = readManagedMachineTriggerAction(set.target);
        return managed !== null && queryKey === workflowTriggerQueryKey({ managedTarget: managed.input });
    }
    if (queryKey !== 'account_inline' && !queryKey.startsWith('workflow:')) return true;
    const target = set?.target;
    return target ? queryKey === (target.kind === 'workflow' ? `workflow:${target.ref}` : 'account_inline') : undefined;
}
