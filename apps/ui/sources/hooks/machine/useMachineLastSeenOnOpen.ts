import * as React from 'react';

import { readMachineRows } from '@/sync/api/machines/machineRowsApi';
import { getStorage } from '@/sync/domains/state/storageStore';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext, withActionAccountRequestSignal } from '@/sync/ops/actions/actionAccountContext';
import { fireAndForget } from '@/utils/system/fireAndForget';

type LastSeenSnapshot = ReadonlyMap<string, ReadonlyMap<string, number>>;
const EMPTY_LAST_SEEN: LastSeenSnapshot = new Map();

/** Fresh timestamps for one opening; steady presence stays owned by the pushed activity slice. */
export function useMachineLastSeenOnOpen(targets: readonly Readonly<{ serverId: string; machineId: string }>[]): LastSeenSnapshot {
    const normalizedTargets = targets.map((target): [string, string] => [
        resolveServerProfileScopeIdForIdentifier(target.serverId), target.machineId.trim(),
    ]).filter(([serverId, machineId]) => serverId && machineId).sort(([leftHome, leftId], [rightHome, rightId]) =>
        leftHome.localeCompare(rightHome) || leftId.localeCompare(rightId));
    const targetsKey = JSON.stringify(normalizedTargets);
    const [snapshot, setSnapshot] = React.useState<Readonly<{ key: string; values: LastSeenSnapshot }>>({ key: targetsKey, values: EMPTY_LAST_SEEN });
    React.useEffect(() => {
        const groups = new Map<string, Set<string>>();
        for (const [serverId, machineId] of JSON.parse(targetsKey) as [string, string][]) {
            const ids = groups.get(serverId) ?? new Set<string>();
            ids.add(machineId);
            groups.set(serverId, ids);
        }
        const cancellation = new AbortController();
        for (const [serverId, machineIds] of groups) fireAndForget((async () => {
            const account = await captureLazyActionAccountContext(serverId, cancellation.signal);
            try {
                const readTransport = account.readTransport;
                if (!readTransport) return;
                const rows = await withActionAccountRequestSignal(account, cancellation.signal, signal => readMachineRows({
                    readTransport, machineIds: [...machineIds], fresh: true, signal,
                }));
                account.assertCurrent();
                const values = new Map<string, number>();
                const updates = [...rows.values()].flatMap(row => {
                    if (!row || typeof row.activeAt !== 'number' || typeof row.active !== 'boolean') return [];
                    values.set(row.id, row.activeAt);
                    return [{ id: row.id, active: row.active, activeAt: row.activeAt }];
                });
                getStorage().getState().applyMachineActivityUpdates(updates, { sourceServerId: account.serverId, sourceAccountId: account.accountId });
                setSnapshot(previous => {
                    const next = new Map(previous.key === targetsKey ? previous.values : EMPTY_LAST_SEEN);
                    next.set(serverId, values);
                    return { key: targetsKey, values: next };
                });
            } finally { account.dispose(); }
        })(), { tag: 'MachineLastSeen.open' });
        return () => cancellation.abort();
    }, [targetsKey]);
    return snapshot.key === targetsKey ? snapshot.values : EMPTY_LAST_SEEN;
}
