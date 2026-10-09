import * as React from 'react';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createManagedProvisionerClient } from './managedProvisionerClient';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

/** Demand belongs to the mounted Create surface, and all data retires with its exact Home credential. */
export function useManagedProvisioners(serverId: string, onApprovalPending?: (registration: ActionApprovalRegistration) => void,
    controller?: ManagedControllerV1 | readonly ManagedControllerV1[]) {
    const { binding, resolution } = useServerCredentialAccountScopeBinding(serverId);
    const homeId = getServerProfileById(serverId)?.serverIdentityId?.trim() || null;
    const [state, setState] = React.useState<Readonly<{
        binding: ServerCredentialAccountScopeBinding | null; requestKey: string; provisioners: MachineProvisionersListResultV1['provisioners'];
        error: string | null; loading: boolean;
    }>>({ binding: null, requestKey: '', provisioners: [], error: null, loading: false });
    const controllers = React.useMemo(() => controller ? 'machineId' in controller ? [controller] : controller : [], [controller]);
    const requestKey = JSON.stringify([homeId, controllers]);
    const [refreshRevision, refresh] = React.useReducer(value => value + 1, 0);
    const approvalRef = React.useRef(onApprovalPending);
    approvalRef.current = onApprovalPending;
    const client = React.useMemo(() => binding && homeId ? createManagedProvisionerClient(binding.scope, homeId) : null, [binding, homeId]);
    React.useEffect(() => {
        if (!binding || !client || !homeId || controllers.length === 0) return;
        const abort = new AbortController();
        const retirement = binding.onRetire(() => {
            abort.abort();
            setState(current => current.binding === binding ? { binding: null, requestKey: '', provisioners: [], error: null, loading: false } : current);
        });
        setState(current => ({ binding, requestKey, provisioners: current.binding === binding && current.requestKey === requestKey ? current.provisioners : [], error: null, loading: true }));
        void Promise.all(controllers.map(selected => client.read('machines.provisioners.list', { homeId, controller: selected },
            { signal: abort.signal, onApprovalPending: registration => approvalRef.current?.(registration) }))).then(results => {
            if (abort.signal.aborted || !binding.isCurrent()) return;
            const failure = results.find(result => result.kind === 'failed');
            setState(current => current.binding !== binding || current.requestKey !== requestKey ? current : {
                ...current, loading: false,
                provisioners: failure ? current.provisioners : results.flatMap(result => result.kind === 'succeeded' ? result.value.provisioners : []),
                error: failure?.kind === 'failed' ? failure.code : null,
            });
        }).catch(() => {
            if (!abort.signal.aborted && binding.isCurrent()) setState(current => current.binding === binding && current.requestKey === requestKey
                ? { ...current, loading: false, error: 'unavailable' } : current);
        });
        return () => { abort.abort(); retirement.dispose(); };
    }, [binding, client, homeId, controllers, requestKey, refreshRevision]);
    const visible = binding?.isCurrent() && state.binding === binding && state.requestKey === requestKey ? state : {
        provisioners: [], error: resolution.kind === 'resolving' || resolution.kind === 'bound' ? null : resolution.kind,
        loading: resolution.kind === 'resolving' || resolution.kind === 'bound' && controllers.length > 0,
    };
    return { binding, resolution, homeId, client, provisioners: visible.provisioners,
        error: binding && !homeId ? 'unsupported_action' : visible.error,
        loading: binding && !homeId ? false : visible.loading, refresh };
}
