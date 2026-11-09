import * as React from 'react';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';

import type { ServerScopedMachinePoolGroup } from '@/components/sessions/new/components/machineSelection/useMachineSelectionListModel';
import { useMachinePoolProjections, type MachinePoolProjectionScope } from '@/sync/engine/machines/useMachinePoolProjections';

import type { ServerScopedMachineGroup } from './useServerScopedMachineOptions';

export type MachinePoolGroup = ServerScopedMachinePoolGroup;

/**
 * Presentation mapper over the canonical Pool projection owner: it names the picker's Home and
 * carries that owner's status through. Feature decisions, refresh invalidation and readiness belong
 * to the projection; this hook must not re-derive them from rows or a failed resolve.
 */
export function useMachinePoolGroups(
    machineGroups: ReadonlyArray<
        Pick<ServerScopedMachineGroup, 'serverId' | 'serverName'> & MachinePoolProjectionScope
        & Partial<Pick<ServerScopedMachineGroup, 'loading' | 'signedOut' | 'error'>>
    >,
): MachinePoolGroup[] {
    const projections = useMachinePoolProjections(machineGroups);

    return React.useMemo(() => projections.map((projection, index) => ({
        serverId: projection.serverId,
        accountId: projection.accountId,
        serverName: machineGroups[index]?.serverName ?? resolveHomeDisplayLabel(getServerProfileById(projection.serverId), projection.serverId),
        pools: projection.pools.filter(pool => pool.access?.canResolve !== false),
        featureStatus: projection.featureStatus,
        // Feature discovery is part of this same Home projection's currentness. Retained rows stay
        // visible but cannot become selectable while that decision is unresolved or failed.
        status: machineGroups[index]?.error === true
            ? 'error'
            : machineGroups[index]?.signedOut === true
                ? 'signedOut'
                : machineGroups[index]?.loading === true || projection.featureStatus === 'loading'
                    ? 'loading'
                    : projection.featureStatus === 'error'
                        ? 'error'
                        : projection.status,
        projectionReady: projection.ready
            && machineGroups[index]?.loading !== true
            && machineGroups[index]?.signedOut !== true
            && machineGroups[index]?.error !== true,
    })), [machineGroups, projections]);
}
