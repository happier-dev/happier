import * as React from 'react';
import type { DaemonProviderConnectionsDescribeResponseV1 } from '@happier-dev/protocol/rpc';

import { describeProviderConnections, providerErrorFromRpcFailure } from '@/providers/rpc/client';

type Success = Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }>;

export function useProviderConnections(input: Readonly<{
    enabled: boolean;
    machineId: string | null;
    serverId: string | null;
    connectionId?: string;
}>) {
    const [data, setData] = React.useState<Success | null>(null);
    const [error, setError] = React.useState<Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'error' }>['error'] | null>(null);
    const [loading, setLoading] = React.useState(false);
    const generation = React.useRef(0);

    const refresh = React.useCallback(async () => {
        const requestGeneration = ++generation.current;
        if (!input.enabled || !input.machineId) {
            setData(null);
            setError(null);
            setLoading(false);
            return;
        }
        setLoading(true);
        try {
            const result = await describeProviderConnections({
                machineId: input.machineId,
                serverId: input.serverId,
                ...(input.connectionId ? { connectionId: input.connectionId } : {}),
            });
            if (requestGeneration !== generation.current) return;
            if (result.status === 'success') {
                setData(result);
                setError(null);
            } else {
                setError(result.error);
            }
        } catch (caught) {
            if (requestGeneration !== generation.current) return;
            setError(providerErrorFromRpcFailure(caught, {
                machineId: input.machineId,
                ...(input.connectionId ? { connectionId: input.connectionId } : {}),
            }));
        } finally {
            if (requestGeneration === generation.current) setLoading(false);
        }
    }, [input.connectionId, input.enabled, input.machineId, input.serverId]);

    React.useEffect(() => {
        setData(null);
        setError(null);
        void refresh();
        return () => { generation.current += 1; };
    }, [refresh]);

    return { data, error, loading, refresh };
}
