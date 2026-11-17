import * as React from 'react';
import { SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1 } from '@happier-dev/channels-protocol/v1';
import { isPluginError } from '@happier-dev/plugin-sdk';
import type { SessionTriggerPullRequestLinksV1, WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { getStorage, useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { observeCurrentUiContextContributedAction } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { resolveMachineControlTargetForSessionFromState } from '@/sync/ops/sessionMachineTarget';
import { projectSessionWorkflowTriggerSets } from '@/sync/domains/workflows/workflowTriggerSession';
import { useWorkflowTriggerSets } from './useWorkflowTriggerSets';

const ACCOUNT_TRIGGERS = { scope: 'account_all' } as const;
const LOADING_LINKS = { status: 'loading' } as const;

export type SessionWorkflowContextRead = Readonly<{
    /** The admitted Session-lifetime page and its independently available Channels metadata. */
    read: ReturnType<typeof useWorkflowTriggerSets>;
    /** Lifetime rows and Account-lifetime Automations whose accepted graph writes here. */
    sets: readonly WorkflowTriggerSetV1[];
    /** The Account census establishes destination coverage; either read's failure stays actionable. */
    status: 'loading' | 'ready' | 'failed';
    machineId: string | null;
    pullRequestLinks: SessionTriggerPullRequestLinksV1 | Readonly<{ status: 'loading' }>;
    observationFailure: Readonly<{ code: string; phase: 'observe'; retryable: boolean }> | null;
    retry(): void;
}>;

/** Session lifetime, accepted Account destinations and Channels context share the existing owners. */
export function useSessionWorkflowContext(sessionId: string | null, options: Readonly<{
    demanded: boolean;
    accountLifetime?: ServerAccountScopeLifetime | null;
}>): SessionWorkflowContextRead {
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = options.accountLifetime === undefined ? activeLifetime : options.accountLifetime;
    const machineId = getStorage()((state) => sessionId === null || lifetime === null ? null
        : resolveMachineControlTargetForSessionFromState(state, { ...lifetime.scope, sessionId })?.machineId ?? null);
    const context = React.useMemo(() => machineId
        ? { externalActionTarget: { kind: 'machine' as const, machineId } } : undefined, [machineId]);
    const read = useWorkflowTriggerSets(sessionId === null ? null : { lifetimeSession: { sessionId } },
        options.accountLifetime, { demanded: options.demanded, context });
    // Account-lifetime schedules can write here without watching this Session.
    const accountRead = useWorkflowTriggerSets(sessionId === null ? null : ACCOUNT_TRIGGERS,
        options.accountLifetime, { demanded: options.demanded });
    const sets = React.useMemo(() => sessionId === null ? read.sets
        : projectSessionWorkflowTriggerSets(sessionId, read.sets, accountRead.sets), [sessionId, read.sets, accountRead.sets]);
    const scopeKey = lifetime && sessionId !== null ? serverAccountScopedResourceKey(lifetime.scope, sessionId) : null;
    const [attempt, setAttempt] = React.useState(0);
    const [failure, setFailure] = React.useState<Readonly<{ scopeKey: string;
        value: Readonly<{ code: string; phase: 'observe'; retryable: boolean }> }> | null>(null);
    React.useEffect(() => {
        if (!options.demanded || !lifetime || sessionId === null || scopeKey === null) return;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        const observer = observeCurrentUiContextContributedAction({
            action: { pluginId: 'happier.channels', localId: SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1 },
            input: { kind: 'get', sessionId }, defaultSessionId: sessionId, signal: controller.signal,
            isCurrent: () => !controller.signal.aborted && lifetime.isCurrent(), invalidate: read.retry,
        }, { execute: createFrontDoorActionExecute(), context: {
            surface: 'ui', serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
            defaultSessionId: sessionId, signal: controller.signal,
        } });
        void observer.then(() => {
            if (!controller.signal.aborted && lifetime.isCurrent()) setFailure(null);
        }, (error: unknown) => {
            if (controller.signal.aborted || !lifetime.isCurrent()) return;
            setFailure({ scopeKey, value: { code: isPluginError(error) ? error.code : 'internal_error', phase: 'observe',
                retryable: isPluginError(error) && error.retryable === true } });
        });
        return () => {
            controller.abort(); retirement.dispose();
            void observer.then(subscription => subscription.dispose()).catch(() => {});
        };
    }, [lifetime, options.demanded, sessionId, scopeKey, attempt, read.retry]);
    const retry = React.useCallback(() => { read.retry(); accountRead.retry(); setAttempt(value => value + 1); }, [read.retry, accountRead.retry]);
    const status = read.status === 'failed' ? 'failed' : accountRead.status;
    return { read, sets, status: lifetime === null ? 'loading' as const : status,
        machineId, pullRequestLinks: read.pullRequestLinks ?? LOADING_LINKS, retry,
        observationFailure: failure?.scopeKey === scopeKey ? failure.value : null };
}
