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

const EMPTY_SESSION_LIST_REACHABILITY_SUMMARY: SessionListReachabilitySummary = {
    displayById: new Map<string, ReachableSessionDisplay>(),
    hasMultipleMachines: false,
};
const SESSION_LIST_REACHABILITY_SUMMARY_CACHE = new Map<string, SessionListReachabilitySummary>();

export function buildSessionListReachabilitySummary(input: Readonly<{
    listItems: ReadonlyArray<SessionListViewItem>;
    machinesById: ReadonlyMap<string, unknown>;
}>): SessionListReachabilitySummary {
    const sessionDisplayRows: Array<Readonly<{
        sessionId: string;
        machineId: string | null;
        machineLabel: string;
        pathSubtitle: string;
    }>> = [];

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

        sessionDisplayRows.push({
            sessionId: item.session.id,
            machineId,
            machineLabel,
            pathSubtitle,
        });
    }

    if (sessionDisplayRows.length === 0) {
        SESSION_LIST_REACHABILITY_SUMMARY_CACHE.set(JSON.stringify(['__empty__']), EMPTY_SESSION_LIST_REACHABILITY_SUMMARY);
        return EMPTY_SESSION_LIST_REACHABILITY_SUMMARY;
    }

    const cacheKey = JSON.stringify([
        sessionDisplayRows,
        Array.from(input.machinesById.entries()).map(([machineId, machine]) => [
            machineId,
            machine && typeof machine === 'object'
                ? {
                    id: (machine as { id?: unknown }).id ?? null,
                    host: (machine as { metadata?: { host?: unknown } | null }).metadata?.host ?? null,
                }
                : machine,
        ]),
    ]);
    const cached = SESSION_LIST_REACHABILITY_SUMMARY_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const displayById = new Map<string, ReachableSessionDisplay>();
    const machineKeys = new Set<string>();
    for (const row of sessionDisplayRows) {
        displayById.set(row.sessionId, {
            machineId: row.machineId,
            machineLabel: row.machineLabel,
            pathSubtitle: row.pathSubtitle,
        });

        const machineKey = row.machineId ?? row.machineLabel ?? '';
        if (machineKey) {
            machineKeys.add(machineKey);
        }
    }

    const next = {
        displayById,
        hasMultipleMachines: machineKeys.size > 1,
    };

    SESSION_LIST_REACHABILITY_SUMMARY_CACHE.set(cacheKey, next);
    return next;
}
