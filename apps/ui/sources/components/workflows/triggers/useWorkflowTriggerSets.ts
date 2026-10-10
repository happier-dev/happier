import * as React from 'react';
import type { WorkflowTriggerListRequestV1, WorkflowTriggerSetV1 } from '@happier-dev/protocol';

import { getStorage } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopeKeySuffix, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createWorkflowTriggerChangeSelector, createWorkflowTriggerSetSelector } from '@/sync/store/domains/automations';
import { listWorkflowTriggerSets } from '@/sync/domains/workflows/workflowTriggerActions';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

const EMPTY_SETS: readonly WorkflowTriggerSetV1[] = [];

/** Read lifecycle only; the existing Account Automation projection remains the row owner. */
export function useWorkflowTriggerSets(request: WorkflowTriggerListRequestV1 | null, accountLifetime?: ServerAccountScopeLifetime | null) {
    const addressed = accountLifetime !== undefined;
    const scope = getStorage()(React.useCallback(state => addressed ? accountLifetime?.scope ?? null : state.profileScope ?? null,
        [addressed, accountLifetime]));
    const scopeKey = scope ? serverAccountScopeKeySuffix(scope) : null;
    const workflow = request && 'workflow' in request ? request.workflow : null;
    const requestedScope = request && 'scope' in request ? request.scope : 'account_inline';
    const queryKey = request === null ? '' : workflow ? `workflow:${workflow}` : requestedScope;
    // The semantic query, not a caller's object allocation, owns the read lifetime.
    const readRequest = React.useMemo<WorkflowTriggerListRequestV1 | null>(() => queryKey === '' ? null
        : workflow === null ? { scope: requestedScope } : { workflow }, [queryKey, workflow, requestedScope]);
    const identity = React.useMemo(() => ({}), [queryKey, scopeKey, accountLifetime]);
    const selector = React.useMemo(() => addressed ? () => EMPTY_SETS
        : createWorkflowTriggerSetSelector(queryKey, workflow !== null), [addressed, queryKey, workflow]);
    const sets = getStorage()(selector);
    const changeSelector = React.useMemo(() => addressed || queryKey === '' ? () => ''
        : createWorkflowTriggerChangeSelector(null, workflow, requestedScope === 'account_all'), [addressed, queryKey, workflow, requestedScope]);
    const changeSignal = getStorage()(changeSelector);
    const [state, setState] = React.useState<{ identity: object; status: 'loading' | 'ready' | 'failed'; sets?: readonly WorkflowTriggerSetV1[] }>(
        () => ({ identity, status: request === null ? 'ready' : 'loading' }),
    );
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => !accountLifetime ? undefined : subscribeHomeAccountChange(event => {
        if (areServerProfileIdentifiersEquivalent(event.serverId, accountLifetime.scope.serverId)) setAttempt(value => value + 1);
    }), [accountLifetime]);
    React.useEffect(() => {
        if (readRequest === null || (addressed && !accountLifetime?.isCurrent())) return;
        const controller = new AbortController();
        const lifetime = accountLifetime ?? captureActiveServerAccountScopeCurrentness();
        const retirement = lifetime.onRetire(() => { controller.abort(); setState({ identity, status: 'failed' }); });
        // A settled read keeps its answer while it refreshes (a change signal or a retry after
        // success): the store still holds the last-known sets, so nothing reverts to loading.
        setState((current) => current.identity === identity
            ? current.status === 'ready' ? current : { ...current, status: 'loading' }
            : { identity, status: 'loading' });
        listWorkflowTriggerSets(readRequest, { signal: controller.signal,
            ...(addressed ? { accountLifetime } : {}) }).then(result => {
            if (!controller.signal.aborted && lifetime.isCurrent()) setState({ identity, status: 'ready', ...(addressed ? { sets: result } : {}) });
        }).catch(() => {
            if (!controller.signal.aborted && lifetime.isCurrent()) setState(current => ({
                ...(current.identity === identity ? current : {}), identity, status: 'failed',
            }));
        });
        return () => { controller.abort(); retirement.dispose(); };
    }, [attempt, changeSignal, identity, readRequest, addressed, accountLifetime]);
    const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
    return { sets: request === null ? EMPTY_SETS : addressed ? state.identity === identity && accountLifetime?.isCurrent()
        ? state.sets ?? EMPTY_SETS : EMPTY_SETS : sets, status: request === null ? 'ready' as const
        : state.identity === identity ? state.status : 'loading' as const, retry };
}
