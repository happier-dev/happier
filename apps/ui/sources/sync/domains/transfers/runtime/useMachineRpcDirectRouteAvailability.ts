import * as React from 'react';

import {
    readCachedMachineRpcDirectRoute,
    subscribeCachedMachineRpcDirectRoute,
} from './transferRouteCache';
import { probeMachineRpcDirectRouteAvailability } from './probeMachineRpcDirectRouteAvailability';

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export type MachineRpcDirectRouteAvailability = 'unknown' | 'viable' | 'unavailable';

export function useMachineRpcDirectRouteAvailability(input: Readonly<{
    serverId?: string | null;
    remoteMachineId?: string | null;
}>): MachineRpcDirectRouteAvailability {
    const serverId = normalizeNonEmptyString(input.serverId);
    const remoteMachineId = normalizeNonEmptyString(input.remoteMachineId);

    const getSnapshot = React.useCallback((): MachineRpcDirectRouteAvailability => {
        if (!serverId || !remoteMachineId) {
            return 'unknown';
        }

        const cached = readCachedMachineRpcDirectRoute({
            serverId,
            remoteMachineId,
        });
        if (cached.status === 'viable') return 'viable';
        if (cached.status === 'unavailable') return 'unavailable';
        return 'unknown';
    }, [remoteMachineId, serverId]);

    const [availability, setAvailability] = React.useState<MachineRpcDirectRouteAvailability>(() => getSnapshot());

    React.useLayoutEffect(() => {
        setAvailability(getSnapshot());

        if (!serverId || !remoteMachineId) {
            return undefined;
        }

        return subscribeCachedMachineRpcDirectRoute({
            serverId,
            remoteMachineId,
        }, () => {
            setAvailability(getSnapshot());
        });
        }, [getSnapshot, remoteMachineId, serverId]);

    React.useEffect(() => {
        if (!serverId || !remoteMachineId || availability !== 'unknown') {
            return undefined;
        }

        let cancelled = false;

        void probeMachineRpcDirectRouteAvailability({
            serverId,
            remoteMachineId,
        }).then((nextAvailability) => {
            if (cancelled) return;
            setAvailability((current) => (current === 'unknown' ? nextAvailability : current));
        });

        return () => {
            cancelled = true;
        };
    }, [availability, remoteMachineId, serverId]);

    return availability;
}
