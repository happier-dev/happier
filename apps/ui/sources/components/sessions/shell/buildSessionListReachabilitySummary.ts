import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { formatPathRelativeToHome } from '@/utils/sessions/sessionUtils';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';

type ReachableSessionDisplay = Readonly<{
    machineId: string | null;
    machineLabel: string;
    pathSubtitle: string;
}>;

export type SessionListReachabilitySummary = Readonly<{
    displayById: Map<string, ReachableSessionDisplay>;
    hasMultipleMachines: boolean;
}>;

export function buildSessionListReachabilitySummary(input: Readonly<{
    listItems: ReadonlyArray<SessionListViewItem>;
    machinesById: ReadonlyMap<string, unknown>;
}>): SessionListReachabilitySummary {
    const displayById = new Map<string, ReachableSessionDisplay>();
    const machineKeys = new Set<string>();

    for (const item of input.listItems) {
        if (!item || item.type !== 'session') {
            continue;
        }

        const target = readMachineTargetForSession(item.session.id);
        const machineId = target?.machineId ?? (String(item.session?.metadata?.machineId ?? '').trim() || null);
        const machineLabel = machineId
            ? getMachineDisplayName(input.machinesById.get(machineId) as Parameters<typeof getMachineDisplayName>[0])
                ?? String(item.session?.metadata?.host ?? '').trim()
            : String(item.session?.metadata?.host ?? '').trim();
        const basePath = target?.basePath ?? item.session?.metadata?.path ?? null;
        const pathSubtitle = basePath
            ? formatPathRelativeToHome(basePath, item.session?.metadata?.homeDir ?? undefined)
            : '';

        displayById.set(item.session.id, {
            machineId,
            machineLabel,
            pathSubtitle,
        });

        const machineKey = machineId ?? machineLabel ?? '';
        if (machineKey) {
            machineKeys.add(machineKey);
        }
    }

    return {
        displayById,
        hasMultipleMachines: machineKeys.size > 1,
    };
}
