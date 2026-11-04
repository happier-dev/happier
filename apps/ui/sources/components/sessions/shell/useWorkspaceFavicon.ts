import * as React from 'react';

import { readWorkspaceFaviconResult, resolveWorkspaceFavicon, subscribeWorkspaceFaviconResult, type WorkspaceFavicon } from '@/sync/ops/workspaceFavicon';
import { getStorage, useServerScopedMachine } from '@/sync/domains/state/storage';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export function useWorkspaceFavicon(params: Readonly<{
    enabled: boolean;
    serverId?: string | null;
    machineId?: string | null;
    workspacePath?: string | null;
    reachable?: boolean;
    /** False observes the shared result without resolving or retaining its pending request. */
    demand?: boolean;
}>): WorkspaceFavicon | null {
    const serverId = params.serverId ?? null;
    const machineId = params.machineId ?? null;
    const workspacePath = params.workspacePath ?? null;
    const reachable = params.reachable !== false;
    const demand = params.demand !== false;
    const source = params.enabled && reachable && machineId && workspacePath
        ? { serverId, machineId, workspacePath } : null;
    const favicon = React.useSyncExternalStore(
        (listener) => subscribeWorkspaceFaviconResult(source, listener),
        () => readWorkspaceFaviconResult(source),
        () => null,
    );
    const previousSource = React.useRef<Readonly<{
        serverId: string | null;
        machineId: string | null;
        workspacePath: string | null;
        reachable: boolean;
    }> | null>(null);

    React.useEffect(() => {
        const previous = previousSource.current;
        previousSource.current = { serverId, machineId, workspacePath, reachable };
        if (!demand || !params.enabled || !reachable || !machineId || !workspacePath) {
            return;
        }

        const controller = new AbortController();
        void resolveWorkspaceFavicon({
            enabled: params.enabled,
            serverId,
            machineId,
            workspacePath,
            refresh: previous !== null && (previous.serverId !== serverId || previous.machineId !== machineId
                || previous.workspacePath !== workspacePath || !previous.reachable),
            signal: controller.signal,
        }).catch(() => { /* The shared resource publishes the error as fallback. */ });

        return () => {
            controller.abort();
        };
    }, [params.enabled, serverId, machineId, workspacePath, reachable, demand]);

    const previous = previousSource.current;
    // Demanding views hide the result until their replacement/reconnect refresh starts. Passive
    // views read the current keyed resource directly: a settled source need not publish again.
    const changingSource = previous !== null && (previous.serverId !== serverId || previous.machineId !== machineId
        || previous.workspacePath !== workspacePath || (!previous.reachable && reachable));
    return demand && changingSource ? null : favicon;
}

/**
 * The held baseline Machine's canonical reachability for a favicon source (P5 U5): the active Home's
 * already-held Machine and the shared reachability revision, no extra read. Unknown stays undefined.
 */
export function useWorkspaceFaviconSourceReachable(
    source: Readonly<{ serverId: string; machineId: string }> | null | undefined,
    enabled: boolean,
): boolean | undefined {
    const scope = getStorage()((state) => state.profileScope);
    const inScope = Boolean(enabled && source && scope && areServerProfileIdentifiersEquivalent(scope.serverId, source.serverId));
    const machine = useServerScopedMachine(inScope ? source!.serverId : '', inScope ? source!.machineId : '');
    useMachineReachabilityRevision(inScope && machine !== null);
    if (!inScope || !machine) return undefined;
    const reachability = resolveMachineReachability(scope, machine);
    return reachability === 'unknown' ? undefined : reachability === 'reachable';
}
