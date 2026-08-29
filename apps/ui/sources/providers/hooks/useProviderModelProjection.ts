import * as React from 'react';
import type { ProviderBoundModelRef } from '@happier-dev/protocol';
import type { DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc';

import { describeProviderModels, providerErrorFromRpcFailure } from '@/providers/rpc/client';
import { sessionModelSelectionKey } from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';

type Success = Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }>;
type ProjectionError = Extract<DaemonProviderModelProjectionResponseV1, { status: 'error' }>['error'];

export type ProviderModelProjectionStatus = 'disabled' | 'pending' | 'error' | 'success';

type ProjectionState = Readonly<{
    scopeKey: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
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
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const [state, setState] = React.useState<ProjectionState>({
        scopeKey: null,
        accountLifetime: null,
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
    const stateMatchesScope = state.scopeKey === scopeKey
        && state.accountLifetime === accountLifetime;
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
    const currentAccountLifetimeRef = React.useRef(accountLifetime);
    currentAccountLifetimeRef.current = accountLifetime;

    React.useEffect(() => {
        const registration = accountLifetime?.onRetire(() => {
            if (currentAccountLifetimeRef.current !== accountLifetime) return;
            generation.current += 1;
            setState((current) => current.accountLifetime === accountLifetime
                ? { scopeKey: null, accountLifetime: null, data: null, error: null, loading: false }
                : current);
        });
        return () => registration?.dispose();
    }, [accountLifetime]);

    const refreshWithResult = React.useCallback(async (forceRefresh: boolean = true) => {
        const requestGeneration = ++generation.current;
        const requestStillCurrent = (): boolean => (
            currentAccountLifetimeRef.current === accountLifetime
            && (accountLifetime?.isCurrent() ?? true)
        );
        if (!requestStillCurrent()) return null;
        if (!input.enabled || !input.machineId || !input.agentTargetKey) {
            setState({ scopeKey, accountLifetime, data: null, error: null, loading: false });
            return null;
        }
        setState((current) => current.scopeKey === scopeKey
            && current.accountLifetime === accountLifetime
            ? { ...current, loading: true }
            : { scopeKey, accountLifetime, data: null, error: null, loading: true });
        try {
            const result = await describeProviderModels({
                machineId: input.machineId,
                serverId: input.serverId,
                agentTargetKey: input.agentTargetKey,
                ...(input.mode ? { mode: input.mode } : {}),
                ...(forceRefresh ? { forceRefresh: true as const } : {}),
                ...(input.currentSelection ? { currentSelection: input.currentSelection } : {}),
            });
            if (requestGeneration !== generation.current || !requestStillCurrent()) return null;
            if (result.status === 'success') {
                setState({
                    scopeKey, accountLifetime, data: result,
                    error: null,
                    loading: true,
                });
            } else {
                setState((current) => ({
                    scopeKey,
                    accountLifetime,
                    data: current.scopeKey === scopeKey && current.accountLifetime === accountLifetime
                        ? current.data
                        : null,
                    error: result.error,
                    loading: true,
                }));
            }
            return result;
        } catch (caught) {
            if (requestGeneration !== generation.current || !requestStillCurrent()) return null;
            const providerError = providerErrorFromRpcFailure(caught, {
                machineId: input.machineId,
                ...(input.currentSelection?.providerConnectionId
                    ? { connectionId: input.currentSelection.providerConnectionId }
                    : {}),
            });
            setState((current) => ({
                scopeKey,
                accountLifetime,
                data: current.scopeKey === scopeKey && current.accountLifetime === accountLifetime
                    ? current.data
                    : null,
                error: providerError,
                loading: true,
            }));
            return { status: 'error' as const, error: providerError };
        } finally {
            if (requestGeneration === generation.current && requestStillCurrent()) {
                setState((current) => current.scopeKey === scopeKey
                    && current.accountLifetime === accountLifetime
                    ? { ...current, loading: false }
                    : current);
            }
        }
    }, [
        accountLifetime,
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
        void refreshWithResult(false);
        return () => { generation.current += 1; };
    }, [accountLifetime, refreshWithResult, scopeKey]);

    return {
        data, error,
        refreshFailures: data?.refreshFailures ?? [],
        loading, status, refresh, refreshWithResult,
    };
}
