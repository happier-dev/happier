import * as React from 'react';
import type { ProviderBoundModelRef } from '@happier-dev/protocol';
import type { DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc';

import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
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
    active?: boolean;
    machineId: string | null;
    serverId: string | null;
    agentTargetKey: string | null;
    mode?: 'picker' | 'management';
    currentSelection?: ProviderBoundModelRef;
    /** Browsing a source is local picker state; it never changes the selected model. */
    sourceConnectionId?: string;
    favoriteSelections?: readonly ProviderBoundModelRef[];
}>) {
    const { describeProviderModels, ready } = useProviderActionClient(input.serverId);
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const [state, setState] = React.useState<ProjectionState>({
        scopeKey: null,
        accountLifetime: null,
        data: null,
        error: null,
        loading: false,
    });
    const generation = React.useRef(0);
    const activeRef = React.useRef(input.active !== false);
    activeRef.current = input.active !== false;
    const selectionKey = input.currentSelection
        ? sessionModelSelectionKey(input.currentSelection)
        : '';
    const scopeKey = JSON.stringify([
        input.enabled, input.machineId, input.serverId, input.agentTargetKey, input.mode ?? 'picker', selectionKey,
        input.sourceConnectionId ?? null, input.favoriteSelections?.map(sessionModelSelectionKey) ?? [],
    ]);
    const scopeEnabled = Boolean(input.enabled && input.agentTargetKey);
    const stateMatchesScope = state.scopeKey === scopeKey
        && state.accountLifetime === accountLifetime;
    const data = stateMatchesScope ? state.data : null;
    const error = stateMatchesScope ? state.error : null;
    const loading = input.active !== false && scopeEnabled && (!ready || !stateMatchesScope || state.loading);
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
        if (!activeRef.current) return null;
        const requestGeneration = ++generation.current;
        const requestStillCurrent = (): boolean => (
            currentAccountLifetimeRef.current === accountLifetime
            && (accountLifetime?.isCurrent() ?? true)
        );
        if (!requestStillCurrent()) return null;
        if (!input.enabled || !input.agentTargetKey) {
            setState({ scopeKey, accountLifetime, data: null, error: null, loading: false });
            return null;
        }
        if (!ready) return null;
        setState((current) => current.scopeKey === scopeKey
            && current.accountLifetime === accountLifetime
            ? { ...current, loading: true }
            : { scopeKey, accountLifetime, data: null, error: null, loading: true });
        try {
            const result = await describeProviderModels({
                ...(input.machineId ? { machineId: input.machineId } : {}),
                serverId: input.serverId,
                agentTargetKey: input.agentTargetKey,
                ...(input.mode ? { mode: input.mode } : {}),
                // Refreshing an Account-only catalog cannot probe a runtime.
                ...(forceRefresh && input.machineId ? { forceRefresh: true as const } : {}),
                ...(input.currentSelection ? { currentSelection: input.currentSelection } : {}),
                ...(input.sourceConnectionId ? { sourceConnectionId: input.sourceConnectionId } : {}),
                ...(input.favoriteSelections ? { favoriteSelections: [...input.favoriteSelections] } : {}),
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
                ...(input.machineId ? { machineId: input.machineId } : {}),
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
        describeProviderModels,
        ready,
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
    }, [accountLifetime, input.active, refreshWithResult, scopeKey]);

    return {
        data, error,
        refreshFailures: data?.refreshFailures ?? [],
        loading, status, refresh, refreshWithResult,
    };
}
