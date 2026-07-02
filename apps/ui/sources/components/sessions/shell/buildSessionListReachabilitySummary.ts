import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListReachabilityRenderable } from '@/sync/domains/state/storage';
import { resolveSessionWorkspaceDisplayPresentation } from '@/sync/domains/session/listing/sessionWorkspaceDisplayPresentation';
import type { WorkspaceDisplayEllipsizeMode } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import type { WorkspacePathDisplayModeV1 } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { readDisplayMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { LruMap } from '@/utils/cache/lruMap';

import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';

type ReachableSessionDisplay = Readonly<{
    machineId: string | null;
    machineLabel: string;
    workspaceSubtitle: string;
    workspaceSubtitleEllipsizeMode: WorkspaceDisplayEllipsizeMode;
}>;

export type SessionListReachabilitySummary = Readonly<{
    displayById: Map<string, ReachableSessionDisplay>;
    displayByKey: Map<string, ReachableSessionDisplay>;
    hasMultipleMachines: boolean;
}>;

const EMPTY_SESSION_LIST_REACHABILITY_SUMMARY: SessionListReachabilitySummary = {
    displayById: new Map<string, ReachableSessionDisplay>(),
    displayByKey: new Map<string, ReachableSessionDisplay>(),
    hasMultipleMachines: false,
};
const SESSION_LIST_REACHABILITY_SUMMARY_CACHE = new LruMap<string, SessionListReachabilitySummary>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

export function buildSessionListReachabilitySummary(input: Readonly<{
    listItems: ReadonlyArray<SessionListIndexItem>;
    machinesById: ReadonlyMap<string, unknown>;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    resolveSessionRenderable: (item: Extract<SessionListIndexItem, { type: 'session' }>) => SessionListReachabilityRenderable | null;
}>): SessionListReachabilitySummary {
    const sessionDisplayRows: Array<Readonly<{
        sessionId: string;
        sessionKey: string | null;
        machineId: string | null;
        machineLabel: string;
        workspaceSubtitle: string;
        workspaceSubtitleEllipsizeMode: WorkspaceDisplayEllipsizeMode;
    }>> = [];

    for (const item of input.listItems) {
        if (!item || item.type !== 'session') {
            continue;
        }

        const sessionId = String(item.sessionId ?? '').trim();
        if (!sessionId) continue;

        const renderable = input.resolveSessionRenderable(item);
        const metadata = renderable?.metadata ?? null;

        const machineTarget = readDisplayMachineTargetForSession({
            sessionId,
            metadata,
        });
        const machineId = machineTarget?.machineId ?? (String(metadata?.machineId ?? '').trim() || null);
        const machineLabel = machineId
            ? getMachineDisplayName(input.machinesById.get(machineId) as Parameters<typeof getMachineDisplayName>[0])
                ?? String(metadata?.host ?? '').trim()
            : String(metadata?.host ?? '').trim();
        const workspaceDisplay = resolveSessionWorkspaceDisplayPresentation({
            serverId: item.serverId,
            metadata,
            machineTarget,
            workspaceRefs: input.workspaceRefs,
            workspacePathDisplayModeV1: input.workspacePathDisplayModeV1,
        });

        sessionDisplayRows.push({
            sessionId,
            sessionKey: item.serverId ? `${item.serverId}:${sessionId}` : null,
            machineId,
            machineLabel,
            workspaceSubtitle: workspaceDisplay.displayTitle,
            workspaceSubtitleEllipsizeMode: workspaceDisplay.subtitleEllipsizeMode,
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
    const displayByKey = new Map<string, ReachableSessionDisplay>();
    const machineKeys = new Set<string>();
    for (const row of sessionDisplayRows) {
        const display = {
            machineId: row.machineId,
            machineLabel: row.machineLabel,
            workspaceSubtitle: row.workspaceSubtitle,
            workspaceSubtitleEllipsizeMode: row.workspaceSubtitleEllipsizeMode,
        };
        displayById.set(row.sessionId, display);
        if (row.sessionKey) {
            displayByKey.set(row.sessionKey, display);
        }

        const machineKey = row.machineId ?? row.machineLabel ?? '';
        if (machineKey) {
            machineKeys.add(machineKey);
        }
    }

    const next = {
        displayById,
        displayByKey,
        hasMultipleMachines: machineKeys.size > 1,
    };

    SESSION_LIST_REACHABILITY_SUMMARY_CACHE.set(cacheKey, next);
    return next;
}
