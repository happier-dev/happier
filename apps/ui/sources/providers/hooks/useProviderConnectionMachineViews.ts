import * as React from 'react';
import { createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol';
import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';

import {
    providerSettingsMachineRowKey,
    type ProviderSettingsMachineRowV1,
} from '@/providers/hooks/targetMachine';
import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { beginProviderConnectionCheckRead, getProviderConnectionCheckSnapshot, providerConnectionCheckQueryKey,
    subscribeProviderModelProjectionSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';
import { registerProviderConnectionReader, type ProviderConnectionReadTarget } from './providerConnectionRefresh';
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
    accountScopesByTargetKey: Readonly<Record<string, ServerAccountScope>>;
    loading: boolean;
}>;

const sameAccountScope = (left: ServerAccountScope | undefined, right: ServerAccountScope | undefined) => (
    (!left && !right) || areServerAccountScopesEqual(left, right)
);

/**
 * Per-machine daemon facts for one Provider connection. Each row is addressed
 * by its full `{ serverIdentityId, machineId }` tuple and requested through
 * that row's own server profile, so a machine id shared by two profiles can
 * never be read from the wrong daemon.
 */
export function useProviderConnectionMachineViews(input: Readonly<{
    enabled: boolean;
    active?: boolean;
    connectionId: string;
    targets: readonly ProviderSettingsMachineRowV1[];
}>) {
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const [state, setState] = React.useState<ProviderConnectionMachineViewsState>({
        scopeKey: null,
        accountLifetime: null,
        byTargetKey: {},
        accountScopesByTargetKey: {},
        loading: false,
    });
    const generation = React.useRef(0);
    const latestReadByTarget = React.useRef(new Map<string, AbortController>());
    const activeRef = React.useRef(input.active !== false);
    activeRef.current = input.active !== false;
    const targetsRef = React.useRef(input.targets);
    targetsRef.current = input.targets;
    const targetsKey = JSON.stringify(
        input.targets
            .map((row) => [providerSettingsMachineRowKey(row.target), row.serverId] as const)
            .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
    );
    const { describeProviderConnections, ready, pendingApproval, scopeStates: credentialStates, scopeKey: actionScopeKey } = useProviderActionClient(input.targets.map(row => row.serverId));
    const scopeKey = JSON.stringify([input.enabled, input.connectionId, targetsKey, actionScopeKey]);
    const accountScopesByTargetKey = React.useMemo(() => {
        const scopes: Record<string, ServerAccountScope> = {};
        for (const row of input.targets) {
            const resolution = credentialStates.get(resolveServerProfileScopeIdForIdentifier(row.serverId))?.resolution;
            if (resolution?.kind === 'bound') scopes[providerSettingsMachineRowKey(row.target)] = resolution.scope;
        }
        return scopes;
    }, [credentialStates, targetsKey]);
    const scopeEnabled = input.enabled && input.targets.length > 0;
    const stateMatchesScope = state.scopeKey === scopeKey
        && state.accountLifetime === accountLifetime;
    const stateMatchesPeerAccounts = Object.keys(state.byTargetKey).every(key => sameAccountScope(
        state.accountScopesByTargetKey[key], accountScopesByTargetKey[key],
    ));
    const capturedByTargetKey = React.useMemo(() => {
        if (!stateMatchesScope) return {};
        if (stateMatchesPeerAccounts) return state.byTargetKey;
        return Object.fromEntries(Object.entries(state.byTargetKey).map(([key, view]) => [key,
            sameAccountScope(state.accountScopesByTargetKey[key], accountScopesByTargetKey[key])
                ? view
                : { status: 'loading', connection: null } satisfies ProviderConnectionMachineViewState,
        ]));
    }, [accountScopesByTargetKey, state, stateMatchesPeerAccounts, stateMatchesScope]);
    const cachedSnapshots = React.useRef<readonly ReturnType<typeof getProviderConnectionCheckSnapshot>[]>([]);
    const readSnapshots = React.useCallback(() => {
        const next = targetsRef.current.map(row => {
            const binding = credentialStates.get(resolveServerProfileScopeIdForIdentifier(row.serverId))?.binding;
            return scopeEnabled && binding?.credentialKey && binding.isCurrent() && (accountLifetime?.isCurrent() ?? true)
                ? getProviderConnectionCheckSnapshot(binding.scope, binding.credentialKey,
                    providerConnectionCheckQueryKey(row.target.machineId, input.connectionId)) : null;
        });
        if (next.length !== cachedSnapshots.current.length || next.some((value, index) => value !== cachedSnapshots.current[index])) {
            cachedSnapshots.current = next;
        }
        return cachedSnapshots.current;
    }, [accountLifetime, credentialStates, input.connectionId, scopeEnabled, targetsKey]);
    const subscribeSnapshots = React.useCallback((listener: () => void) => {
        if (input.active === false || !scopeEnabled) return () => {};
        const releases = targetsRef.current.flatMap(row => {
            const binding = credentialStates.get(resolveServerProfileScopeIdForIdentifier(row.serverId))?.binding;
            return binding?.credentialKey && binding.isCurrent() ? [subscribeProviderModelProjectionSnapshot(
                binding.scope, binding.credentialKey, providerConnectionCheckQueryKey(row.target.machineId, input.connectionId), listener,
            )] : [];
        });
        return () => { for (const release of releases) release(); };
    }, [credentialStates, input.active, input.connectionId, scopeEnabled, targetsKey]);
    const snapshots = React.useSyncExternalStore(subscribeSnapshots, readSnapshots, readSnapshots);
    const byTargetKey = React.useMemo(() => {
        let projected: Record<string, ProviderConnectionMachineViewState> | null = null;
        targetsRef.current.forEach((row, index) => {
            const key = providerSettingsMachineRowKey(row.target);
            const captured = capturedByTargetKey[key];
            const cached = snapshots[index];
            // Mounted responses keep their captured peer basis; a new view paints
            // the resource owner's last-known check while its own Action revalidates.
            if (cached && (!captured || captured.status === 'loading' && captured.connection === null)) {
                projected ??= { ...capturedByTargetKey };
                projected[key] = { status: 'loading', connection: cached.connections.find(connection => connection.connectionId === input.connectionId) ?? null };
            }
        });
        return projected ?? capturedByTargetKey;
    }, [capturedByTargetKey, input.connectionId, snapshots, targetsKey]);
    const currentAccountLifetimeRef = React.useRef(accountLifetime);
    currentAccountLifetimeRef.current = accountLifetime;

    React.useEffect(() => {
        const registration = accountLifetime?.onRetire(() => {
            if (currentAccountLifetimeRef.current !== accountLifetime) return;
            generation.current += 1;
            setState((current) => current.accountLifetime === accountLifetime
                ? { scopeKey: null, accountLifetime: null, byTargetKey: {}, accountScopesByTargetKey: {}, loading: false }
                : current);
        });
        return () => registration?.dispose();
    }, [accountLifetime]);

    const read = React.useCallback(async (requestedTargets?: readonly ProviderConnectionReadTarget[]) => {
        if (!activeRef.current) return;
        const requestGeneration = generation.current;
        const requestStillCurrent = (): boolean => (
            activeRef.current && generation.current === requestGeneration
            && currentAccountLifetimeRef.current === accountLifetime
            && (accountLifetime?.isCurrent() ?? true)
        );
        if (!requestStillCurrent()) return;
        if (!input.enabled || targetsRef.current.length === 0) {
            setState({ scopeKey, accountLifetime, byTargetKey: {}, accountScopesByTargetKey: {}, loading: false });
            return;
        }
        const targets = requestedTargets
            ? targetsRef.current.filter(row => requestedTargets.some(target =>
                target.serverId === row.serverId && target.machineId === row.target.machineId))
            : targetsRef.current;
        if (targets.length === 0) return;
        if (!ready) return;
        const requestControllers = new Map<string, AbortController>();
        for (const row of targets) {
            const key = providerSettingsMachineRowKey(row.target);
            latestReadByTarget.current.get(key)?.abort();
            const controller = new AbortController();
            requestControllers.set(key, controller);
            latestReadByTarget.current.set(key, controller);
        }
        setState((current) => {
            const previousByTargetKey = current.scopeKey === scopeKey
                && current.accountLifetime === accountLifetime
                ? current.byTargetKey
                : {};
            return {
                scopeKey,
                accountLifetime,
                accountScopesByTargetKey,
                byTargetKey: { ...previousByTargetKey, ...Object.fromEntries(targets.map((row) => {
                    const key = providerSettingsMachineRowKey(row.target);
                    const previous = sameAccountScope(current.accountScopesByTargetKey[key], accountScopesByTargetKey[key])
                        ? previousByTargetKey[key]
                        : undefined;
                    return [key, {
                        status: 'loading',
                        connection: previous?.status === 'success' || previous?.status === 'loading'
                            ? previous.connection
                            : null,
                    } satisfies ProviderConnectionMachineViewState];
                })) },
                loading: true,
            };
        });
        const settle = (key: string, entry: ProviderConnectionMachineViewState) => {
            if (!requestStillCurrent() || latestReadByTarget.current.get(key) !== requestControllers.get(key)) return;
            setState(current => {
                if (current.scopeKey !== scopeKey || current.accountLifetime !== accountLifetime) return current;
                const byTargetKey = { ...current.byTargetKey, [key]: entry };
                return { ...current, byTargetKey, loading: Object.values(byTargetKey).some(value => value.status === 'loading') };
            });
        };
        await Promise.all(targets.map(async (row) => {
            const key = providerSettingsMachineRowKey(row.target);
            const machineId = row.target.machineId;
            const binding = credentialStates.get(resolveServerProfileScopeIdForIdentifier(row.serverId))?.binding;
            if (!binding || !binding.isCurrent()) {
                return settle(key, { status: 'error', error: createProviderErrorV1('provider_authorization_changed', {
                    connectionId: input.connectionId, machineId,
                }) });
            }
            try {
                const publish = binding.credentialKey ? beginProviderConnectionCheckRead(binding.scope, binding.credentialKey,
                    providerConnectionCheckQueryKey(machineId, input.connectionId)) : null;
                const result = await describeProviderConnections({
                    machineId, serverId: row.serverId, connectionId: input.connectionId,
                }, { signal: requestControllers.get(key)!.signal });
                if (!binding.isCurrent()) return settle(key, { status: 'error',
                    error: createProviderErrorV1('provider_authorization_changed', { connectionId: input.connectionId, machineId }),
                });
                if (result.status === 'success' && requestStillCurrent() && !requestControllers.get(key)!.signal.aborted) publish?.(result);
                return settle(key, result.status === 'success'
                    ? { status: 'success', connection: result.connections.find(connection => connection.connectionId === input.connectionId) ?? null }
                    : { status: 'error', error: result.error });
            } catch (caught) {
                return settle(key, { status: 'error', error: providerErrorFromRpcFailure(caught, {
                    connectionId: input.connectionId, machineId,
                }) });
            }
        }));
    }, [accountLifetime, accountScopesByTargetKey, credentialStates, describeProviderConnections, input.connectionId, input.enabled, ready, scopeKey, targetsKey]);

    React.useEffect(() => {
        const unregister = input.active !== false && scopeEnabled
            ? registerProviderConnectionReader({
                targets: targetsRef.current.map(row => ({ machineId: row.target.machineId, serverId: row.serverId })),
                accountLifetime,
                read,
            })
            : null;
        void read();
        return () => {
            generation.current += 1;
            for (const controller of latestReadByTarget.current.values()) controller.abort();
            latestReadByTarget.current.clear();
            unregister?.();
        };
    }, [accountLifetime, input.active, read, scopeEnabled, scopeKey]);

    const refresh = React.useCallback(async (target?: ProviderSettingsMachineRowV1['target']) => {
        await read(target ? targetsRef.current
            .filter(row => providerSettingsMachineRowKey(row.target) === providerSettingsMachineRowKey(target))
            .map(row => ({ machineId: row.target.machineId, serverId: row.serverId })) : undefined);
    }, [read]);

    return {
        byTargetKey,
        loading: input.active !== false && scopeEnabled && (!stateMatchesScope || !stateMatchesPeerAccounts || state.loading),
        refresh,
        pendingApproval,
    };
}
