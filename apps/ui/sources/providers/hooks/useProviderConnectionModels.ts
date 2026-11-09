import * as React from 'react';
import type { ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { DaemonProviderModelRowV1 } from '@happier-dev/protocol/rpc';
import { beginProviderConnectionModelsRead, getProviderConnectionModelsSnapshot, subscribeProviderModelProjectionSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';

import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { useProviderModelQueryRetention } from './useProviderModelQueryRetention';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';

const EMPTY_MODELS: readonly DaemonProviderModelRowV1[] = Object.freeze([]);

export function useProviderConnectionModels(input: Readonly<{
    enabled: boolean;
    active?: boolean;
    machineId: string | null;
    serverId: string | null;
    connectionId: string;
}>) {
    const { describeProviderConnectionModels, ready, pendingApproval, accountScope: { resolution, binding } } = useProviderActionClient(input.serverId);
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const [error, setError] = React.useState<ProviderErrorV1 | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [stateScopeKey, setStateScopeKey] = React.useState<string | null>(null);
    const [stateAccountLifetime, setStateAccountLifetime] = React.useState<
        ActiveServerAccountScopeLifetime | null
    >(null);
    const generation = React.useRef(0);
    const pendingRead = React.useRef<AbortController | null>(null);
    const activeRef = React.useRef(input.active !== false);
    activeRef.current = input.active !== false;
    const currentAccountLifetimeRef = React.useRef(accountLifetime);
    currentAccountLifetimeRef.current = accountLifetime;
    const stateAccountLifetimeRef = React.useRef(stateAccountLifetime);
    stateAccountLifetimeRef.current = stateAccountLifetime;
    const stateScopeKeyRef = React.useRef(stateScopeKey);
    stateScopeKeyRef.current = stateScopeKey;
    const scopeKey = JSON.stringify([input.enabled, input.machineId, input.connectionId,
        resolution.kind === 'bound' ? serverAccountScopeKeySuffix(resolution.scope) : input.serverId,
        binding?.credentialKey ?? null]);
    const queryKey = JSON.stringify(['connection-models', scopeKey]);
    const scopeEnabled = Boolean(input.enabled && input.connectionId);
    const readSnapshot = React.useCallback(() => scopeEnabled && binding?.credentialKey && binding.isCurrent()
        && (accountLifetime?.isCurrent() ?? true)
        ? getProviderConnectionModelsSnapshot(binding.scope, binding.credentialKey, queryKey) : null,
    [accountLifetime, binding, scopeEnabled, queryKey]);
    const subscribeSnapshot = React.useCallback((listener: () => void) => scopeEnabled && input.active !== false
        && binding?.credentialKey && binding.isCurrent()
        ? subscribeProviderModelProjectionSnapshot(binding.scope, binding.credentialKey, queryKey, listener) : () => {},
    [binding, input.active, scopeEnabled, queryKey]);
    const data = React.useSyncExternalStore(subscribeSnapshot, readSnapshot, readSnapshot);
    useProviderModelQueryRetention(scopeEnabled ? binding?.scope ?? null : null, binding?.credentialKey ?? null, queryKey);

    React.useEffect(() => {
        const registration = accountLifetime?.onRetire(() => {
            if (currentAccountLifetimeRef.current !== accountLifetime) return;
            generation.current += 1;
            if (stateAccountLifetimeRef.current !== accountLifetime) return;
            stateAccountLifetimeRef.current = null;
            stateScopeKeyRef.current = null;
            setStateAccountLifetime(null);
            setStateScopeKey(null);
            setError(null);
            setLoading(false);
        });
        return () => registration?.dispose();
    }, [accountLifetime]);

    const refreshWithResult = React.useCallback(async () => {
        if (!activeRef.current) return null;
        const requestGeneration = ++generation.current;
        const requestStillCurrent = (): boolean => (
            currentAccountLifetimeRef.current === accountLifetime
            && (accountLifetime?.isCurrent() ?? true)
            && binding?.isCurrent() === true
        );
        if (!requestStillCurrent()) return null;
        if (!input.enabled || !input.connectionId) {
            stateAccountLifetimeRef.current = accountLifetime;
            stateScopeKeyRef.current = scopeKey;
            setStateAccountLifetime(accountLifetime);
            setStateScopeKey(scopeKey);
            setError(null);
            setLoading(false);
            return null;
        }
        if (!ready || !binding?.credentialKey) return null;
        pendingRead.current?.abort();
        const controller = new AbortController();
        pendingRead.current = controller;
        if (
            stateScopeKeyRef.current !== scopeKey
            || stateAccountLifetimeRef.current !== accountLifetime
        ) {
            stateAccountLifetimeRef.current = accountLifetime;
            stateScopeKeyRef.current = scopeKey;
            setStateAccountLifetime(accountLifetime);
            setStateScopeKey(scopeKey);
            setError(null);
        }
        setLoading(true);
        const publish = beginProviderConnectionModelsRead(binding.scope, binding.credentialKey, queryKey);
        try {
            const result = await describeProviderConnectionModels({
                ...(input.machineId ? { machineId: input.machineId } : {}),
                serverId: input.serverId,
                connectionId: input.connectionId,
            }, { signal: controller.signal });
            if (generation.current !== requestGeneration || !requestStillCurrent()) return null;
            if (result.status === 'success') {
                stateAccountLifetimeRef.current = accountLifetime;
                stateScopeKeyRef.current = scopeKey;
                setStateAccountLifetime(accountLifetime);
                setStateScopeKey(scopeKey);
                publish(result);
                setError(null);
            } else {
                setError(result.error);
            }
            return result;
        } catch (caught) {
            if (generation.current !== requestGeneration || !requestStillCurrent()) return null;
            const error = providerErrorFromRpcFailure(caught, {
                connectionId: input.connectionId,
                ...(input.machineId ? { machineId: input.machineId } : {}),
            });
            stateAccountLifetimeRef.current = accountLifetime;
            stateScopeKeyRef.current = scopeKey;
            setStateAccountLifetime(accountLifetime);
            setStateScopeKey(scopeKey);
            setError(error);
            return { status: 'error' as const, error };
        } finally {
            if (pendingRead.current === controller) pendingRead.current = null;
            if (generation.current === requestGeneration && requestStillCurrent()) setLoading(false);
        }
    }, [accountLifetime, binding, describeProviderConnectionModels, ready, input.connectionId, input.enabled, input.machineId, input.serverId, queryKey, scopeKey]);

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
            setError(null);
        }
        void refreshWithResult();
        return () => {
            generation.current += 1;
            pendingRead.current?.abort();
            pendingRead.current = null;
        };
    }, [accountLifetime, input.active, refreshWithResult, scopeKey]);

    const stateMatchesScope = stateScopeKey === scopeKey
        && stateAccountLifetime === accountLifetime;
    return {
        models: data?.models ?? EMPTY_MODELS,
        connectionRevision: data?.connectionRevision ?? null,
        manualModelPolicy: data?.manualModelPolicy ?? null,
        modelLoadAction: data?.modelLoadAction ?? null,
        error: stateMatchesScope ? error : null,
        loading: input.active !== false && scopeEnabled
            && (resolution.kind === 'resolving' || resolution.kind === 'bound')
            && (!ready || !stateMatchesScope || loading),
        refresh,
        refreshWithResult,
        pendingApproval,
    };
}
