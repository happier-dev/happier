import { MachineWorkSummaryV1Schema, type MachineWorkSummaryV1 } from '@happier-dev/protocol/machines/machineWorkSummaryV1';
import type { AccessibleMachineAccessV1 } from '@happier-dev/protocol/machines/machineAccessV1';

import type { LiveWorkCategoryV1, LiveWorkInventoryV1 } from '../lifecycle/managedActivity';
import type { RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';

const countColumn = {
    session: 'sessions', finite: 'tasks', terminal: 'terminals',
    execution_run: 'tasks', workflow_run: 'tasks',
    service: null, transfer: null, handoff: null, sync: null, setup: null, input: null,
} as const satisfies Record<LiveWorkCategoryV1, 'sessions' | 'tasks' | 'terminals' | null>;

/** Projects an already-authorized inventory; never reads work registries or private content. */
export function projectMachineWorkSummary(params: Readonly<{
    inventory: LiveWorkInventoryV1;
    target: Omit<RequesterWorkAttributionV1, 'accountId'>;
    custodianAccountId: string;
    requesterIdentities: ReadonlyMap<string, AccessibleMachineAccessV1['custodian']>;
}>): MachineWorkSummaryV1 {
    const unavailable = { kind: 'unavailable' } as const;
    if (params.inventory.coverage !== 'complete') return unavailable;

    const requesters = new Map<string, {
        accountId: string; displayName: string;
        sessions: Set<unknown>; tasks: Set<unknown>; terminals: Set<unknown>; taskTerminals: Set<unknown>;
    }>();
    for (const item of params.inventory.items) {
        const column = countColumn[item.category];
        // The Session producer includes only actual hosted processes. Its settled
        // state means runtime-idle for retention, not a closed retained Session.
        if (!column || (item.state === 'settled' && column !== 'sessions')) continue;
        if ('kind' in item.attribution) return unavailable;
        const attribution = item.attribution;
        if (attribution.serverId !== params.target.serverId
            || attribution.machineId !== params.target.machineId
            || attribution.installationId !== params.target.installationId) return unavailable;
        if (attribution.accountId === params.custodianAccountId) continue;
        if (item.state === 'unknown' || item.ownerRef === undefined || item.ownerRef === null) return unavailable;
        const identity = params.requesterIdentities.get(attribution.accountId);
        if (!identity || identity.accountId !== attribution.accountId) return unavailable;
        let requester = requesters.get(attribution.accountId);
        if (!requester) {
            requester = { accountId: identity.accountId, displayName: identity.displayName,
                sessions: new Set(), tasks: new Set(), terminals: new Set(), taskTerminals: new Set() };
            requesters.set(attribution.accountId, requester);
        }
        // Opaque canonical references have identity, not consumer-defined
        // structural equality. A repeated occurrence is counted once.
        requester[column].add(item.ownerRef);
        if (column === 'tasks' && item.associatedTerminal !== undefined) {
            requester.taskTerminals.add(item.associatedTerminal);
        }
    }

    const result = MachineWorkSummaryV1Schema.safeParse({ kind: 'current',
        requesters: [...requesters.values()].map((requester) => ({
            accountId: requester.accountId, displayName: requester.displayName,
            sessions: requester.sessions.size, tasks: requester.tasks.size,
            terminals: [...requester.terminals].filter((terminal) => !requester.taskTerminals.has(terminal)).length,
        })),
    });
    return result.success ? result.data : unavailable;
}
