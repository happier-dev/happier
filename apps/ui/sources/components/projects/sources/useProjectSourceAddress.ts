import * as React from 'react';
import type { ProjectSourceRepositorySelectorV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readProjectSourceAddressMachines } from './projectSourceAddressMachines';
import { resolveProjectSourceAddress, type ProjectSourceAddressRefusal, type ProjectSourceAddressResolution } from './resolveProjectSourceAddress';
import { useProjectSourceActionExecute } from './useProjectSources';
import { useMachineListStatusForServer } from '@/sync/store/hooks';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';

/**
 * A typed repository address outside a Source's own editor (Open's "Clone a repository…"): the same
 * reading as a new Source, one request at a time, and the repository it names once it resolves.
 */
export function useProjectSourceAddress(scope: ServerAccountScope, onResolved: (selector: ProjectSourceRepositorySelectorV1) => void) {
    const execute = useProjectSourceActionExecute();
    const lifetime = captureActiveServerAccountScopeLifetime();
    const inventoryStatus = useMachineListStatusForServer(scope.serverId);
    const [state, setState] = React.useState<Readonly<{ resolution: ProjectSourceAddressResolution; refusal: ProjectSourceAddressRefusal | null }>>(
        { resolution: { kind: 'idle' }, refusal: null });
    const requestRef = React.useRef<AbortController | null>(null);
    const onResolvedRef = React.useRef(onResolved);
    onResolvedRef.current = onResolved;
    React.useEffect(() => () => requestRef.current?.abort(), []);
    /** `machineId`: the Machine the person already chose (Open's Where) reads it, when it is online. */
    const resolve = React.useCallback(async (text: string, machineId?: string | null) => {
        requestRef.current?.abort();
        const request = new AbortController();
        requestRef.current = request;
        const outcome = await resolveProjectSourceAddress({ text, scope, execute, signal: request.signal,
            machines: { ...readProjectSourceAddressMachines(scope.serverId), ...(machineId ? { preferredMachineId: machineId } : {}) },
            onResolving: (resolution) => setState({ resolution, refusal: 'projects.sources.loading' }) });
        if (!outcome || request.signal.aborted || requestRef.current !== request) return;
        requestRef.current = null;
        setState(outcome);
        if (outcome.resolution.kind === 'resolved') onResolvedRef.current(outcome.resolution.selector);
    }, [execute, scope]);
    /** The person is correcting the address: the refusal for the last one no longer applies. */
    const withdrawRefusal = React.useCallback(() => {
        setState((previous) => previous.refusal && previous.refusal !== 'projects.sources.loading' ? { ...previous, refusal: null } : previous);
    }, []);
    React.useEffect(() => {
        if (state.resolution.kind !== 'waiting_for_machines' || inventoryStatus === 'loading'
            || !lifetime?.isCurrent() || !areServerAccountScopesEqual(lifetime.scope, scope)) return;
        void resolve(state.resolution.address, state.resolution.preferredMachineId);
    }, [inventoryStatus, lifetime, resolve, scope, state.resolution]);
    return { ...state, resolve, withdrawRefusal };
}
