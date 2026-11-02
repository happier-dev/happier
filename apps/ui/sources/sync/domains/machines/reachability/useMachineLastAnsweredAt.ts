import * as React from 'react';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readMachineLastAnsweredAt, subscribeMachineRequestReachability } from './machineReachability';

const noSubscription = () => () => {};
const noAnswer = () => null;

/** The current reachability lifetime's actual completed reply, scoped before snapshot work. */
export function useMachineLastAnsweredAt(scope: ServerAccountScope | null | undefined, machineId: string, enabled = true): number | null {
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const id = machineId.trim();
    const source = React.useMemo(() => {
        if (!serverId || !accountId || !id) return null;
        const target = { serverId, accountId };
        return {
            read: () => readMachineLastAnsweredAt(target, id),
            subscribe: (listener: () => void) => subscribeMachineRequestReachability(listener, {
                scope: target, machineId: id, fact: 'lastAnsweredAtMs',
            }),
        };
    }, [serverId, accountId, id]);
    return React.useSyncExternalStore(enabled && source ? source.subscribe : noSubscription,
        enabled && source ? source.read : noAnswer, enabled && source ? source.read : noAnswer);
}
