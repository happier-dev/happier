import * as React from 'react';
import type { WorkflowTriggerAddRequestV1, WorkflowTriggerUpdateRequestV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import {
    addWorkflowTrigger,
    updateWorkflowTrigger,
    removeWorkflowTrigger,
    type WorkflowTriggerWriteResult,
} from '@/sync/domains/workflows/workflowTriggerActions';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { useSessionWorkflowContext, type SessionWorkflowContextRead } from './useSessionWorkflowContext';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';

export type SessionTriggersRead = Readonly<Omit<SessionWorkflowContextRead, 'read'> & {
    add: (request: Omit<Exclude<WorkflowTriggerAddRequestV1, { observationOnly: unknown }>, 'lifetimeSession'>) => Promise<WorkflowTriggerWriteResult>;
    update: (request: Omit<WorkflowTriggerUpdateRequestV1, 'automationId'> & Readonly<{ triggerId: string }>) => Promise<WorkflowTriggerWriteResult>;
    remove: (triggerId: string) => Promise<WorkflowTriggerWriteResult>;
}>;

/**
 * Session Habits combine scoped triggers and Account triggers whose accepted graph targets this
 * Session through the shared set selector. Each keeps its existing Action mutation authority;
 * displaying an Account Habit here never changes its scope or execution placement.
 *
 * The Account's Automation projection is only a change signal here: when the session's scoped rows
 * change (an agent added a trigger, a run finished) the list is read again.
 * The shared Run summary reader supplies each row's last started Run and outcome.
 */
export function useSessionTriggers(sessionId: string): SessionTriggersRead {
    const accountLifetime = useActiveServerAccountScopeLifetime();
    const demanded = useLayoutPresentationActive();
    const session = useSessionWorkflowContext(sessionId, { demanded });
    const sessionRead = session.read;
    const sets = session.sets;
    const options = React.useCallback((scopeSessionId = sessionId) => {
        const machineId = readMachineControlTargetForSession(scopeSessionId)?.machineId;
        return machineId ? { context: { externalActionTarget: { kind: 'machine' as const, machineId } } } : {};
    }, [sessionId]);

    const applyWrite = React.useCallback((result: WorkflowTriggerWriteResult) => {
        sessionRead.retry();
        return result;
    }, [sessionRead.retry]);

    const add = React.useCallback<SessionTriggersRead['add']>(
        async (request) => applyWrite(await addWorkflowTrigger({ ...request, lifetimeSession: { sessionId } }, { ...options(), accountLifetime })),
        [accountLifetime, applyWrite, options, sessionId],
    );
    const update = React.useCallback<SessionTriggersRead['update']>(
        async (request) => {
            const set = sets.find((set) => set.triggers.some((trigger) => trigger.id === request.triggerId));
            if (!set) throw new WorkflowActionError({ message: 'source_unavailable', rawCode: 'source_unavailable' });
            return applyWrite(await updateWorkflowTrigger({ ...request, automationId: set.automationId },
                { ...options(set.scopeSessionId ?? sessionId), accountLifetime }));
        },
        [accountLifetime, applyWrite, options, sessionId, sets],
    );
    const remove = React.useCallback<SessionTriggersRead['remove']>(
        async (triggerId) => {
            const set = sets.find((set) => set.triggers.some((trigger) => trigger.id === triggerId));
            if (!set) throw new WorkflowActionError({ message: 'source_unavailable', rawCode: 'source_unavailable' });
            return applyWrite(await removeWorkflowTrigger({ automationId: set.automationId, triggerId },
                { ...options(set.scopeSessionId ?? sessionId), accountLifetime }));
        },
        [accountLifetime, applyWrite, options, sessionId, sets],
    );
    return {
        observationFailure: session.observationFailure,
        machineId: session.machineId,
        pullRequestLinks: session.pullRequestLinks,
        status: session.status,
        sets,
        retry: session.retry,
        add,
        update,
        remove,
    };
}
