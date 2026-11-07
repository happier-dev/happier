import * as React from 'react';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionListIndexNodeId } from '@/sync/domains/sessionList/sessionListIndexIdentity';
import { useMachineDisplayById, useSessionDisplayNameProjections, type SessionDisplayNameSource } from '@/sync/domains/state/storage';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { isMachineDisplayHydrating, resolveMachineDisplayNameParts } from '@/utils/sessions/machineDisplayNames';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { t } from '@/text';
import { readSessionListProjectHeaderMachineId, type SessionListProjectHeaderViewModelState } from './sessionListProjectHeaderViewModels';

type SessionItem = Extract<SessionListIndexItem, { type: 'session' }>;
function projectSessionMachineId(source: SessionDisplayNameSource | null): string | null {
    return source ? resolveSessionMachineId(source.metadata) : null;
}

/** Offline uses pre-collapse membership; name collisions use visible Project header labels. */
export function useSessionListGroupMachineFacts(input: Readonly<{
    listItems: readonly SessionListIndexItem[];
    membershipItems: readonly SessionListIndexItem[];
    headerState: SessionListProjectHeaderViewModelState;
    machinesById?: Readonly<Record<string, MachineDisplayRenderable>>;
    active?: boolean;
}>): SessionListProjectHeaderViewModelState {
    const sessionItems = React.useMemo(() => {
        if (input.active === false) return [];
        const itemsByNodeId = new Map<string, SessionItem>();
        let projectGroup = false;
        for (const item of input.membershipItems) {
            if (item.type === 'header' && item.headerKind !== 'folder') projectGroup = item.headerKind === 'project';
            if (item.type === 'session' && projectGroup) itemsByNodeId.set(buildSessionListIndexNodeId(item), item);
        }
        return [...itemsByNodeId.values()];
    }, [input.active, input.membershipItems]);
    const facts = useSessionDisplayNameProjections(sessionItems, projectSessionMachineId);
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
    const machineIds = React.useMemo(() => new Set([...facts, ...headerMachineByGroup.values()]
        .filter((id): id is string => id !== null)), [facts, headerMachineByGroup]);
    const selectMachines = React.useMemo(() => {
        let previous: readonly MachineDisplayRenderable[] = [];
        let previousKey = '';
        return (inventory: Record<string, MachineDisplayRenderable>) => {
            const next = Object.values(input.machinesById ?? inventory).filter(machine => machineIds.has(machine.id));
            const key = machineFactsKeyFor(next);
            if (key !== previousKey) { previous = next; previousKey = key; }
            return previous;
        };
    }, [input.machinesById, machineIds]);
    const machines = useMachineDisplayById(selectMachines);
    // Presence has its own pushed channel; timestamps never enter the projection's memo key.
    useMachinePresenceNowMs(machines);
    const machineFactsKey = machineFactsKeyFor(machines);
    return React.useMemo(() => syncPerformanceTelemetry.measure('ui.sessionsList.render.groupMachineFacts', {
        items: input.listItems.length,
    }, () => {
        const factByNodeId = new Map(sessionItems.map((item, index) => [buildSessionListIndexNodeId(item), facts[index] ?? null]));
        const names = resolveMachineDisplayNameParts(machines);
        const machineById = new Map(machines.map(machine => [machine.id, machine]));
        const offline = new Set(machines.filter(machine => machine.presence !== null && !isMachineOnline(machine)).map(machine => machine.id));
        const projectMachines = new Map<string, Set<string | null>>();
        let projectGroup: string | undefined;
        for (const item of input.membershipItems) {
            if (item.type === 'header') {
                if (item.headerKind !== 'folder') projectGroup = item.headerKind === 'project' ? item.groupKey : undefined;
                continue;
            }
            if (item.type !== 'session' || !projectGroup) continue;
            const ids = projectMachines.get(projectGroup) ?? new Set<string | null>();
            ids.add(factByNodeId.get(buildSessionListIndexNodeId(item)) ?? null);
            projectMachines.set(projectGroup, ids);
        }
        const headerLabelCounts = new Map<string, number>();
        for (const groupKey of headerMachineByGroup.keys()) {
            const header = input.headerState.projectHeaderViewModelByGroupKey.get(groupKey);
            if (header) headerLabelCounts.set(header.displayTitle, (headerLabelCounts.get(header.displayTitle) ?? 0) + 1);
        }
        let projectHeaderViewModelByGroupKey = input.headerState.projectHeaderViewModelByGroupKey;
        for (const [groupKey, header] of input.headerState.projectHeaderViewModelByGroupKey) {
            const ids = projectMachines.get(groupKey);
            const groupMachineId = ids?.size === 1 ? ids.values().next().value : null;
            const isOffline = Boolean(groupMachineId && offline.has(groupMachineId));
            const headerMachineId = headerMachineByGroup.get(groupKey);
            const machine = headerMachineId ? machineById.get(headerMachineId) : undefined;
            // A decrypting name is never rendered as a Machine named "Loading…".
            const parts = (headerLabelCounts.get(header.displayTitle) ?? 0) > 1 && machine && !isMachineDisplayHydrating(machine)
                ? names.get(machine.id) : undefined;
            // The name may shorten in a narrow header; its telling suffix and Offline stay whole.
            const end = [parts?.hint, isOffline ? t('status.offline') : null].filter(Boolean).join(' · ') || null;
            const name = parts?.name ?? null;
            const machineDetail = name || end ? { name, end } : undefined;
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
        return { ...input.headerState, projectHeaderViewModelByGroupKey };
    }), [input.listItems, input.membershipItems, input.headerState, sessionItems, facts, headerMachineByGroup, machineFactsKey]);
}

function machineFactsKeyFor(machines: readonly MachineDisplayRenderable[]): string {
    return JSON.stringify(machines.map(machine => [machine.id, isMachineOnline(machine), machine.presence === null,
        machine.metadataVersion, machine.metadata === null, machine.metadata?.displayName, machine.metadata?.host,
        machine.availability?.kind]));
}
