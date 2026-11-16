import * as React from 'react';
import { WorkflowTriggerUpdateRequestV1Schema, type SessionTriggerAddRequestV1, type SessionTriggerUpdateRequestV1, type SessionTriggerPullRequestLinksV1, type WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1 } from '@happier-dev/channels-protocol/v1';
import { isPluginError } from '@happier-dev/plugin-sdk';

import { getStorage, useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { observeCurrentUiContextContributedAction } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createWorkflowTriggerChangeSelector, createWorkflowTriggerSetSelector } from '@/sync/store/domains/automations';
import {
    addSessionTrigger,
    listSessionTriggers,
    removeSessionTrigger,
    updateSessionTrigger,
    updateWorkflowTrigger,
    removeWorkflowTrigger,
    type WorkflowTriggerWriteResult,
} from '@/sync/domains/workflows/workflowTriggerActions';
import { readMachineControlTargetForSession, resolveMachineControlTargetForSessionFromState } from '@/sync/ops/sessionMachineTarget';
import { useWorkflowTriggerSets } from './useWorkflowTriggerSets';

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
    add: (request: Omit<SessionTriggerAddRequestV1, 'sessionId'>) => Promise<WorkflowTriggerWriteResult>;
    update: (request: Omit<SessionTriggerUpdateRequestV1, 'sessionId'>) => Promise<WorkflowTriggerWriteResult>;
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
    const selector = React.useMemo(() => createWorkflowTriggerSetSelector(`session:${sessionId}`), [sessionId]);
    const sets = getStorage()(selector);
    const changeSelector = React.useMemo(() => createWorkflowTriggerChangeSelector(sessionId), [sessionId]);
    const changeSignal = getStorage()(changeSelector);

    const [attempt, setAttempt] = React.useState(0);
    const [observerAttempt, setObserverAttempt] = React.useState(0);
    const accountRead = useWorkflowTriggerSets(ACCOUNT_TRIGGERS, undefined, { demanded });
    const [observerFailure, setObserverFailure] = React.useState<Readonly<{
        scopeKey: string; failure: NonNullable<SessionTriggersRead['observationFailure']>;
    }> | null>(null);
    const [links, setLinks] = React.useState<Readonly<{ scopeKey: string | null; value: SessionTriggersRead['pullRequestLinks'] }>>(
        () => ({ scopeKey: linkScopeKey, value: { status: 'loading' } }),
    );
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
            invalidate: () => setAttempt(value => value + 1),
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
    }, [accountLifetime, demanded, observerAttempt, linkScopeKey, sessionId]);

    React.useEffect(() => {
        if (!demanded) return;
        if (!accountLifetime) return;
        const controller = new AbortController();
        const retirement = accountLifetime.onRetire(() => controller.abort());
        listSessionTriggers({ sessionId }, { ...options(), signal: controller.signal })
            .then((result) => {
                if (!controller.signal.aborted && accountLifetime.isCurrent()) {
                    setLinks({ scopeKey: linkScopeKey, value: result.pullRequestLinks });
                }
            })
            .catch(() => {
                if (!controller.signal.aborted && accountLifetime.isCurrent()) {
                    setLinks({ scopeKey: linkScopeKey, value: { status: 'unavailable', code: 'target_unavailable' } });
                }
            });
        return () => { controller.abort(); retirement.dispose(); };
    }, [accountLifetime, attempt, changeSignal, demanded, linkScopeKey, options, sessionId]);

    const applyWrite = React.useCallback((result: WorkflowTriggerWriteResult) => {
        setAttempt((value) => value + 1);
        return result;
    }, []);

    const add = React.useCallback<SessionTriggersRead['add']>(
        async (request) => applyWrite(await addSessionTrigger({ ...request, sessionId }, options())),
        [applyWrite, options, sessionId],
    );
    const update = React.useCallback<SessionTriggersRead['update']>(
        async (request) => {
            const set = sets.find((set) => set.triggers.some((trigger) => trigger.id === request.triggerId));
            const scopeSessionId = set?.scopeSessionId ?? sessionId;
            return applyWrite(await (set && !set.scopeSessionId
                ? updateWorkflowTrigger(WorkflowTriggerUpdateRequestV1Schema.parse({ ...request, automationId: set.automationId }))
                : updateSessionTrigger({ ...request, sessionId: scopeSessionId }, options(scopeSessionId))));
        },
        [applyWrite, options, sessionId, sets],
    );
    const remove = React.useCallback<SessionTriggersRead['remove']>(
        async (triggerId) => {
            const set = sets.find((set) => set.triggers.some((trigger) => trigger.id === triggerId));
            const scopeSessionId = set?.scopeSessionId ?? sessionId;
            return applyWrite(await (set && !set.scopeSessionId
                ? removeWorkflowTrigger({ automationId: set.automationId, triggerId })
                : removeSessionTrigger({ sessionId: scopeSessionId, triggerId }, options(scopeSessionId))));
        },
        [applyWrite, options, sessionId, sets],
    );
    const retry = React.useCallback(() => {
        setAttempt(value => value + 1); setObserverAttempt(value => value + 1); accountRead.retry();
    }, [accountRead.retry]);

    const observationFailure = observerFailure?.scopeKey === linkScopeKey ? observerFailure.failure : null;
    return {
        observationFailure,
        machineId: sessionMachineId,
        pullRequestLinks: linkScopeKey !== null && links.scopeKey === linkScopeKey ? links.value : { status: 'loading' },
        status: linkScopeKey === null ? 'loading' : accountRead.status,
        sets,
        retry,
        add,
        update,
        remove,
    };
}
