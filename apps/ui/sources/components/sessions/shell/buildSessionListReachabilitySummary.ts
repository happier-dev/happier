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

type SessionDisplayRow = Readonly<{
    sessionId: string;
    sessionKey: string | null;
    machineKey: string;
    display: ReachableSessionDisplay;
}>;

type SessionListReachabilitySummaryCacheEntry = Readonly<{
    machinesById: ReadonlyMap<string, unknown>;
    renderable: SessionListReachabilityRenderable | null;
    row: SessionDisplayRow;
    serverId?: string | null;
    sessionId: string;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
}>;

export type SessionListReachabilitySummaryCache = {
    entriesByKey: Map<string, SessionListReachabilitySummaryCacheEntry>;
    previousRows: readonly SessionDisplayRow[];
    previousSummary: SessionListReachabilitySummary | null;
};

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

export function createSessionListReachabilitySummaryCache(): SessionListReachabilitySummaryCache {
    return {
        entriesByKey: new Map<string, SessionListReachabilitySummaryCacheEntry>(),
        previousRows: [],
        previousSummary: null,
    };
}

function resolveRowCacheKey(item: Extract<SessionListIndexItem, { type: 'session' }>, sessionId: string): string {
    const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
    return serverId ? `${serverId}:${sessionId}` : sessionId;
}

function buildSessionDisplayRow(input: Readonly<{
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    machinesById: ReadonlyMap<string, unknown>;
    renderable: SessionListReachabilityRenderable | null;
    sessionId: string;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
}>): SessionDisplayRow {
    const metadata = input.renderable?.metadata ?? null;
    const machineTarget = readDisplayMachineTargetForSession({
        sessionId: input.sessionId,
        metadata,
    });
    const machineId = machineTarget?.machineId ?? (String(metadata?.machineId ?? '').trim() || null);
    const machineLabel = machineId
        ? getMachineDisplayName(input.machinesById.get(machineId) as Parameters<typeof getMachineDisplayName>[0])
            ?? String(metadata?.host ?? '').trim()
        : String(metadata?.host ?? '').trim();
    const workspaceDisplay = resolveSessionWorkspaceDisplayPresentation({
        serverId: input.item.serverId,
        metadata,
        machineTarget,
        workspaceRefs: input.workspaceRefs,
        workspacePathDisplayModeV1: input.workspacePathDisplayModeV1,
    });
    const display = {
        machineId,
        machineLabel,
        workspaceSubtitle: workspaceDisplay.displayTitle,
        workspaceSubtitleEllipsizeMode: workspaceDisplay.subtitleEllipsizeMode,
    } satisfies ReachableSessionDisplay;

    return {
        sessionId: input.sessionId,
        sessionKey: input.item.serverId ? `${input.item.serverId}:${input.sessionId}` : null,
        machineKey: machineId ?? machineLabel ?? '',
        display,
    };
}

function canReuseCacheEntry(input: Readonly<{
    cached: SessionListReachabilitySummaryCacheEntry | undefined;
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    machinesById: ReadonlyMap<string, unknown>;
    renderable: SessionListReachabilityRenderable | null;
    sessionId: string;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
}>): input is Readonly<{
    cached: SessionListReachabilitySummaryCacheEntry;
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    machinesById: ReadonlyMap<string, unknown>;
    renderable: SessionListReachabilityRenderable | null;
    sessionId: string;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
}> {
    return input.cached != null
        && input.cached.sessionId === input.sessionId
        && input.cached.serverId === input.item.serverId
        && input.cached.renderable === input.renderable
        && input.cached.machinesById === input.machinesById
        && input.cached.workspaceRefs === input.workspaceRefs
        && input.cached.workspacePathDisplayModeV1 === input.workspacePathDisplayModeV1;
}

