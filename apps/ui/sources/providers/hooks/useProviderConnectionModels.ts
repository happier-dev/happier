import * as React from 'react';
import type { ProviderErrorV1 } from '@happier-dev/protocol';
import type { DaemonProviderModelRowV1 } from '@happier-dev/protocol/rpc';

import { describeProviderConnectionModels, providerErrorFromRpcFailure } from '@/providers/rpc/client';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';

export function useProviderConnectionModels(input: Readonly<{
    enabled: boolean;
    machineId: string | null;
    serverId: string | null;
    connectionId: string;
}>) {
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const [models, setModels] = React.useState<readonly DaemonProviderModelRowV1[]>([]);
    const [connectionRevision, setConnectionRevision] = React.useState<number | null>(null);
    const [manualModelPolicy, setManualModelPolicy] = React.useState<'allowed' | 'catalog-only' | null>(null);
    const [modelLoadAction, setModelLoadAction] = React.useState<'available' | 'descriptor_absent' | 'feature_disabled' | null>(null);
    const [error, setError] = React.useState<ProviderErrorV1 | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [stateScopeKey, setStateScopeKey] = React.useState<string | null>(null);
    const [stateAccountLifetime, setStateAccountLifetime] = React.useState<
        ActiveServerAccountScopeLifetime | null
    >(null);
    const generation = React.useRef(0);
    const currentAccountLifetimeRef = React.useRef(accountLifetime);
    currentAccountLifetimeRef.current = accountLifetime;
    const stateAccountLifetimeRef = React.useRef(stateAccountLifetime);
    stateAccountLifetimeRef.current = stateAccountLifetime;
    const stateScopeKeyRef = React.useRef(stateScopeKey);
    stateScopeKeyRef.current = stateScopeKey;
    const scopeKey = JSON.stringify([input.enabled, input.machineId, input.serverId, input.connectionId]);

    React.useEffect(() => {
        const registration = accountLifetime?.onRetire(() => {
            if (currentAccountLifetimeRef.current !== accountLifetime) return;
            generation.current += 1;
            if (stateAccountLifetimeRef.current !== accountLifetime) return;
            stateAccountLifetimeRef.current = null;
            stateScopeKeyRef.current = null;
            setStateAccountLifetime(null);
            setStateScopeKey(null);
            setModels([]);
            setConnectionRevision(null);
            setManualModelPolicy(null);
            setModelLoadAction(null);
            setError(null);
            setLoading(false);
        });
        return () => registration?.dispose();
    }, [accountLifetime]);

    const refreshWithResult = React.useCallback(async () => {
        const requestGeneration = ++generation.current;
        const requestStillCurrent = (): boolean => (
            currentAccountLifetimeRef.current === accountLifetime
            && (accountLifetime?.isCurrent() ?? true)
        );
        if (!requestStillCurrent()) return null;
        if (!input.enabled || !input.machineId || !input.connectionId) {
            stateAccountLifetimeRef.current = accountLifetime;
            stateScopeKeyRef.current = scopeKey;
            setStateAccountLifetime(accountLifetime);
            setStateScopeKey(scopeKey);
            setModels([]);
            setConnectionRevision(null);
            setManualModelPolicy(null);
            setModelLoadAction(null);
            setError(null);
            setLoading(false);
            return null;
        }
        if (
            stateScopeKeyRef.current !== scopeKey
            || stateAccountLifetimeRef.current !== accountLifetime
        ) {
            stateAccountLifetimeRef.current = accountLifetime;
            stateScopeKeyRef.current = scopeKey;
            setStateAccountLifetime(accountLifetime);
            setStateScopeKey(scopeKey);
            setModels([]);
            setConnectionRevision(null);
            setManualModelPolicy(null);
            setModelLoadAction(null);
            setError(null);
        }
        setLoading(true);
        try {
            const result = await describeProviderConnectionModels({
                machineId: input.machineId,
                serverId: input.serverId,
                connectionId: input.connectionId,
            });
            if (generation.current !== requestGeneration || !requestStillCurrent()) return null;
            if (result.status === 'success') {
                stateAccountLifetimeRef.current = accountLifetime;
                stateScopeKeyRef.current = scopeKey;
                setStateAccountLifetime(accountLifetime);
                setStateScopeKey(scopeKey);
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
            if (generation.current !== requestGeneration || !requestStillCurrent()) return null;
            const error = providerErrorFromRpcFailure(caught, {
                connectionId: input.connectionId,
                machineId: input.machineId,
            });
            stateAccountLifetimeRef.current = accountLifetime;
            stateScopeKeyRef.current = scopeKey;
            setStateAccountLifetime(accountLifetime);
            setStateScopeKey(scopeKey);
            setError(error);
            return { status: 'error' as const, error };
        } finally {
            if (generation.current === requestGeneration && requestStillCurrent()) setLoading(false);
        }
    }, [accountLifetime, input.connectionId, input.enabled, input.machineId, input.serverId, scopeKey]);

    const refresh = React.useCallback(async (): Promise<void> => {
        await refreshWithResult();
    }, [refreshWithResult]);

    React.useEffect(() => {
        if (
            stateScopeKeyRef.current !== scopeKey
            || stateAccountLifetimeRef.current !== accountLifetime
        ) {
            stateScopeKeyRef.current = scopeKey;
            stateAccountLifetimeRef.current = accountLifetime;
            setStateScopeKey(scopeKey);
            setStateAccountLifetime(accountLifetime);
            setModels([]);
            setConnectionRevision(null);
            setManualModelPolicy(null);
            setModelLoadAction(null);
            setError(null);
        }
        void refreshWithResult();
        return () => { generation.current += 1; };
    }, [accountLifetime, refreshWithResult, scopeKey]);

    const stateMatchesScope = stateScopeKey === scopeKey
        && stateAccountLifetime === accountLifetime;
    const scopeEnabled = Boolean(input.enabled && input.machineId && input.connectionId);
    return {
        models: stateMatchesScope ? models : [],
        connectionRevision: stateMatchesScope ? connectionRevision : null,
        manualModelPolicy: stateMatchesScope ? manualModelPolicy : null,
        modelLoadAction: stateMatchesScope ? modelLoadAction : null,
        error: stateMatchesScope ? error : null,
        loading: scopeEnabled && (!stateMatchesScope || loading),
        refresh,
        refreshWithResult,
    };
}
