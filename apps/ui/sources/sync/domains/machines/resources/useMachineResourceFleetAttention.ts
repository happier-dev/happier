import * as React from 'react';
import type { MachineResourceReasonV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { storage } from '@/sync/domains/state/storageStore';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { collectMachineAttention, readMachineAttentionInputs } from '@/components/machines/attention/collectMachineAttention';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { MachineResourceKey } from './machineRpc';

export type MachineResourceFleetAttention = Readonly<{
    accountScope: ServerAccountScope | null;
    needsYou: readonly MachineResourceKey[];
    look: readonly Readonly<{ machineKey: string; reasonKey: string }>[];
    /** Machines whose published managed services are failing, as their rows show them (TH MB-2). */
    failingServices: readonly string[];
    /** Positive sampler evidence: absence from look alone may instead mean offline or unknown. */
    reportingMachineKeys: readonly string[];
    lastAutomaticActionAt: number | null;
    headline: Readonly<{ machineKey: MachineResourceKey; reason: MachineResourceReasonV1 }> | null;
}>;

export function useMachineResourceFleetAttention(): MachineResourceFleetAttention {
    const { serverId } = useActiveServerSnapshot();
    const activeAccountScope = useActiveServerAccountScope();
    const scope = selectActiveServerAccountScopeForServer(activeAccountScope, serverId);
    const readMachines = React.useCallback(() => {
        const state = storage.getState();
        return resolveServerScopedMachines({ serverId, activeServerId: serverId, activeMachines: Object.values(state.machines),
            machineListByServerId: state.machineListByServerId, machineListStatusByServerId: state.machineListStatusByServerId }) ?? [];
    }, [serverId]);
    const readSnapshot = React.useCallback((nowMs: number) => {
        const machines = [...readMachines()].sort((left, right) => left.id.localeCompare(right.id));
        const attention = collectMachineAttention([{ serverId, accountScope: scope, serverName: '', status: 'idle', machines }], nowMs, 'facts');
        const needsYou: MachineResourceKey[] = [];
        const look: { machineKey: string; reasonKey: string }[] = [];
        const failingServices: string[] = [];
        let lastAutomaticActionAt: number | null = null;
        let headline: MachineResourceFleetAttention['headline'] = null;
        for (const entry of attention.entries) {
            const machineKey = { serverId: entry.serverId, machineId: entry.machineId };
            if (entry.attention.level === 'needs_you') needsYou.push(machineKey);
            if ((entry.failingServices ?? 0) > 0) failingServices.push(entry.key);
            for (const reason of entry.attention.reasons) {
                if (reason.level === 'look') look.push({ machineKey: entry.key, reasonKey: reason.key });
                if (!headline || (headline.reason.level === 'look' && reason.level === 'needs_you')) headline = { machineKey, reason };
            }
            if (entry.lastAutomaticAction) lastAutomaticActionAt = Math.max(lastAutomaticActionAt ?? 0, entry.lastAutomaticAction.at);
        }
        return { accountScope: scope, needsYou, look, failingServices, reportingMachineKeys: attention.reportingMachineKeys, lastAutomaticActionAt, headline };
    }, [readMachines, serverId, scope]);
    const readDemandedInputs = React.useCallback((nowMs: number) => readMachineAttentionInputs([{
        serverId, accountScope: scope, serverName: '', status: 'idle',
        machines: [...readMachines()].sort((left, right) => left.id.localeCompare(right.id)),
    }], nowMs, false), [readMachines, scope, serverId]);
    // Share presence's source-cached snapshot and expiry subscription. React's
    // consistency reads must not sample a new wall time before that source wakes.
    const targets = React.useMemo(() => [{ serverId }], [serverId]);
    return useMachinePresenceSnapshot(readMachines, readSnapshot, targets, undefined, readDemandedInputs);
}
