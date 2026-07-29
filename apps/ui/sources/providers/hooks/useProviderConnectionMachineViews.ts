import * as React from 'react';
import type { ProviderErrorV1 } from '@happier-dev/protocol';
import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';

import { describeProviderConnections, providerErrorFromRpcFailure } from '@/providers/rpc/client';

export type ProviderConnectionMachineViewState =
    | Readonly<{ status: 'loading'; connection: DaemonProviderConnectionViewV1 | null }>
    | Readonly<{ status: 'success'; connection: DaemonProviderConnectionViewV1 | null }>
    | Readonly<{ status: 'error'; error: ProviderErrorV1 }>;

export function useProviderConnectionMachineViews(input: Readonly<{
    enabled: boolean;
    serverId: string | null;
    connectionId: string;
    machineIds: readonly string[];
}>) {
    const [byMachineId, setByMachineId] = React.useState<Readonly<Record<string, ProviderConnectionMachineViewState>>>({});
    const [loading, setLoading] = React.useState(false);
    const generation = React.useRef(0);
    const machineKey = JSON.stringify([...input.machineIds].sort());

    const refresh = React.useCallback(async () => {
        const requestGeneration = ++generation.current;
        if (!input.enabled || input.machineIds.length === 0) {
            setByMachineId({});
            setLoading(false);
            return;
        }
        setLoading(true);
        setByMachineId((current) => Object.fromEntries(input.machineIds.map((machineId) => {
            const previous = current[machineId];
            return [machineId, {
                status: 'loading',
                connection: previous?.status === 'success' || previous?.status === 'loading'
                    ? previous.connection
                    : null,
            } satisfies ProviderConnectionMachineViewState];
        })));
        const entries = await Promise.all(input.machineIds.map(async (machineId) => {
            try {
                const result = await describeProviderConnections({
                    machineId,
                    serverId: input.serverId,
                    connectionId: input.connectionId,
                });
                return [machineId, result.status === 'success'
                    ? {
                        status: 'success',
                        connection: result.connections.find((connection) => connection.connectionId === input.connectionId) ?? null,
                    } satisfies ProviderConnectionMachineViewState
                    : { status: 'error', error: result.error } satisfies ProviderConnectionMachineViewState] as const;
            } catch (caught) {
                return [machineId, {
                    status: 'error',
                    error: providerErrorFromRpcFailure(caught, {
                        connectionId: input.connectionId,
                        machineId,
                    }),
                } satisfies ProviderConnectionMachineViewState] as const;
            }
        }));
        if (generation.current !== requestGeneration) return;
        setByMachineId(Object.fromEntries(entries));
        setLoading(false);
    }, [input.connectionId, input.enabled, machineKey, input.serverId]);

    React.useEffect(() => {
        void refresh();
        return () => { generation.current += 1; };
    }, [refresh]);

    return { byMachineId, loading, refresh };
}
