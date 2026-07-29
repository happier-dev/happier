import * as React from 'react';
import type { ProviderErrorV1 } from '@happier-dev/protocol';
import type { DaemonProviderModelRowV1 } from '@happier-dev/protocol/rpc';

import { describeProviderConnectionModels, providerErrorFromRpcFailure } from '@/providers/rpc/client';

export function useProviderConnectionModels(input: Readonly<{
    enabled: boolean;
    machineId: string | null;
    serverId: string | null;
    connectionId: string;
}>) {
    const [models, setModels] = React.useState<readonly DaemonProviderModelRowV1[]>([]);
    const [connectionRevision, setConnectionRevision] = React.useState<number | null>(null);
    const [manualModelPolicy, setManualModelPolicy] = React.useState<'allowed' | 'catalog-only' | null>(null);
    const [modelLoadAction, setModelLoadAction] = React.useState<'available' | 'descriptor_absent' | 'feature_disabled' | null>(null);
    const [error, setError] = React.useState<ProviderErrorV1 | null>(null);
    const [loading, setLoading] = React.useState(false);
    const generation = React.useRef(0);
    const activeScopeKey = React.useRef<string | null>(null);
    const scopeKey = JSON.stringify([input.enabled, input.machineId, input.serverId, input.connectionId]);

    const refreshWithResult = React.useCallback(async () => {
        const requestGeneration = ++generation.current;
        if (!input.enabled || !input.machineId || !input.connectionId) {
            setModels([]);
            setConnectionRevision(null);
            setManualModelPolicy(null);
            setModelLoadAction(null);
            setError(null);
            setLoading(false);
            return null;
        }
        setLoading(true);
        try {
            const result = await describeProviderConnectionModels({
                machineId: input.machineId,
                serverId: input.serverId,
                connectionId: input.connectionId,
            });
            if (generation.current !== requestGeneration) return null;
            if (result.status === 'success') {
                setModels(result.models);
                setConnectionRevision(result.connectionRevision);
                setManualModelPolicy(result.manualModelPolicy);
                setModelLoadAction(result.modelLoadAction);
                setError(null);
            } else {
                setError(result.error);
            }
            return result;
        } catch (caught) {
            if (generation.current !== requestGeneration) return null;
            const error = providerErrorFromRpcFailure(caught, {
                connectionId: input.connectionId,
                machineId: input.machineId,
            });
            setError(error);
            return { status: 'error' as const, error };
        } finally {
            if (generation.current === requestGeneration) setLoading(false);
        }
    }, [input.connectionId, input.enabled, input.machineId, input.serverId]);

    const refresh = React.useCallback(async (): Promise<void> => {
        await refreshWithResult();
    }, [refreshWithResult]);

    React.useEffect(() => {
        if (activeScopeKey.current !== scopeKey) {
            activeScopeKey.current = scopeKey;
            setModels([]);
            setConnectionRevision(null);
            setManualModelPolicy(null);
            setModelLoadAction(null);
            setError(null);
        }
        void refreshWithResult();
        return () => { generation.current += 1; };
    }, [refreshWithResult, scopeKey]);

    return { models, connectionRevision, manualModelPolicy, modelLoadAction, error, loading, refresh, refreshWithResult };
}
