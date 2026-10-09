import * as React from 'react';
import type { ProjectWorkerStatusInputV1, ProjectWorkerStatusResultV1 } from '@happier-dev/protocol';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import type { MachineDestinationPurposeV1 } from '@happier-dev/protocol/machines/pools';

import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { executeProjectWorkerActionV1 } from '@/sync/ops/actions/projectWorkerActions';
import { resolveMachinePickerPresence } from '@/components/sessions/new/components/resolveMachinePickerPresence';
import type { MachineDestinationPlacementFacts } from '@/components/sessions/new/components/machineSelection/buildMachineDestinationModel';

export type MachineDestinationWorkerPlacement = Readonly<Pick<ProjectWorkerStatusInputV1, 'workspace' | 'memoryDemand'>>;
type WorkerStatusMachine = MachineDisplayRenderable & Partial<Pick<Machine, 'daemonStateVersion' | 'operationProtocolCapabilitiesRevision'>>;

/** List and dropdown share demand-local status, not a global load cache or an eligibility fallback. */
export function useMachineDestinationWorkerStatus(params: Readonly<{
    purpose: MachineDestinationPurposeV1;
    workerPlacement?: MachineDestinationWorkerPlacement;
    groups: readonly Readonly<{
        serverId: string;
        machines: readonly WorkerStatusMachine[];
        loading: boolean;
        signedOut: boolean;
        error?: boolean;
    }>[];
}>) {
    const purpose = params.purpose === 'finite' || params.purpose === 'service-start' ? params.purpose : null;
    const request = purpose ? params.workerPlacement : undefined;
    const { binding } = useServerCredentialAccountScopeBinding(request?.workspace.serverId);
    const candidates = new Map(params.groups.flatMap(group => {
        if (!request || group.serverId !== request.workspace.serverId || group.loading || group.signedOut || group.error) return [];
        return group.machines.filter(machine => resolveMachinePickerPresence(machine).selectable).map(machine => [machine.id, machine] as const);
    }));
    const candidateIds = [...candidates.keys()].sort();
    const candidateHints = candidateIds.map(id => {
        const machine = candidates.get(id)!;
        // These are admitted producer revisions/access hints, not load or
        // eligibility. Heartbeat activeAt never causes another status demand.
        return [id, machine.metadataVersion, machine.daemonStateVersion ?? null,
            machine.operationProtocolCapabilitiesRevision ?? null, machine.isShared ?? false,
            machine.access ?? null, machine.availability ?? null];
    });
    const readOperationHint = () => {
        if (!purpose || !request || !binding || !binding.isCurrent()) return '';
        const hints: string[] = [];
        for (const operation of actionOperationStore.getSnapshot().operationsByKey.values()) {
            const snapshot = operation.snapshot;
            if (!Object.prototype.hasOwnProperty.call(PROJECT_FINITE_ACTION_RPC_METHODS_V1, snapshot.actionId)
                || operation.serverId !== binding.serverId || snapshot.scope.accountId !== binding.accountId
                || !candidates.has(snapshot.scope.machineId)) continue;
            // Reserved preparation affects load before the OS-launch state changes.
            // Labels, revisions and queue-position counters are not admission facts.
            const preparing = snapshot.progress?.kind === 'phase' && snapshot.progress.phase === 'preparing';
            hints.push(JSON.stringify([snapshot.scope.machineId, snapshot.operationId, snapshot.state, preparing]));
        }
        // A primitive scoped hint keeps unrelated pushes and label-only updates inert.
        return JSON.stringify(hints.sort());
    };
    const operationHint = React.useSyncExternalStore(actionOperationStore.subscribe, readOperationHint, readOperationHint);
    const demandKey = JSON.stringify([purpose, request ?? null,
        binding ? [binding.serverId, binding.accountId, binding.revision] : null, candidateHints, operationHint]);
    const [projection, setProjection] = React.useState<Readonly<{
        demandKey: string;
        statuses: ReadonlyMap<string, ProjectWorkerStatusResultV1>;
        failed?: ReadonlySet<string>;
    }> | null>(null);

    React.useEffect(() => {
        if (!purpose || !request || !binding || !binding.isCurrent()) return;
        let current = true;
        const retirement = binding.onRetire(() => {
            current = false;
            setProjection(null);
        });
        for (const machineId of candidateIds) {
            void executeProjectWorkerActionV1('projects.worker.status', {
                ...request, destination: { kind: 'machine', machineId }, purpose,
            }, { expectedAccountId: binding.accountId }).then(worker => {
                if (!current || !binding.isCurrent()) return;
                setProjection(previous => {
                    const statuses = new Map(previous?.demandKey === demandKey ? previous.statuses : []);
                    statuses.set(machineId, worker);
                    const failed = new Set(previous?.demandKey === demandKey ? previous.failed : []);
                    failed.delete(machineId);
                    return { demandKey, statuses, failed };
                });
            }).catch(() => {
                // Failed reads establish neither eligibility nor zero load. The
                // canonical model retains its status-unavailable refusal and
                // stops saying it is still checking.
                if (!current || !binding.isCurrent()) return;
                setProjection(previous => {
                    const statuses = previous?.demandKey === demandKey ? previous.statuses : new Map();
                    const failed = new Set(previous?.demandKey === demandKey ? previous.failed : []);
                    failed.add(machineId);
                    return { demandKey, statuses, failed };
                });
            });
        }
        return () => {
            current = false;
            retirement.dispose();
        };
        // Domain values and the exact credential revision, not wrapper identities, own a demand.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [demandKey, binding]);

    return React.useCallback((machine: MachineDisplayRenderable, serverId: string): MachineDestinationPlacementFacts => {
        const current = binding?.isCurrent() && request?.workspace.serverId === serverId && projection?.demandKey === demandKey
            ? projection : null;
        const worker = current?.statuses.get(machine.id);
        const failed = current?.failed?.has(machine.id) === true;
        return { ownership: machine.isShared === true ? 'shared' : 'owned', ...(worker ? { worker } : failed ? { workerStatusFailed: true } : {}) };
    }, [binding, demandKey, projection, request?.workspace.serverId]);
}
