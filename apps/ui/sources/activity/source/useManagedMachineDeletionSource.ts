import * as React from 'react';
import type { resolveProviderDeletionReminderV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';

import { readManagedMachineDeletionAttention } from '@/activity/attention/managedMachineDeletionAttention';
import { useManagedMachineInventory } from '@/components/settings/machines/managed/useManagedMachineInventory';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import { resolveInboxItemPageRoute } from '@/components/inbox/inboxItemFocus';
import { useExactHomeAccountSettings } from '@/activity/delivery/useExactHomeAccountSettings';

const DELETION_SETTING_KEYS = ['managedMachineDeletionReminderLeadTimeMs'] as const;

type DeletionFacts = Pick<Parameters<typeof resolveProviderDeletionReminderV1>[0], 'observation' | 'retentionCapabilities'>;
export type ManagedMachineDeletionEntry = DeletionFacts & Readonly<{
    key: string; serverId: string; accountId: string; managedId: string; name: string; href: string;
}>;

/** Both reminders read the pushed inventory; neither starts a clock or a second resource store. */
export function useManagedMachineDeletionSource(serverIds: readonly string[]): readonly ManagedMachineDeletionEntry[] {
    // Archived rows carry explicit withdrawal to the OS schedule instead of leaving a stale alert.
    const inventory = useManagedMachineInventory(serverIds, undefined, undefined, true);
    const previous = React.useRef<readonly ManagedMachineDeletionEntry[]>([]);
    return React.useMemo(() => {
        const rows = Object.entries(inventory.entries).flatMap(([serverId, entry]) => entry.machines.flatMap(machine => {
            const observation = machine.observation?.deletionNotices;
            const retentionCapabilities = machine.reviewedFacts?.retentionCapabilities?.deletionNotices;
            if (!observation && !retentionCapabilities) return [];
            return [{ key: JSON.stringify([serverId, entry.accountId, machine.id]), serverId, accountId: entry.accountId,
                managedId: machine.id, name: machine.launch.name,
                href: resolveInboxItemPageRoute({ kind: 'managed_machine', serverId, id: machine.id }),
                observation: { deletionNotices: machine.archivedAt === undefined ? observation : [] },
                retentionCapabilities: { deletionNotices: retentionCapabilities } }];
        }));
        previous.current = retainKeyedRows(previous.current, rows, row => row.key);
        return previous.current;
    }, [inventory.entries]);
}

/** Inventory already names each Home's Account; consume only its synchronized preference. */
export function useManagedMachineDeletionLeadTime(
    entries: readonly ManagedMachineDeletionEntry[],
): (entry: ManagedMachineDeletionEntry) => number | null {
    const scopes = React.useMemo(() => new Map(entries.map(entry => [entry.serverId, {
        serverId: entry.serverId, accountId: entry.accountId,
    }])), [entries]);
    const resolveSettings = useExactHomeAccountSettings(scopes, DELETION_SETTING_KEYS);
    return React.useCallback((entry: ManagedMachineDeletionEntry) => (
        resolveSettings(entry.serverId)?.managedMachineDeletionReminderLeadTimeMs ?? null
    ), [resolveSettings]);
}

/** Evaluate on app/Inbox open and pushed changes, with the existing typed deadline owner. */
export function useManagedMachineDeletionAttention(serverId: string | null) {
    const serverIds = React.useMemo(() => serverId ? [serverId] : [], [serverId]);
    const entries = useManagedMachineDeletionSource(serverIds);
    const resolveLeadTime = useManagedMachineDeletionLeadTime(entries);
    return React.useMemo(() => entries.flatMap(entry => {
        const leadTimeMs = resolveLeadTime(entry);
        if (leadTimeMs === null) return [];
        const reminder = readManagedMachineDeletionAttention({ ...entry,
            leadTimeMs, nowMs: Date.now() });
        return reminder ? [{ ...entry, reminder }] : [];
    }), [entries, resolveLeadTime]);
}
