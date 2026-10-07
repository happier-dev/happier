import * as React from 'react';
import type { WorkflowTriggerListRequestV1 } from '@happier-dev/protocol';

import { getStorage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { createWorkflowTriggerChangeSelector, createWorkflowTriggerSetSelector } from '@/sync/store/domains/automations';
import { listWorkflowTriggerSets } from '@/sync/domains/workflows/workflowTriggerActions';

/** Read lifecycle only; the existing Account Automation projection remains the row owner. */
export function useWorkflowTriggerSets(request: WorkflowTriggerListRequestV1 | null) {
    const scope = useActiveServerAccountScope();
    const scopeKey = scope ? serverAccountScopeKeySuffix(scope) : null;
    const workflow = request && 'workflow' in request ? request.workflow : null;
    const queryKey = request === null ? '' : workflow ? `workflow:${workflow}` : 'account_inline';
    // The semantic query, not a caller's object allocation, owns the read lifetime.
    const readRequest = React.useMemo<WorkflowTriggerListRequestV1 | null>(() => queryKey === '' ? null
        : workflow === null ? { scope: 'account_inline' } : { workflow }, [queryKey, workflow]);
    const identity = React.useMemo(() => ({}), [queryKey, scopeKey]);
    const selector = React.useMemo(() => createWorkflowTriggerSetSelector(queryKey, workflow !== null), [queryKey, workflow]);
    const sets = getStorage()(selector);
    const changeSelector = React.useMemo(() => queryKey === '' ? () => ''
        : createWorkflowTriggerChangeSelector(null, workflow), [queryKey, workflow]);
    const changeSignal = getStorage()(changeSelector);
    const [state, setState] = React.useState<{ identity: object; status: 'loading' | 'ready' | 'failed' }>(
        () => ({ identity, status: request === null ? 'ready' : 'loading' }),
    );
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => {
        if (readRequest === null) return;
        const controller = new AbortController();
        const lifetime = captureActiveServerAccountScopeCurrentness();
        const retirement = lifetime.onRetire(() => controller.abort());
        // A settled read keeps its answer while it refreshes (a change signal or a retry after
        // success): the store still holds the last-known sets, so nothing reverts to loading.
        setState((current) => current.identity === identity && current.status === 'ready' ? current : { identity, status: 'loading' });
        listWorkflowTriggerSets(readRequest, { signal: controller.signal }).then(() => {
            if (!controller.signal.aborted && lifetime.isCurrent()) setState({ identity, status: 'ready' });
        }).catch(() => {
            if (!controller.signal.aborted && lifetime.isCurrent()) setState({ identity, status: 'failed' });
        });
        return () => { controller.abort(); retirement.dispose(); };
    }, [attempt, changeSignal, identity, readRequest]);
    const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
    return { sets: request === null ? [] : sets, status: request === null ? 'ready' as const
        : state.identity === identity ? state.status : 'loading' as const, retry };
}
