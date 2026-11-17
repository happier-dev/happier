import * as React from 'react';
import type { WorkflowTriggerAddRequestV1, WorkflowTriggerUpdateRequestV1, SessionTriggerPullRequestLinksV1, WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1 } from '@happier-dev/channels-protocol/v1';
import { isPluginError } from '@happier-dev/plugin-sdk';

import { getStorage, useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { observeCurrentUiContextContributedAction } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import {
    addWorkflowTrigger,
    updateWorkflowTrigger,
    removeWorkflowTrigger,
    type WorkflowTriggerWriteResult,
} from '@/sync/domains/workflows/workflowTriggerActions';
import { readMachineControlTargetForSession, resolveMachineControlTargetForSessionFromState } from '@/sync/ops/sessionMachineTarget';
import { useWorkflowTriggerSets } from './useWorkflowTriggerSets';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';

const ACCOUNT_TRIGGERS = { scope: 'account_all' } as const;

export type SessionTriggersRead = Readonly<{
    status: 'loading' | 'ready' | 'failed';
    observationFailure: Readonly<{ code: string; phase: 'observe'; retryable: boolean }> | null;
    /** The last sets the owner returned; kept while a refresh or a failed read is pending. */
    sets: readonly WorkflowTriggerSetV1[];
    /** The session's Machine, used for native capability observations and Action options. */
    machineId: string | null;
    pullRequestLinks: SessionTriggerPullRequestLinksV1 | Readonly<{ status: 'loading' }>;
    retry: () => void;
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
    // Info can mount from an admitted list row without hydrating Session detail.
    // These Account reads need only the Session id and the Account lifetime.
    const sessionMachineId = getStorage()((state) => resolveMachineControlTargetForSessionFromState(state, sessionId)?.machineId ?? null);
    const scope = accountLifetime?.scope ?? null;
    const linkScopeKey = scope ? serverAccountScopedResourceKey(scope, sessionId) : null;
    const context = React.useMemo(() => sessionMachineId
        ? { externalActionTarget: { kind: 'machine' as const, machineId: sessionMachineId } } : undefined, [sessionMachineId]);
    const sessionRead = useWorkflowTriggerSets({ lifetimeSession: { sessionId } }, undefined, { demanded, context });
    const sets = sessionRead.sets;
    const [observerAttempt, setObserverAttempt] = React.useState(0);
    // Retained for the existing Writes here projection until selected reads supply destination attachments.
    const accountRead = useWorkflowTriggerSets(ACCOUNT_TRIGGERS, undefined, { demanded });
    const [observerFailure, setObserverFailure] = React.useState<Readonly<{
        scopeKey: string; failure: NonNullable<SessionTriggersRead['observationFailure']>;
    }> | null>(null);
    const options = React.useCallback((scopeSessionId = sessionId) => {
        const machineId = readMachineControlTargetForSession(scopeSessionId)?.machineId;
        return machineId ? { context: { externalActionTarget: { kind: 'machine' as const, machineId } } } : {};
    }, [sessionId]);

    React.useEffect(() => {
        if (!demanded) return;
        if (linkScopeKey === null) return;
        if (!accountLifetime) return;
        const controller = new AbortController();
        const retirement = accountLifetime.onRetire(() => controller.abort());
        const observer = observeCurrentUiContextContributedAction({
            action: { pluginId: 'happier.channels', localId: SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1 },
            input: { kind: 'get', sessionId }, defaultSessionId: sessionId, signal: controller.signal,
            isCurrent: () => !controller.signal.aborted && accountLifetime.isCurrent(),
            invalidate: sessionRead.retry,
        }, { execute: createFrontDoorActionExecute(), context: {
            surface: 'ui', serverId: accountLifetime.scope.serverId,
            expectedAccountId: accountLifetime.scope.accountId, defaultSessionId: sessionId, signal: controller.signal,
        } });
        // A failed dependency attachment does not discard the independently
        // readable trigger sets. Retry reattaches through the same public owner.
        void observer.then(() => {
            if (!controller.signal.aborted && accountLifetime.isCurrent()) {
                setObserverFailure(null);
            }
        }, (error: unknown) => {
            if (controller.signal.aborted || !accountLifetime.isCurrent()) return;
            setObserverFailure({ scopeKey: linkScopeKey, failure: {
                code: isPluginError(error) ? error.code : 'internal_error', phase: 'observe',
                retryable: isPluginError(error) && error.retryable === true,
            } });
        });
        return () => {
            controller.abort(); retirement.dispose();
            void observer.then(subscription => subscription.dispose()).catch(() => {});
        };
    }, [accountLifetime, demanded, observerAttempt, linkScopeKey, sessionId, sessionRead.retry]);

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
    const retry = React.useCallback(() => {
        sessionRead.retry(); setObserverAttempt(value => value + 1); accountRead.retry();
    }, [sessionRead.retry, accountRead.retry]);

    const observationFailure = observerFailure?.scopeKey === linkScopeKey ? observerFailure.failure : null;
    return {
        observationFailure,
        machineId: sessionMachineId,
        pullRequestLinks: sessionRead.pullRequestLinks ?? { status: 'loading' },
        status: linkScopeKey === null ? 'loading' : accountRead.status,
        sets,
        retry,
        add,
        update,
        remove,
    };
}
