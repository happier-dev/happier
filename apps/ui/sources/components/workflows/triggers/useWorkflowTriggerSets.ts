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
    const identity = React.useMemo(() => ({}), [queryKey, scopeKey]);
    const selector = React.useMemo(() => createWorkflowTriggerSetSelector(queryKey, workflow !== null), [queryKey, workflow]);
    const sets = getStorage()(selector);
    const changeSelector = React.useMemo(() => createWorkflowTriggerChangeSelector(null), []);
    const changeSignal = getStorage()(changeSelector);
    const [state, setState] = React.useState<{ identity: object; status: 'loading' | 'ready' | 'failed' }>(
        () => ({ identity, status: request === null ? 'ready' : 'loading' }),
    );
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => {
        if (request === null) return;
        const controller = new AbortController();
        const lifetime = captureActiveServerAccountScopeCurrentness();
        const retirement = lifetime.onRetire(() => controller.abort());
        setState({ identity, status: 'loading' });
        listWorkflowTriggerSets(request, { signal: controller.signal }).then(() => {
            if (!controller.signal.aborted && lifetime.isCurrent()) setState({ identity, status: 'ready' });
        }).catch(() => {
            if (!controller.signal.aborted && lifetime.isCurrent()) setState({ identity, status: 'failed' });
        });
        return () => { controller.abort(); retirement.dispose(); };
    }, [attempt, changeSignal, identity, request]);
    const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
    return { sets: request === null ? [] : sets, status: request === null ? 'ready' as const
        : state.identity === identity ? state.status : 'loading' as const, retry };
}
