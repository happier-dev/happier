import * as React from 'react';
import type { DaemonProviderConnectionsDescribeResponseV1 } from '@happier-dev/protocol/rpc';

import { describeProviderConnections, providerErrorFromRpcFailure } from '@/providers/rpc/client';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';

type Success = Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }>;
type ProviderConnectionsState = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    data: Success | null;
    error: Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'error' }>['error'] | null;
    loading: boolean;
}>;

export function useProviderConnections(input: Readonly<{
    enabled: boolean;
    machineId: string | null;
    serverId: string | null;
    connectionId?: string;
}>) {
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const [state, setState] = React.useState<ProviderConnectionsState>({
        accountLifetime: null,
        data: null,
        error: null,
        loading: false,
    });
    const generation = React.useRef(0);
    const currentAccountLifetimeRef = React.useRef(accountLifetime);
    currentAccountLifetimeRef.current = accountLifetime;
    const stateMatchesAccountLifetime = state.accountLifetime === accountLifetime;
    const scopeEnabled = Boolean(input.enabled && input.machineId);
    const data = stateMatchesAccountLifetime ? state.data : null;
    const error = stateMatchesAccountLifetime ? state.error : null;
    const loading = scopeEnabled && (!stateMatchesAccountLifetime || state.loading);

    React.useEffect(() => {
        const registration = accountLifetime?.onRetire(() => {
            if (currentAccountLifetimeRef.current !== accountLifetime) return;
            generation.current += 1;
            setState((current) => current.accountLifetime === accountLifetime
                ? { accountLifetime: null, data: null, error: null, loading: false }
                : current);
        });
        return () => registration?.dispose();
    }, [accountLifetime]);

    const refresh = React.useCallback(async () => {
        const requestGeneration = ++generation.current;
        const requestStillCurrent = (): boolean => (
            currentAccountLifetimeRef.current === accountLifetime
            && (accountLifetime?.isCurrent() ?? true)
        );
        if (!requestStillCurrent()) return;
        if (!input.enabled || !input.machineId) {
            setState({ accountLifetime, data: null, error: null, loading: false });
            return;
        }
        const machineId = input.machineId;
        const serverId = input.serverId;
        setState((current) => current.accountLifetime === accountLifetime
            ? { ...current, loading: true }
            : { accountLifetime, data: null, error: null, loading: true });
        try {
            const result = await describeProviderConnections({
                machineId,
                serverId,
                ...(input.connectionId ? { connectionId: input.connectionId } : {}),
            });
            if (requestGeneration !== generation.current || !requestStillCurrent()) return;
            if (result.status === 'success') {
                setState({ accountLifetime, data: result, error: null, loading: true });
            } else {
                setState((current) => ({
                    accountLifetime,
                    data: current.accountLifetime === accountLifetime ? current.data : null,
                    error: result.error,
                    loading: true,
                }));
            }
        } catch (caught) {
            if (requestGeneration !== generation.current || !requestStillCurrent()) return;
            setState((current) => ({
                accountLifetime,
                data: current.accountLifetime === accountLifetime ? current.data : null,
                error: providerErrorFromRpcFailure(caught, {
                    machineId,
                    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
                }),
                loading: true,
            }));
        } finally {
            if (requestGeneration === generation.current && requestStillCurrent()) {
                setState((current) => current.accountLifetime === accountLifetime
                    ? { ...current, loading: false }
                    : current);
            }
        }
    }, [accountLifetime, input.connectionId, input.enabled, input.machineId, input.serverId]);

    React.useEffect(() => {
        setState({ accountLifetime, data: null, error: null, loading: false });
        void refresh();
        return () => { generation.current += 1; };
    }, [accountLifetime, refresh]);

    return { data, error, loading, refresh };
}
