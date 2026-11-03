import * as React from 'react';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import {
    readMachineRequestReachabilityRevision,
    subscribeMachineRequestReachability,
} from './machineReachability';

const subscribeDisabledReachability = () => () => {};
const readDisabledReachabilityRevision = () => 0;

/** Re-render a projection that reads server-scoped reachability observations. */
export function useMachineReachabilityRevision(enabled = true, scope?: ServerAccountScope, machineId?: string | null): number {
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const source = React.useMemo(() => {
        // This subscription cursor advances only for its admitted producer facts.
        let revision = readMachineRequestReachabilityRevision();
        return {
            read: () => revision,
            subscribe: (listener: () => void) => {
                revision = readMachineRequestReachabilityRevision();
                return subscribeMachineRequestReachability(() => {
                    revision = readMachineRequestReachabilityRevision();
                    listener();
                }, { ...(serverId && accountId ? { scope: { serverId, accountId } } : {}), machineId });
            },
        };
    }, [accountId, machineId, serverId]);
    return React.useSyncExternalStore(
        enabled ? source.subscribe : subscribeDisabledReachability,
        enabled ? source.read : readDisabledReachabilityRevision,
        enabled ? source.read : readDisabledReachabilityRevision,
    );
}
