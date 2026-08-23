import * as React from 'react';
import type { ProviderErrorV1 } from '@happier-dev/protocol';
import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';

import {
    providerSettingsMachineRowKey,
    type ProviderSettingsMachineRowV1,
} from '@/providers/hooks/targetMachine';
import { describeProviderConnections, providerErrorFromRpcFailure } from '@/providers/rpc/client';

export type ProviderConnectionMachineViewState =
    | Readonly<{ status: 'loading'; connection: DaemonProviderConnectionViewV1 | null }>
    | Readonly<{ status: 'success'; connection: DaemonProviderConnectionViewV1 | null }>
    | Readonly<{ status: 'error'; error: ProviderErrorV1 }>;

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
    const [byTargetKey, setByTargetKey] = React.useState<Readonly<Record<string, ProviderConnectionMachineViewState>>>({});
    const [loading, setLoading] = React.useState(false);
    const generation = React.useRef(0);
    const targetsRef = React.useRef(input.targets);
    targetsRef.current = input.targets;
    const targetsKey = JSON.stringify(
        input.targets
            .map((row) => [providerSettingsMachineRowKey(row.target), row.serverId] as const)
            .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
    );

    const refresh = React.useCallback(async () => {
        const requestGeneration = ++generation.current;
        const targets = targetsRef.current;
        if (!input.enabled || targets.length === 0) {
            setByTargetKey({});
            setLoading(false);
            return;
        }
        setLoading(true);
        setByTargetKey((current) => Object.fromEntries(targets.map((row) => {
            const key = providerSettingsMachineRowKey(row.target);
            const previous = current[key];
            return [key, {
                status: 'loading',
                connection: previous?.status === 'success' || previous?.status === 'loading'
                    ? previous.connection
                    : null,
            } satisfies ProviderConnectionMachineViewState];
        })));
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
        if (generation.current !== requestGeneration) return;
        setByTargetKey(Object.fromEntries(entries));
        setLoading(false);
    }, [input.connectionId, input.enabled, targetsKey]);

    React.useEffect(() => {
        void refresh();
        return () => { generation.current += 1; };
    }, [refresh]);

    return { byTargetKey, loading, refresh };
}
