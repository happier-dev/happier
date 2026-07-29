import * as React from 'react';
import type { ProviderBoundModelRef } from '@happier-dev/protocol';
import type { DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc';

import { describeProviderModels, providerErrorFromRpcFailure } from '@/providers/rpc/client';
import { sessionModelSelectionKey } from '@/components/sessions/modelPicker/sessionModelSelectionKey';

type Success = Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }>;
type ProjectionError = Extract<DaemonProviderModelProjectionResponseV1, { status: 'error' }>['error'];

export type ProviderModelProjectionStatus = 'disabled' | 'pending' | 'error' | 'success';

type ProjectionState = Readonly<{
    scopeKey: string | null;
    data: Success | null;
    error: ProjectionError | null;
    loading: boolean;
}>;

export function useProviderModelProjection(input: Readonly<{
    enabled: boolean;
    machineId: string | null;
    serverId: string | null;
    agentTargetKey: string | null;
    mode?: 'picker' | 'management';
    currentSelection?: ProviderBoundModelRef;
}>) {
    const [state, setState] = React.useState<ProjectionState>({
        scopeKey: null,
        data: null,
        error: null,
        loading: false,
    });
    const generation = React.useRef(0);
    const selectionKey = input.currentSelection
        ? sessionModelSelectionKey(input.currentSelection)
        : '';
    const scopeKey = JSON.stringify([
        input.enabled, input.machineId, input.serverId, input.agentTargetKey, input.mode ?? 'picker', selectionKey,
    ]);
    const scopeEnabled = Boolean(input.enabled && input.machineId && input.agentTargetKey);
    const stateMatchesScope = state.scopeKey === scopeKey;
    const data = stateMatchesScope ? state.data : null;
    const error = stateMatchesScope ? state.error : null;
    const loading = scopeEnabled && (!stateMatchesScope || state.loading);
    const status: ProviderModelProjectionStatus = !scopeEnabled
        ? 'disabled'
        : data
            ? 'success'
            : error
                ? 'error'
                : 'pending';

    const refreshWithResult = React.useCallback(async () => {
        const requestGeneration = ++generation.current;
        if (!input.enabled || !input.machineId || !input.agentTargetKey) {
            setState({ scopeKey, data: null, error: null, loading: false });
            return null;
        }
        setState((current) => current.scopeKey === scopeKey
            ? { ...current, loading: true }
            : { scopeKey, data: null, error: null, loading: true });
        try {
            const result = await describeProviderModels({
                machineId: input.machineId,
                serverId: input.serverId,
                agentTargetKey: input.agentTargetKey,
                ...(input.mode ? { mode: input.mode } : {}),
                ...(input.currentSelection ? { currentSelection: input.currentSelection } : {}),
            });
            if (requestGeneration !== generation.current) return null;
            if (result.status === 'success') {
                setState({ scopeKey, data: result, error: null, loading: true });
            } else {
                setState((current) => ({
                    scopeKey,
                    data: current.scopeKey === scopeKey ? current.data : null,
                    error: result.error,
                    loading: true,
                }));
            }
            return result;
        } catch (caught) {
            if (requestGeneration !== generation.current) return null;
            const providerError = providerErrorFromRpcFailure(caught, {
                machineId: input.machineId,
                ...(input.currentSelection?.providerConnectionId
                    ? { connectionId: input.currentSelection.providerConnectionId }
                    : {}),
            });
            setState((current) => ({
                scopeKey,
                data: current.scopeKey === scopeKey ? current.data : null,
                error: providerError,
                loading: true,
            }));
            return { status: 'error' as const, error: providerError };
        } finally {
            if (requestGeneration === generation.current) {
                setState((current) => current.scopeKey === scopeKey
                    ? { ...current, loading: false }
                    : current);
            }
        }
    }, [
        input.agentTargetKey,
        input.enabled,
        input.machineId,
        input.mode,
        input.serverId,
        scopeKey,
        selectionKey,
    ]);

    const refresh = React.useCallback(async (): Promise<void> => {
        await refreshWithResult();
    }, [refreshWithResult]);

    React.useEffect(() => {
        void refreshWithResult();
        return () => { generation.current += 1; };
    }, [refreshWithResult, scopeKey]);

    return { data, error, loading, status, refresh, refreshWithResult };
}
