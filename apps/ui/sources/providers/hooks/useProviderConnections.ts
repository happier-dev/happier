import * as React from 'react';
import type { DaemonProviderConnectionsDescribeResponseV1 } from '@happier-dev/protocol/rpc';

import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';

type Success = Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }>;
type ProviderConnectionsState = Readonly<{
    scopeKey: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    data: Success | null;
    error: Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'error' }>['error'] | null;
    loading: boolean;
}>;

type ConnectionReader = Readonly<{
    machineId: string | null;
    serverId: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    read: () => Promise<Success | null | undefined>;
}>;

// A collection and its open detail can describe different projections of the
// same target. Keep only active readers here; each hook still owns its data,
// errors, cancellation and Account lifetime.
const activeReaders = new Set<ConnectionReader>();

export function useProviderConnections(input: Readonly<{
    enabled: boolean;
    active?: boolean;
    machineId: string | null;
    serverId: string | null;
    connectionId?: string;
}>) {
    const { describeProviderConnections, ready } = useProviderActionClient(input.serverId);
    const active = input.active ?? true;
    const activeRef = React.useRef(active);
    activeRef.current = active;
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const [state, setState] = React.useState<ProviderConnectionsState>({
        scopeKey: null,
        accountLifetime: null,
        data: null,
        error: null,
        loading: false,
    });
    const generation = React.useRef(0);
    const currentAccountLifetimeRef = React.useRef(accountLifetime);
    currentAccountLifetimeRef.current = accountLifetime;
    const scopeKey = JSON.stringify([
        input.enabled,
        input.machineId,
        input.serverId,
        input.connectionId ?? null,
    ]);
    const stateMatchesScope = state.scopeKey === scopeKey
        && state.accountLifetime === accountLifetime;
    const scopeEnabled = input.enabled;
    const data = stateMatchesScope ? state.data : null;
    const error = stateMatchesScope ? state.error : null;
    const loading = active && scopeEnabled && (!ready || !stateMatchesScope || state.loading);

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

    const read = React.useCallback(async () => {
        if (!activeRef.current) return null;
        const requestGeneration = ++generation.current;
        const requestStillCurrent = (): boolean => (
            activeRef.current && currentAccountLifetimeRef.current === accountLifetime
            && (accountLifetime?.isCurrent() ?? true)
        );
        if (!requestStillCurrent()) return null;
        if (!input.enabled) {
            setState({ scopeKey, accountLifetime, data: null, error: null, loading: false });
            return null;
        }
        if (!ready) return null;
        const machineId = input.machineId;
        const serverId = input.serverId;
        setState((current) => current.scopeKey === scopeKey
            && current.accountLifetime === accountLifetime
            ? { ...current, loading: true }
            : { scopeKey, accountLifetime, data: null, error: null, loading: true });
        try {
            const result = await describeProviderConnections({
                ...(machineId ? { machineId } : {}),
                serverId,
                ...(input.connectionId ? { connectionId: input.connectionId } : {}),
            });
            if (requestGeneration !== generation.current || !requestStillCurrent()) return;
            if (result.status === 'success') {
                setState({ scopeKey, accountLifetime, data: result, error: null, loading: true });
                return result;
            } else {
                setState((current) => ({
                    accountLifetime,
                    scopeKey,
                    data: current.scopeKey === scopeKey && current.accountLifetime === accountLifetime
                        ? current.data
                        : null,
                    error: result.error,
                    loading: true,
                }));
            }
            return null;
        } catch (caught) {
            if (requestGeneration !== generation.current || !requestStillCurrent()) return;
            setState((current) => ({
                accountLifetime,
                scopeKey,
                data: current.scopeKey === scopeKey && current.accountLifetime === accountLifetime
                    ? current.data
                    : null,
                error: providerErrorFromRpcFailure(caught, {
                    ...(machineId ? { machineId } : {}),
                    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
                }),
                loading: true,
            }));
            return null;
        } finally {
            if (requestGeneration === generation.current && requestStillCurrent()) {
                setState((current) => current.scopeKey === scopeKey
                    && current.accountLifetime === accountLifetime
                    ? { ...current, loading: false }
                    : current);
            }
        }
    }, [accountLifetime, describeProviderConnections, ready, input.connectionId, input.enabled, input.machineId, input.serverId, scopeKey]);

    React.useEffect(() => {
        const reader = active && input.enabled
            ? { machineId: input.machineId, serverId: input.serverId, accountLifetime, read }
            : null;
        if (reader) activeReaders.add(reader);
        // Visibility pauses demand; it does not change the authority of a
        // retained projection or the metadata an editor draft was built from.
        setState((current) => current.scopeKey === scopeKey && current.accountLifetime === accountLifetime
            ? current
            : { scopeKey, accountLifetime, data: null, error: null, loading: false });
        void read();
        return () => {
            generation.current += 1;
            if (reader) activeReaders.delete(reader);
        };
    }, [accountLifetime, active, input.enabled, input.machineId, input.serverId, read, scopeKey]);

    const refresh = React.useCallback(async () => {
        const ownRead = read();
        if (input.enabled
            && currentAccountLifetimeRef.current === accountLifetime
            && (accountLifetime?.isCurrent() ?? true)) {
            // Invoke private reads, never peer refreshes, so this cannot recurse.
            // Each read presents its own failure without failing a successful write.
            for (const reader of activeReaders) {
                if (reader.read !== read
                    && reader.machineId === input.machineId
                    && reader.serverId === input.serverId
                    && reader.accountLifetime === accountLifetime) {
                    void reader.read();
                }
            }
        }
        return await ownRead;
    }, [accountLifetime, input.enabled, input.machineId, input.serverId, read]);

    return { data, error, loading, refresh };
}
