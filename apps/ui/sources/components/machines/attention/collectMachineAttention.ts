import type { MachineResourceAutomaticActionV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';

import { readMachinePublishedResources, type MachineAttentionSubject } from '@/components/machines/summary/machineResourceSentences';
import type { ActiveSelectionMachineGroup } from '@/components/settings/machines/hooks/useActiveSelectionMachineGroups';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import type { Machine } from '@/sync/domains/state/storageTypes';

/** One machine of the open surface with what it publishes: its attention and the guard's last act. */
export type MachineAttentionFact = Readonly<{
    key: string;
    serverId: string;
    machineId: string;
    online: boolean;
    lastAutomaticAction: MachineResourceAutomaticActionV1 | null;
    attention: MachineAttentionSubject['attention'];
}>;
export type MachineAttentionEntry = MachineAttentionFact & MachineAttentionSubject;

type MachineAttentionCollection<T> = Readonly<{
    entries: readonly T[];
    reportingCount: number;
    onlineCount: number;
    reportingMachineKeys: readonly string[];
}>;

function canPublishAttention(machine: Machine): boolean {
    return isMachineVisibleForLaunchSelection(machine) && machine.availability?.kind !== 'locked'
        && (!machine.access || machine.access.accessState === 'ready');
}

function inputObject(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

/** Select admitted resource facts, not unrelated Machine content or heartbeat timestamps. */
export function readMachineAttentionInputs(groups: readonly ActiveSelectionMachineGroup[], nowMs: number, named = true): readonly unknown[] {
    const inputs: unknown[] = [];
    for (const group of groups) {
        inputs.push(group.serverId, group.accountScope?.serverId, group.accountScope?.accountId);
        for (const machine of group.machines) {
            inputs.push(machine.id);
            if (named) inputs.push(machine.metadata === null, machine.availability?.kind,
                machine.metadata?.displayName, machine.metadata?.host);
            const eligible = canPublishAttention(machine);
            const online = eligible && isMachineReachable(group.accountScope, machine, nowMs);
            inputs.push(eligible, online);
            if (!online) continue;
            // Machine content admission owns the published schema. This selects
            // its known fields; it does not re-validate or walk the whole blob.
            const daemon = inputObject(machine.daemonState);
            const resources = inputObject(daemon?.resources);
            const vitals = inputObject(resources?.vitals);
            const attention = inputObject(resources?.attention);
            inputs.push(resources !== null, resources?.v, vitals?.state, attention?.level);
            const reasons = Array.isArray(attention?.reasons) ? attention.reasons : [];
            inputs.push(reasons.length);
            for (const value of reasons) {
                const reason = inputObject(value);
                inputs.push(reason?.key, reason?.level, reason?.since, reason?.metric, reason?.nextStep, reason?.kind,
                    reason?.pressure, reason?.swapping, reason?.volumeId, reason?.volumeLabel,
                    reason?.limit, reason?.used, reason?.max);
            }
            const action = inputObject(resources?.lastAutomaticAction);
            const facts = inputObject(action?.facts);
            inputs.push(action !== null, action?.at, action?.kind, action?.entryId, action?.undoable,
                facts?.rule, facts?.freedBytes, facts?.inTrashBytes, facts?.count);
        }
    }
    return inputs;
}

/**
 * The open surface's machines with their published attention (plan 20's `daemonState.resources`, read
 * through its schema): every online machine that reports, named as the lists name it. `reportingCount`
 * is how many publish anything at all — zero keeps every sentence away.
 */
export function collectMachineAttention(groups: readonly ActiveSelectionMachineGroup[], nowMs: number, presentation: 'facts'): MachineAttentionCollection<MachineAttentionFact>;
export function collectMachineAttention(groups: readonly ActiveSelectionMachineGroup[], nowMs?: number): MachineAttentionCollection<MachineAttentionEntry>;
export function collectMachineAttention(groups: readonly ActiveSelectionMachineGroup[], nowMs: number = Date.now(), presentation?: 'facts'): MachineAttentionCollection<MachineAttentionFact> {
    const entries: MachineAttentionFact[] = [];
    const reportingMachineKeys: string[] = [];
    let onlineCount = 0;
    for (const group of groups) {
        const names = presentation === 'facts' ? null : resolveMachineDisplayNames(group.machines);
        for (const machine of group.machines) {
            if (!canPublishAttention(machine)) continue;
            const online = isMachineReachable(group.accountScope, machine, nowMs);
            if (online) onlineCount += 1;
            const published = online ? readMachinePublishedResources(machine.daemonState) : null;
            if (!published) continue;
            if (published.vitals.state === 'reporting') reportingMachineKeys.push(JSON.stringify([group.serverId, machine.id]));
            entries.push({
                key: JSON.stringify([group.serverId, machine.id]),
                serverId: group.serverId,
                machineId: machine.id,
                ...(names ? { name: names.get(machine.id) ?? machine.id } : {}),
                online,
                attention: published.attention,
                lastAutomaticAction: published.lastAutomaticAction ?? null,
            });
        }
    }
    return { entries, reportingCount: entries.length, onlineCount, reportingMachineKeys };
}
