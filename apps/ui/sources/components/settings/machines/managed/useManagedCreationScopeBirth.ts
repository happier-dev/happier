import * as React from 'react';

import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readManagedCreationScopeBirthSource, type ManagedCreationScopeSource } from '@/sync/ops/actions/managedCreationScopeBinding';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { readWorkflowRunAccountChangeRunId } from '@/sync/runtime/orchestration/changesPlanner';

export type ManagedCreationScopeBirthRead = Readonly<{
    status: 'pending' | 'ready' | 'failed';
    source: ManagedCreationScopeSource | null;
    retry: () => void;
}>;

/** Exact, demanded birth read. FIN never supplies authority for a known durable birth. */
export function useManagedCreationScopeBirth(
    machine: Readonly<{ homeId: string; id: string }>,
    binding: ServerAccountScopeLifetime | null | undefined,
): ManagedCreationScopeBirthRead {
    const identity = React.useMemo(() => ({}), [binding, machine.homeId, machine.id]);
    const [state, setState] = React.useState<Readonly<{
        identity: object;
        status: ManagedCreationScopeBirthRead['status'];
        source: ManagedCreationScopeSource | null;
    }>>({ identity, status: 'pending', source: null });
    const stateRef = React.useRef(state);
    stateRef.current = state;
    const pending = React.useRef<AbortController | null>(null);
    const [attempt, retryRead] = React.useReducer(value => value + 1, 0);
    const retry = React.useCallback(() => {
        // A user retry supersedes the old read, including a held response body.
        pending.current?.abort();
        retryRead();
    }, []);
    React.useEffect(() => {
        if (!binding?.isCurrent()) return;
        return subscribeHomeAccountChange(event => {
            if (!binding.isCurrent() || !areServerProfileIdentifiersEquivalent(event.serverId, binding.scope.serverId)) return;
            // Check now publishes the incumbent explicit Home refresh. A typed
            // Run fact can resolve a relation absent before Run admission. Once
            // known, birth is immutable and unrelated Run updates need no read.
            const explicitRefresh = event.source === undefined && event.entityIds === undefined && event.changeKinds === undefined;
            const runChanged = event.workflowRunsMaterialized === true
                || event.entityIds?.some(id => Boolean(readWorkflowRunAccountChangeRunId(id))) === true;
            const known = stateRef.current.identity === identity && stateRef.current.source !== null;
            if (explicitRefresh || runChanged && !known) retry();
        }, { serverIds: [binding.scope.serverId] });
    }, [binding, identity, retry]);
    React.useEffect(() => {
        if (!binding?.isCurrent()) return;
        const controller = new AbortController();
        pending.current = controller;
        const retirement = binding.onRetire(() => {
            controller.abort();
            setState({ identity, status: 'failed', source: null });
        });
        setState(previous => ({ identity, status: 'pending', source: previous.identity === identity ? previous.source : null }));
        readManagedCreationScopeBirthSource({ machine: { homeId: machine.homeId, id: machine.id },
            accountLifetime: binding, signal: controller.signal }).then(source => {
            if (!controller.signal.aborted && binding.isCurrent()) setState({ identity, status: 'ready', source });
        }).catch(() => {
            if (!controller.signal.aborted && binding.isCurrent()) setState(previous => ({ identity, status: 'failed',
                source: previous.identity === identity ? previous.source : null }));
        });
        return () => {
            controller.abort(); retirement.dispose();
            if (pending.current === controller) pending.current = null;
        };
    }, [attempt, binding, identity, machine.homeId, machine.id]);
    return state.identity === identity && binding?.isCurrent()
        ? { status: state.status, source: state.source, retry }
        : { status: 'pending', source: null, retry };
}
