import * as React from 'react';
import type { WorkflowTriggerListRequestV1, WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import { getStorage, useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { serverAccountScopeKeySuffix, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { applyWorkflowTriggerSnapshotReceipt, createWorkflowTriggerChangeSelector, createWorkflowTriggerSetSelector, EMPTY_WORKFLOW_TRIGGER_CHANGE_SIGNAL } from '@/sync/store/domains/automations';
import { listWorkflowTriggerSets } from '@/sync/domains/workflows/workflowTriggerActions';
import { workflowTriggerQueryKey, workflowTriggerRequestForQueryKey } from '@/sync/domains/workflows/workflowTriggerQuery';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveHomeSettling } from '@/components/navigation/connectionStatus/HomeReachabilityGate';

const EMPTY_SETS: readonly WorkflowTriggerSetV1[] = [];

/** Read lifecycle only; the existing Account Automation projection remains the row owner. */
export function useWorkflowTriggerSets(request: WorkflowTriggerListRequestV1 | null, accountLifetime?: ServerAccountScopeLifetime | null): {
    sets: readonly WorkflowTriggerSetV1[];
    status: 'loading' | 'ready' | 'failed';
    retry: () => void;
    acknowledge: (written: WorkflowTriggerSetV1) => void;
} {
    const addressed = accountLifetime !== undefined;
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = addressed ? accountLifetime ?? null : activeLifetime;
    const scope = lifetime?.scope ?? null;
    const scopeKey = scope ? serverAccountScopeKeySuffix(scope) : null;
    const workflow = request && 'workflow' in request ? request.workflow : null;
    const requestedScope = request && 'scope' in request ? request.scope : 'account_inline';
    const queryKey = request === null ? '' : workflowTriggerQueryKey(request);
    // Addressed reads for the focused Account share its canonical Automation
    // projection, including local Action receipts before a socket wake arrives.
    const focused = !addressed || Boolean(scope && activeLifetime?.isCurrent()
        && activeLifetime.scope.accountId === scope.accountId
        && areServerProfileIdentifiersEquivalent(activeLifetime.scope.serverId, scope.serverId));
    // The semantic query, not a caller's object allocation, owns the read lifetime.
    const readRequest = React.useMemo(() => workflowTriggerRequestForQueryKey(queryKey), [queryKey]);
    const identity = React.useMemo(() => ({}), [queryKey, scopeKey, lifetime]);
    const committedIdentity = React.useRef(identity);
    React.useLayoutEffect(() => { committedIdentity.current = identity; }, [identity]);
    const selector = React.useMemo(() => focused ? createWorkflowTriggerSetSelector(queryKey, workflow !== null)
        : () => EMPTY_SETS, [focused, queryKey, workflow]);
    const sets = getStorage()(selector);
    const changeSelector = React.useMemo(() => !focused || queryKey === '' ? () => EMPTY_WORKFLOW_TRIGGER_CHANGE_SIGNAL
        : createWorkflowTriggerChangeSelector(null, workflow, requestedScope,
            readRequest && 'managedTarget' in readRequest ? readRequest.managedTarget : undefined),
        [focused, queryKey, workflow, requestedScope, readRequest]);
    const changeSignal = getStorage()(changeSelector);
    const [state, setState] = React.useState<{ identity: object; status: 'loading' | 'ready' | 'failed' }>(
        () => ({ identity, status: request === null ? 'ready' : 'loading' }),
    );
    const snapshot = React.useRef<Readonly<{ identity: object; sets: readonly WorkflowTriggerSetV1[] }> | null>(null);
    const pendingRead = React.useRef<Readonly<{ identity: object; controller: AbortController }> | null>(null);
    const acknowledge = React.useCallback((written: WorkflowTriggerSetV1) => {
        if (!addressed || queryKey === '' || committedIdentity.current !== identity || !lifetime?.isCurrent()) return;
        const previous = snapshot.current?.identity === identity ? snapshot.current.sets : EMPTY_SETS;
        const next = applyWorkflowTriggerSnapshotReceipt(previous, queryKey, written);
        if (next === null) return;
        // This consumer's pending answer predates the receipt. Shared readers keep
        // their transport; this read must not replace its acknowledgement with it.
        if (pendingRead.current?.identity === identity) pendingRead.current.controller.abort();
        snapshot.current = { identity, sets: next };
        setState(current => next === previous && current.identity === identity && current.status === 'ready'
            ? current : { identity, status: 'ready' });
    }, [addressed, identity, lifetime, queryKey]);
    React.useLayoutEffect(() => {
        // When focus moves, retain this Account's last committed projection, including
        // local write receipts. The earlier HTTP answer must not replace that view.
        if (addressed && focused && state.identity === identity && lifetime?.isCurrent()) {
            snapshot.current = { identity, sets };
        }
    }, [addressed, focused, identity, lifetime, sets, state]);
    const [attempt, setAttempt] = React.useState(0);
    const readNotCurrent = React.useRef(false);
    readNotCurrent.current = state.identity !== identity || state.status !== 'ready';
    React.useEffect(() => !accountLifetime ? undefined : subscribeHomeAccountChange(event => {
        if (!areServerProfileIdentifiersEquivalent(event.serverId, accountLifetime.scope.serverId)) return;
        // Consume the producer's admitted source/definition decision, including mixed pages.
        if (event.workflowTriggersAffect === false) return;
        setAttempt(value => value + 1);
    }, { reconnect: { readNotCurrent: () => readNotCurrent.current } }), [accountLifetime]);
    React.useEffect(() => {
        if (readRequest === null || (addressed && !accountLifetime?.isCurrent())) return;
        // No Account scope yet is not a failed read: right after sign-in the page mounts before its Account
        // is established. The lifetime is a dependency, so the read starts, and settles, once it arrives.
        if (!lifetime) {
            setState(current => current.identity === identity ? current : { identity, status: 'loading' });
            return;
        }
        const controller = new AbortController();
        const pending = { identity, controller };
        pendingRead.current = pending;
        const retirement = lifetime.onRetire(() => { controller.abort(); setState({ identity, status: 'failed' }); });
        // A settled read keeps its answer while it refreshes (a change signal or a retry after
        // success): the store still holds the last-known sets, so nothing reverts to loading.
        setState((current) => current.identity === identity
            ? current.status === 'ready' ? current : { ...current, status: 'loading' }
            : { identity, status: 'loading' });
        listWorkflowTriggerSets(readRequest, { signal: controller.signal,
            ...(addressed ? { accountLifetime } : {}) }).then(result => {
            if (!controller.signal.aborted && lifetime.isCurrent()) {
                if (addressed) snapshot.current = { identity, sets: result };
                setState({ identity, status: 'ready' });
            }
        }).catch(() => {
            if (!controller.signal.aborted && lifetime.isCurrent()) setState(current => ({
                ...(current.identity === identity ? current : {}), identity, status: 'failed',
            }));
        });
        return () => {
            controller.abort(); retirement.dispose();
            if (pendingRead.current === pending) pendingRead.current = null;
        };
    }, [attempt, changeSignal, identity, readRequest, addressed, accountLifetime, lifetime]);
    const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
    // A settled failure stays actionable even while realtime reconnects. Home recovery
    // still retries the read automatically without turning its failed answer into loading.
    const homeSettling = useActiveHomeSettling() && !addressed;
    const failedRef = React.useRef(false);
    failedRef.current = state.identity === identity && state.status === 'failed';
    const wasSettling = React.useRef(false);
    React.useEffect(() => {
        if (wasSettling.current && !homeSettling && failedRef.current) setAttempt((value) => value + 1);
        wasSettling.current = homeSettling;
    }, [homeSettling]);
    const status = state.identity !== identity ? 'loading' as const : state.status;
    return { sets: request === null ? EMPTY_SETS : addressed ? state.identity === identity && accountLifetime?.isCurrent()
        ? focused ? sets : snapshot.current?.identity === identity ? snapshot.current.sets : EMPTY_SETS
        : EMPTY_SETS : sets, status: request === null ? 'ready' as const : status, retry, acknowledge };
}
