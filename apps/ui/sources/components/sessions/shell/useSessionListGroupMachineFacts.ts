import * as React from 'react';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { useMachineDisplayById } from '@/sync/domains/state/storage';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { isMachineDisplayHydrating, resolveMachineDisplayNameParts } from '@/utils/sessions/machineDisplayNames';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { readSessionListProjectHeaderMachineId, type SessionListProjectHeaderViewModelState } from './sessionListProjectHeaderViewModels';

/**
 * Names a Project header's Machine only when visible Project labels collide. A Project carries no
 * availability: whether a Machine is reachable is said on its Sessions and Machine surfaces (D3).
 */
export function useSessionListGroupMachineFacts(input: Readonly<{
    listItems: readonly SessionListIndexItem[];
    headerState: SessionListProjectHeaderViewModelState;
    machinesById?: Readonly<Record<string, MachineDisplayRenderable>>;
    active?: boolean;
}>): SessionListProjectHeaderViewModelState {
    const headerMachineByGroup = React.useMemo(() => {
        const ids = new Map<string, string | null>();
        if (input.active === false) return ids;
        for (const item of input.listItems) {
            if (item.type === 'header' && item.headerKind === 'project' && item.groupKey) {
                ids.set(item.groupKey, readSessionListProjectHeaderMachineId(item, [], input.headerState.projectDisplayByKey));
            }
        }
        return ids;
    }, [input.active, input.listItems, input.headerState.projectDisplayByKey]);
    const machineIds = React.useMemo(() => new Set([...headerMachineByGroup.values()]
        .filter((id): id is string => id !== null)), [headerMachineByGroup]);
    const selectMachines = React.useMemo(() => {
        let previous: readonly MachineDisplayRenderable[] = [];
        let previousKey = '';
        return (inventory: Record<string, MachineDisplayRenderable>) => {
            const next = Object.values(input.machinesById ?? inventory).filter(machine => machineIds.has(machine.id));
            const key = machineNameKeyFor(next);
            if (key !== previousKey) { previous = next; previousKey = key; }
            return previous;
        };
    }, [input.machinesById, machineIds]);
    const machines = useMachineDisplayById(selectMachines);
    const machineNameKey = machineNameKeyFor(machines);
    // The last published facts. A list update that leaves every header's name unchanged republishes
    // nothing, so the rows and headers reading these facts do not redraw for another Session's change.
    const publishedRef = React.useRef<SessionListProjectHeaderViewModelState | null>(null);
    const published = React.useMemo(() => syncPerformanceTelemetry.measure('ui.sessionsList.render.groupMachineFacts', {
        items: input.listItems.length,
    }, () => {
        const names = resolveMachineDisplayNameParts(machines);
        const machineById = new Map(machines.map(machine => [machine.id, machine]));
        const headerLabelCounts = new Map<string, number>();
        for (const groupKey of headerMachineByGroup.keys()) {
            const header = input.headerState.projectHeaderViewModelByGroupKey.get(groupKey);
            if (header) headerLabelCounts.set(header.displayTitle, (headerLabelCounts.get(header.displayTitle) ?? 0) + 1);
        }
        let projectHeaderViewModelByGroupKey = input.headerState.projectHeaderViewModelByGroupKey;
        for (const [groupKey, header] of input.headerState.projectHeaderViewModelByGroupKey) {
            const headerMachineId = headerMachineByGroup.get(groupKey);
            const machine = headerMachineId ? machineById.get(headerMachineId) : undefined;
            // A decrypting name is never rendered as a Machine named "Loading…".
            const parts = (headerLabelCounts.get(header.displayTitle) ?? 0) > 1 && machine && !isMachineDisplayHydrating(machine)
                ? names.get(machine.id) : undefined;
            // The name may shorten in a narrow header; its telling suffix stays whole.
            const machineDetail = parts?.name || parts?.hint ? { name: parts.name ?? null, end: parts.hint ?? null } : undefined;
            if (machineDetail?.name !== header.machineDetail?.name || machineDetail?.end !== header.machineDetail?.end) {
                if (projectHeaderViewModelByGroupKey === input.headerState.projectHeaderViewModelByGroupKey) {
                    projectHeaderViewModelByGroupKey = new Map(projectHeaderViewModelByGroupKey);
                }
                projectHeaderViewModelByGroupKey.set(groupKey, { ...header, machineDetail });
            }
        }
        if (projectHeaderViewModelByGroupKey === input.headerState.projectHeaderViewModelByGroupKey) {
            return input.headerState;
        }
        const previous = publishedRef.current;
        if (previous && isSameNamedHeaderState(previous, input.headerState, projectHeaderViewModelByGroupKey)) return previous;
        return { ...input.headerState, projectHeaderViewModelByGroupKey };
    }), [input.listItems, input.headerState, headerMachineByGroup, machineNameKey]);
    publishedRef.current = published;
    return published;
}

/** Whether `previous` already publishes these headers: the same base facts, and each header field-equal. */
function isSameNamedHeaderState(
    previous: SessionListProjectHeaderViewModelState,
    base: SessionListProjectHeaderViewModelState,
    nextHeaders: SessionListProjectHeaderViewModelState['projectHeaderViewModelByGroupKey'],
): boolean {
    if (previous.scopeHintByLegacyWorkspaceKey !== base.scopeHintByLegacyWorkspaceKey
        || previous.projectDisplayByKey !== base.projectDisplayByKey
        || previous.groupProjectByGroupKey !== base.groupProjectByGroupKey
        || previous.projectHeaderViewModelByGroupKey.size !== nextHeaders.size) return false;
    for (const [groupKey, header] of nextHeaders) {
        const prior = previous.projectHeaderViewModelByGroupKey.get(groupKey);
        if (prior === header) continue;
        if (!prior || Object.keys(prior).length !== Object.keys(header).length) return false;
        for (const [field, value] of Object.entries(header) as Array<[keyof typeof header, unknown]>) {
            if (field === 'machineDetail') {
                if (prior.machineDetail?.name !== header.machineDetail?.name || prior.machineDetail?.end !== header.machineDetail?.end) return false;
            } else if (prior[field] !== value) return false;
        }
    }
    return true;
}

/** The Machine facts a header name reads; presence and receipts never enter it. */
function machineNameKeyFor(machines: readonly MachineDisplayRenderable[]): string {
    return JSON.stringify(machines.map(machine => [machine.id, machine.metadataVersion, machine.metadata === null,
        machine.metadata?.displayName, machine.metadata?.host, machine.availability?.kind]));
}
