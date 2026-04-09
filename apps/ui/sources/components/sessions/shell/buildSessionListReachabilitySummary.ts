import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { formatPathRelativeToHome } from '@/utils/sessions/sessionUtils';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { LruMap } from '@/utils/cache/lruMap';

import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';

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
const SESSION_LIST_REACHABILITY_SUMMARY_CACHE = new LruMap<string, SessionListReachabilitySummary>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

export function buildSessionListReachabilitySummary(input: Readonly<{
    listItems: ReadonlyArray<SessionListIndexItem>;
    machinesById: ReadonlyMap<string, unknown>;
    resolveSessionRenderable: (item: Extract<SessionListIndexItem, { type: 'session' }>) => SessionListRenderableSession | null;
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

        const sessionId = String(item.sessionId ?? '').trim();
        if (!sessionId) continue;

        const renderable = input.resolveSessionRenderable(item);
        const metadata = renderable?.metadata ?? null;

        const target = readMachineTargetForSession(sessionId);
        const machineId = target?.machineId ?? (String(metadata?.machineId ?? '').trim() || null);
        const machineLabel = machineId
            ? getMachineDisplayName(input.machinesById.get(machineId) as Parameters<typeof getMachineDisplayName>[0])
                ?? String(metadata?.host ?? '').trim()
            : String(metadata?.host ?? '').trim();
        const basePath = target?.basePath ?? metadata?.path ?? null;
        const pathSubtitle = basePath
            ? formatPathRelativeToHome(basePath, metadata?.homeDir ?? undefined)
            : '';

        sessionDisplayRows.push({
            sessionId,
            machineId,
            machineLabel,
            pathSubtitle,
        });
    }

    if (sessionDisplayRows.length === 0) {
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
