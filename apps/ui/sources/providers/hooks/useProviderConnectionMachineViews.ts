import * as React from 'react';
import type { ProviderErrorV1 } from '@happier-dev/protocol';
import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';

import {
    providerSettingsMachineRowKey,
    type ProviderSettingsMachineRowV1,
} from '@/providers/hooks/targetMachine';
import { describeProviderConnections, providerErrorFromRpcFailure } from '@/providers/rpc/client';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';

export type ProviderConnectionMachineViewState =
    | Readonly<{ status: 'loading'; connection: DaemonProviderConnectionViewV1 | null }>
    | Readonly<{ status: 'success'; connection: DaemonProviderConnectionViewV1 | null }>
    | Readonly<{ status: 'error'; error: ProviderErrorV1 }>;

type ProviderConnectionMachineViewsState = Readonly<{
    scopeKey: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    byTargetKey: Readonly<Record<string, ProviderConnectionMachineViewState>>;
    loading: boolean;
}>;

/**
 * Per-machine daemon facts for one Provider connection. Each row is addressed
 * by its full `{ serverIdentityId, machineId }` tuple and requested through
 * that row's own server profile, so a machine id shared by two profiles can
 * never be read from the wrong daemon.
 */
export function useProviderConnectionMachineViews(input: Readonly<{
    enabled: boolean;
    connectionId: string;
    targets: readonly ProviderSettingsMachineRowV1[];
}>) {
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const [state, setState] = React.useState<ProviderConnectionMachineViewsState>({
        scopeKey: null,
        accountLifetime: null,
        byTargetKey: {},
        loading: false,
    });
    const generation = React.useRef(0);
    const targetsRef = React.useRef(input.targets);
    targetsRef.current = input.targets;
    const targetsKey = JSON.stringify(
        input.targets
            .map((row) => [providerSettingsMachineRowKey(row.target), row.serverId] as const)
            .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
    );
    const scopeKey = JSON.stringify([input.enabled, input.connectionId, targetsKey]);
    const scopeEnabled = input.enabled && input.targets.length > 0;
    const stateMatchesScope = state.scopeKey === scopeKey
        && state.accountLifetime === accountLifetime;
    const currentAccountLifetimeRef = React.useRef(accountLifetime);
    currentAccountLifetimeRef.current = accountLifetime;

    React.useEffect(() => {
        const registration = accountLifetime?.onRetire(() => {
            if (currentAccountLifetimeRef.current !== accountLifetime) return;
            generation.current += 1;
            setState((current) => current.accountLifetime === accountLifetime
                ? { scopeKey: null, accountLifetime: null, byTargetKey: {}, loading: false }
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
        const targets = targetsRef.current;
        if (!input.enabled || targets.length === 0) {
            setState({ scopeKey, accountLifetime, byTargetKey: {}, loading: false });
            return;
        }
        setState((current) => {
            const previousByTargetKey = current.scopeKey === scopeKey
                && current.accountLifetime === accountLifetime
                ? current.byTargetKey
                : {};
            return {
                scopeKey,
                accountLifetime,
                byTargetKey: Object.fromEntries(targets.map((row) => {
                    const key = providerSettingsMachineRowKey(row.target);
                    const previous = previousByTargetKey[key];
                    return [key, {
                        status: 'loading',
                        connection: previous?.status === 'success' || previous?.status === 'loading'
                            ? previous.connection
                            : null,
                    } satisfies ProviderConnectionMachineViewState];
                })),
                loading: true,
            };
        });
        const entries = await Promise.all(targets.map(async (row) => {
            const key = providerSettingsMachineRowKey(row.target);
            const machineId = row.target.machineId;
            try {
                const result = await describeProviderConnections({
                    machineId,
                    serverId: row.serverId,
                    connectionId: input.connectionId,
                });
                return [key, result.status === 'success'
                    ? {
                        status: 'success',
                        connection: result.connections.find((connection) => connection.connectionId === input.connectionId) ?? null,
                    } satisfies ProviderConnectionMachineViewState
                    : { status: 'error', error: result.error } satisfies ProviderConnectionMachineViewState] as const;
            } catch (caught) {
                return [key, {
                    status: 'error',
                    error: providerErrorFromRpcFailure(caught, {
                        connectionId: input.connectionId,
                        machineId,
                    }),
                } satisfies ProviderConnectionMachineViewState] as const;
            }
        }));
        if (generation.current !== requestGeneration || !requestStillCurrent()) return;
        setState({ scopeKey, accountLifetime, byTargetKey: Object.fromEntries(entries), loading: false });
    }, [accountLifetime, input.connectionId, input.enabled, scopeKey, targetsKey]);

    React.useEffect(() => {
        void refresh();
        return () => { generation.current += 1; };
    }, [accountLifetime, refresh, scopeKey]);

    return {
        byTargetKey: stateMatchesScope ? state.byTargetKey : {},
        loading: scopeEnabled && (!stateMatchesScope || state.loading),
        refresh,
    };
}
