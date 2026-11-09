import * as React from 'react';
import type { ProjectWorkerStatusInputV1, ProjectWorkerStatusResultV1 } from '@happier-dev/protocol/actions/specs/projectWorkers';
import type { MachineDestinationPurposeV1 } from '@happier-dev/protocol/machines/pools';

import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { executeProjectWorkerActionV1 } from '@/sync/ops/actions/projectWorkerActions';
import { resolveMachinePickerPresence } from '@/components/sessions/new/components/resolveMachinePickerPresence';
import type { MachineDestinationPlacementFacts } from '@/components/sessions/new/components/machineSelection/buildMachineDestinationModel';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveManagedMachineWakeStateV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { subscribeMachineRequestReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { useProjectWorkerCopyStatusRevisions } from '@/sync/domains/workspaces/projectAccountRows';

export type MachineDestinationWorkerPlacement = Readonly<Pick<ProjectWorkerStatusInputV1, 'workspace' | 'memoryDemand'>>;
type WorkerStatusMachine = MachineDisplayRenderable & Partial<Pick<Machine, 'daemonStateVersion' | 'operationProtocolCapabilitiesRevision'>>;
type WorkerStatusProjection = Readonly<{
    demandKey: string;
    worker?: ProjectWorkerStatusResultV1;
    failed?: boolean;
}>;

/** List and dropdown share demand-local status, not a global load cache or an eligibility fallback. */
export function useMachineDestinationWorkerStatus(params: Readonly<{
    purpose: MachineDestinationPurposeV1;
    workerPlacement?: MachineDestinationWorkerPlacement;
    /** Only the current, successfully read Home inventory may authorize a wake offer. */
    managedMachines?: readonly ManagedMachineV1[];
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
    const controllers = useMachineListForServer(request?.workspace.serverId ?? '');
    const scope = binding?.isCurrent() ? binding.scope : null;
    const machines = params.groups.flatMap(group => request && group.serverId === request.workspace.serverId
        && !group.loading && !group.signedOut && !group.error ? group.machines : []);
    const machineIds = new Set(machines.map(machine => machine.id));
    const controllerIds = new Set(purpose === 'finite'
        ? params.managedMachines?.filter(managed => managed.enrolledMachineId
            && machineIds.has(managed.enrolledMachineId) && managed.wakeOnAcceptedMessage)
            .flatMap(managed => managed.controller ? [managed.controller.machineId] : []) : []);
    const presenceMachines = new Map<string, MachineDisplayRenderable>([
        ...machines.map(machine => [machine.id, machine] as const),
        ...(controllers ?? []).filter(machine => controllerIds.has(machine.id)).map(machine => [machine.id, machine] as const),
    ]);
    const presenceIdsKey = JSON.stringify([...presenceMachines.keys()].sort());
    const subscribePresence = React.useCallback((listener: () => void) => {
        if (!scope || presenceIdsKey === '[]') return () => {};
        const ids = new Set(JSON.parse(presenceIdsKey) as string[]);
        return subscribeMachineRequestReachability(change => {
            if (change && (change.scope.serverId !== scope.serverId || change.scope.accountId !== scope.accountId
                || change.machineIds && !change.machineIds.some(id => ids.has(id)))) return;
            listener();
        });
    }, [scope, presenceIdsKey]);
    const readPresence = () => JSON.stringify([...presenceMachines].map(([id, machine]) => [id,
        resolveMachinePickerPresence(machine, undefined, scope).selectable]));
    // Request observations are qualified by this demand. A global revision is
    // not a change to any candidate's admission facts.
    React.useSyncExternalStore(subscribePresence, readPresence, readPresence);
    const wakes = new Map<string, 'asleep' | 'starting'>();
    if (purpose === 'finite' && binding?.isCurrent()) {
        for (const managed of params.managedMachines ?? []) {
            const controllerPair = managed.controller;
            if (!controllerPair || !managed.enrolledMachineId || !managed.wakeOnAcceptedMessage) continue;
            const guest = machines.find(machine => machine.id === managed.enrolledMachineId);
            if (!guest || resolveMachinePickerPresence(guest, undefined, scope).selectable) continue;
            const controller = controllers?.find(machine => machine.id === controllerPair.machineId
                && machine.installationId === controllerPair.installationId && !machine.revokedAt && !machine.replacedByMachineId
                && resolveMachinePickerPresence(machine, undefined, scope).selectable
                && (machine.isShared !== true || machine.access?.role === 'manage' && machine.access.accessState === 'ready'));
            const state = controller && resolveManagedMachineWakeStateV1(managed, managed.enrolledMachineId);
            if (state) wakes.set(managed.enrolledMachineId, state);
        }
    }
    const candidates = new Map(machines.filter(machine => resolveMachinePickerPresence(machine, undefined, scope).selectable)
        .map(machine => [machine.id, machine] as const));
    const candidateIds = [...candidates.keys()].sort();
    const candidateHints = new Map(candidateIds.map(id => {
        const machine = candidates.get(id)!;
        // These are admitted producer revisions/access hints, not load or
        // eligibility. Heartbeat activeAt never causes another status demand.
        return [id, [machine.metadataVersion, machine.daemonStateVersion ?? null,
            machine.operationProtocolCapabilitiesRevision ?? null, machine.isShared ?? false,
            machine.access ?? null, machine.availability ?? null]] as const;
    }));
    const candidateIdsKey = JSON.stringify(candidateIds);
    const hasRequest = Boolean(request);
    const subscribeOperations = React.useCallback((listener: () => void) => scope && hasRequest
        ? actionOperationStore.subscribeWorkerStatus(scope, JSON.parse(candidateIdsKey) as string[], listener) : () => {},
    [scope, hasRequest, candidateIdsKey]);
    const readOperationRevision = () => scope
        ? candidateIds.reduce((sum, id) => sum + actionOperationStore.readWorkerStatusRevision(scope, id), 0) : 0;
    React.useSyncExternalStore(subscribeOperations, readOperationRevision, readOperationRevision);
    const copyRevisions = useProjectWorkerCopyStatusRevisions(scope, request?.workspace.refId ?? null, candidateIdsKey);
    const demandKeys = new Map(candidateIds.map(id => [id, JSON.stringify([purpose, request ?? null,
        binding ? [binding.serverId, binding.accountId, binding.revision] : null,
        candidateHints.get(id), scope ? actionOperationStore.readWorkerStatusRevision(scope, id) : 0, copyRevisions.get(id) ?? 0])]));
    const demandKey = JSON.stringify([...demandKeys]);
    const [projection, setProjection] = React.useState<ReadonlyMap<string, WorkerStatusProjection>>(() => new Map());
    const requests = React.useRef(new Map<string, { demandKey: string; cancel: () => void }>());

    React.useEffect(() => {
        const cancel = () => {
            for (const request of requests.current.values()) request.cancel();
            requests.current.clear();
        };
        const retirement = binding?.onRetire(() => { cancel(); setProjection(new Map()); });
        return () => { cancel(); retirement?.dispose(); };
    }, [binding]);

    React.useEffect(() => {
        for (const [machineId, request] of requests.current) {
            if (request.demandKey === demandKeys.get(machineId)) continue;
            request.cancel();
            requests.current.delete(machineId);
        }
        setProjection(previous => {
            const retained = new Map([...previous].filter(([id, status]) => status.demandKey === demandKeys.get(id)));
            return retained.size === previous.size ? previous : retained;
        });
        if (!purpose || !request || !binding || !binding.isCurrent()) return;
        for (const [machineId, machineDemandKey] of demandKeys) {
            if (requests.current.get(machineId)?.demandKey === machineDemandKey) continue;
            let current = true;
            requests.current.set(machineId, { demandKey: machineDemandKey, cancel: () => { current = false; } });
            void executeProjectWorkerActionV1('projects.worker.status', {
                ...request, destination: { kind: 'machine', machineId }, purpose,
            }, { expectedAccountId: binding.accountId }).then(worker => {
                if (!current || !binding.isCurrent()) return;
                setProjection(previous => {
                    const statuses = new Map(previous);
                    statuses.set(machineId, { demandKey: machineDemandKey, worker });
                    return statuses;
                });
            }).catch(() => {
                // Failed reads establish neither eligibility nor zero load. The
                // canonical model retains its status-unavailable refusal and
                // stops saying it is still checking.
                if (!current || !binding.isCurrent()) return;
                setProjection(previous => {
                    const statuses = new Map(previous);
                    statuses.set(machineId, { demandKey: machineDemandKey, failed: true });
                    return statuses;
                });
            });
        }
        // Domain values and the exact credential revision, not wrapper identities, own a demand.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [demandKey, binding]);

    const wakeKey = JSON.stringify([...wakes]);
    return React.useCallback((machine: MachineDisplayRenderable, serverId: string): MachineDestinationPlacementFacts => {
        const status = projection.get(machine.id);
        const current = binding?.isCurrent() && request?.workspace.serverId === serverId
            && status?.demandKey === demandKeys.get(machine.id) ? status : null;
        const managedWake = binding?.isCurrent() && request?.workspace.serverId === serverId && !resolveMachinePickerPresence(machine, undefined, scope).selectable
            ? wakes.get(machine.id) : undefined;
        const worker = current?.worker;
        const failed = current?.failed === true;
        return { ownership: machine.isShared === true ? 'shared' : 'owned', ...(managedWake ? { managedWake } : {}),
            ...(worker ? { worker } : failed ? { workerStatusFailed: true } : {}) };
        // Exact semantic power/controller changes, not inventory array identities, refresh the callback.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [binding, demandKey, projection, request?.workspace.serverId, scope, wakeKey]);
}