function buildSessionDisplayRows(input: Readonly<{
    cache?: SessionListReachabilitySummaryCache;
    listItems: ReadonlyArray<SessionListIndexItem>;
    machinesById: ReadonlyMap<string, unknown>;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    resolveSessionRenderable: (item: Extract<SessionListIndexItem, { type: 'session' }>) => SessionListReachabilityRenderable | null;
}>): readonly SessionDisplayRow[] {
    const rows: SessionDisplayRow[] = [];
    const nextCacheEntriesByKey = input.cache ? new Map<string, SessionListReachabilitySummaryCacheEntry>() : null;

    for (const item of input.listItems) {
        if (!item || item.type !== 'session') {
            continue;
        }

        const sessionId = String(item.sessionId ?? '').trim();
        if (!sessionId) continue;
        const renderable = input.resolveSessionRenderable(item);
        const rowCacheKey = resolveRowCacheKey(item, sessionId);
        const cached = input.cache?.entriesByKey.get(rowCacheKey);
        const canReuse = canReuseCacheEntry({
            cached,
            item,
            machinesById: input.machinesById,
            renderable,
            sessionId,
            workspaceRefs: input.workspaceRefs,
            workspacePathDisplayModeV1: input.workspacePathDisplayModeV1,
        });
        const row = canReuse && cached
            ? cached.row
            : buildSessionDisplayRow({
                item,
                machinesById: input.machinesById,
                renderable,
                sessionId,
                workspaceRefs: input.workspaceRefs,
                workspacePathDisplayModeV1: input.workspacePathDisplayModeV1,
            });
        rows.push(row);
        nextCacheEntriesByKey?.set(rowCacheKey, {
            machinesById: input.machinesById,
            renderable,
            row,
            serverId: item.serverId,
            sessionId,
            workspacePathDisplayModeV1: input.workspacePathDisplayModeV1,
            workspaceRefs: input.workspaceRefs,
        });
    }

    if (input.cache && nextCacheEntriesByKey) {
        input.cache.entriesByKey = nextCacheEntriesByKey;
    }

    return rows;
}

function areDisplayRowsReferenceEqual(left: readonly SessionDisplayRow[], right: readonly SessionDisplayRow[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((row, index) => row === right[index]);
}

function buildSummaryFromDisplayRows(rows: readonly SessionDisplayRow[]): SessionListReachabilitySummary {
    if (rows.length === 0) {
        return EMPTY_SESSION_LIST_REACHABILITY_SUMMARY;
    }

    const displayById = new Map<string, ReachableSessionDisplay>();
    const displayByKey = new Map<string, ReachableSessionDisplay>();
    const machineKeys = new Set<string>();
    for (const row of rows) {
        displayById.set(row.sessionId, row.display);
        if (row.sessionKey) {
            displayByKey.set(row.sessionKey, row.display);
        }
        if (row.machineKey) {
            machineKeys.add(row.machineKey);
        }
    }

    return {
        displayById,
        displayByKey,
        hasMultipleMachines: machineKeys.size > 1,
    };
}

function buildSummaryCacheKey(input: Readonly<{
    rows: readonly SessionDisplayRow[];
    machinesById: ReadonlyMap<string, unknown>;
}>): string {
    return JSON.stringify([
        input.rows,
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
}

export function buildSessionListReachabilitySummary(input: Readonly<{
    listItems: ReadonlyArray<SessionListIndexItem>;
    machinesById: ReadonlyMap<string, unknown>;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    resolveSessionRenderable: (item: Extract<SessionListIndexItem, { type: 'session' }>) => SessionListReachabilityRenderable | null;
    cache?: SessionListReachabilitySummaryCache;
}>): SessionListReachabilitySummary {
    const rows = buildSessionDisplayRows(input);

    if (rows.length === 0) {
        if (input.cache) {
            input.cache.previousRows = [];
            input.cache.previousSummary = EMPTY_SESSION_LIST_REACHABILITY_SUMMARY;
        }
        return EMPTY_SESSION_LIST_REACHABILITY_SUMMARY;
    }

    if (input.cache) {
        if (
            input.cache.previousSummary
            && areDisplayRowsReferenceEqual(input.cache.previousRows, rows)
        ) {
            return input.cache.previousSummary;
        }
        const summary = buildSummaryFromDisplayRows(rows);
        input.cache.previousRows = rows;
        input.cache.previousSummary = summary;
        return summary;
    }

    const cacheKey = buildSummaryCacheKey({ rows, machinesById: input.machinesById });
    const cached = SESSION_LIST_REACHABILITY_SUMMARY_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const next = buildSummaryFromDisplayRows(rows);
    SESSION_LIST_REACHABILITY_SUMMARY_CACHE.set(cacheKey, next);
    return next;
}
