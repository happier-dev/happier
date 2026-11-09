import * as React from 'react';
import { ensureMachineUpdateFactsBackground } from '@/capabilities/ensureAgentInstallablesBackground';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { subscribeMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import { subscribeMachineUpdateFactsInputs } from './machineUpdateFacts';

/** Each Machine keeps its reader while unrelated fleet members arrive or leave. */
export function useMachineUpdateFactsBackground(input: Readonly<{
    serverId: string;
    accountId: string | null | undefined;
    machineIds: readonly string[];
    enabled?: boolean;
}>): void {
    const readers = React.useRef(new Map<string, { dispose(): void }>());
    const enabled = input.enabled !== false;
    const idsKey = JSON.stringify([...new Set(input.machineIds)].sort());
    React.useEffect(() => {
        const clear = () => {
            for (const reader of readers.current.values()) reader.dispose();
            readers.current.clear();
        };
        const retirement = captureActiveServerAccountScopeLifetime()?.onRetire(clear);
        return () => { retirement?.dispose(); clear(); };
    }, [input.accountId, enabled, input.serverId]);
    React.useEffect(() => {
        const ids = new Set<string>(enabled ? JSON.parse(idsKey) : []);
        for (const [id, reader] of readers.current) {
            if (ids.has(id)) continue;
            reader.dispose();
            readers.current.delete(id);
        }
        for (const id of ids) {
            if (readers.current.has(id)) continue;
            const accountLifetime = captureActiveServerAccountScopeLifetime();
            const controller = new AbortController();
            const start = () => {
                void ensureMachineUpdateFactsBackground({ serverId: input.serverId, machineIds: [id], signal: controller.signal,
                    ...(accountLifetime ? { accountLifetime } : {}) });
            };
            const unsubscribe = subscribeMachineContributionRegistryProjectionInvalidation({ serverId: input.serverId, machineId: id }, start);
            const unsubscribeInputs = subscribeMachineUpdateFactsInputs({ serverId: input.serverId, machineId: id,
                accountId: accountLifetime?.scope.accountId }, start);
            readers.current.set(id, { dispose: () => { unsubscribe(); unsubscribeInputs(); controller.abort(); } });
            start();
        }
    }, [input.accountId, enabled, idsKey, input.serverId]);
}
