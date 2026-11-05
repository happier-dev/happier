import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListReachabilityRenderable } from '@/sync/domains/state/storage';
import { resolveSessionWorkspaceDisplayPresentation } from '@/sync/domains/session/listing/sessionWorkspaceDisplayPresentation';
import type { WorkspaceDisplayEllipsizeMode } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import type { WorkspacePathDisplayModeV1 } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { readDisplayMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readSessionListProjectHeaderMachineId } from './sessionListProjectHeaderViewModels';
import { machineCollectionValues, findMachineInCollection, type MachineCollection } from '@/sync/domains/machines/identity/machineCollection';
import { normalizeMachineHost } from '@happier-dev/protocol/machines/host/normalizeMachineHost';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';

type ReachabilityMachineDisplay = Readonly<Pick<MachineDisplayRenderable, 'id' | 'metadata' | 'replacedByMachineId'>
    & Partial<Pick<MachineDisplayRenderable, 'availability' | 'active' | 'revokedAt'>>>;

type ReachableSessionDisplay = Readonly<{
    machineId: string | null;
    machineLabel: string;
    workspaceSubtitle: string;
    workspaceSubtitleEllipsizeMode: WorkspaceDisplayEllipsizeMode;
}>;

type SessionDisplayRow = Readonly<{
    serverId: string | null;
    sessionId: string;
    sessionKey: string | null;
    machineKey: string;
    display: ReachableSessionDisplay;
}>;

type SessionListReachabilitySummaryCacheEntry = Readonly<{
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    position: number;
    machineIds: ReadonlySet<string>;
    host: string;
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
    machinesById: Map<string, ReachabilityMachineDisplay>;
    rowKeysByMachineId: Map<string, Set<string>>;
    rowKeysByHost: Map<string, Set<string>>;
    machineKeyCounts: Map<string, number>;
    headerMachineIds: Set<string>;
    listItems?: ReadonlyArray<SessionListIndexItem>;
    workspaceRefs?: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    renderablesByKey?: ReadonlyMap<string, SessionListReachabilityRenderable>;
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

export function createSessionListReachabilitySummaryCache(): SessionListReachabilitySummaryCache {
    return {
        entriesByKey: new Map<string, SessionListReachabilitySummaryCacheEntry>(),
        previousRows: [],
        previousSummary: null,
        machinesById: new Map(), rowKeysByMachineId: new Map(), rowKeysByHost: new Map(),
        machineKeyCounts: new Map(), headerMachineIds: new Set(),
    };
}

export function retireSessionListReachabilitySummaryCacheServerScope(
    cache: SessionListReachabilitySummaryCache,
    serverId: string,
): void {
    for (const [key, entry] of cache.entriesByKey) {
        if (entry.serverId && areServerProfileIdentifiersEquivalent(entry.serverId, serverId)) {
            cache.entriesByKey.delete(key);
        }
    }
    cache.previousRows = cache.previousRows.filter((row) => (
        !row.serverId || !areServerProfileIdentifiersEquivalent(row.serverId, serverId)
    ));
    // The summary maps aggregate all rows. Rebuild them on the next render while
    // retaining unaffected per-row cache entries from the same valid lifetimes.
    cache.previousSummary = null;
    cache.listItems = undefined;
}

function resolveRowCacheKey(item: Extract<SessionListIndexItem, { type: 'session' }>, sessionId: string): string {
    const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
    return serverId ? sessionAddressKey({ serverId, sessionId }) : sessionId;
}

function buildSessionDisplayRow(input: Readonly<{
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    machinesById: MachineCollection<ReachabilityMachineDisplay>;
    renderable: SessionListReachabilityRenderable | null;
    sessionId: string;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
}>): SessionDisplayRow {
    const serverId = typeof input.item.serverId === 'string' ? input.item.serverId.trim() : '';
    const metadata = input.renderable?.metadata ?? null;
    const machineTarget = readDisplayMachineTargetForSession({
        sessionId: input.sessionId,
        serverId,
        metadata,
    });
    const machineId = machineTarget?.machineId ?? (String(metadata?.machineId ?? '').trim() || null);
    const machineLabel = machineId
        ? getMachineDisplayName(findMachineInCollection(input.machinesById, machineId))
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
        serverId: serverId || null,
        sessionId: input.sessionId,
        sessionKey: serverId
            ? sessionAddressKey({ serverId, sessionId: input.sessionId })
            : null,
        machineKey: machineId ?? machineLabel ?? '',
        display,
    };
}

function sameMachineDisplayInput(left: ReachabilityMachineDisplay | undefined, right: ReachabilityMachineDisplay): boolean {
    return left === right || Boolean(left && left.id === right.id
        && left.replacedByMachineId === right.replacedByMachineId
        && left.revokedAt === right.revokedAt
        && (left.metadata === null) === (right.metadata === null)
        && left.availability?.kind === right.availability?.kind
        && left.metadata?.displayName === right.metadata?.displayName
        && left.metadata?.host === right.metadata?.host && left.metadata?.homeDir === right.metadata?.homeDir);
}

function indexRow(index: Map<string, Set<string>>, dependency: string, rowKey: string, add: boolean): void {
    if (!dependency) return;
    const rows = index.get(dependency) ?? new Set<string>();
    if (add) rows.add(rowKey); else rows.delete(rowKey);
    if (rows.size) index.set(dependency, rows); else index.delete(dependency);
}

function buildSessionDisplayRows(input: Readonly<{
    cache?: SessionListReachabilitySummaryCache;
    listItems: ReadonlyArray<SessionListIndexItem>;
    machinesById: MachineCollection<ReachabilityMachineDisplay>;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    resolveSessionRenderable: (item: Extract<SessionListIndexItem, { type: 'session' }>) => SessionListReachabilityRenderable | null;
    renderablesByKey?: ReadonlyMap<string, SessionListReachabilityRenderable>;
}>): readonly SessionDisplayRow[] {
    const cache = input.cache ?? createSessionListReachabilitySummaryCache();
    const structuralChange = cache.listItems !== input.listItems || cache.workspaceRefs !== input.workspaceRefs
        || cache.workspacePathDisplayModeV1 !== input.workspacePathDisplayModeV1;
    const dirty = new Set<string>();
    const invalidateMachine = (id: string) => {
        for (const key of cache.rowKeysByMachineId.get(id) ?? []) dirty.add(key);
    };
    const invalidateHost = (machine?: ReachabilityMachineDisplay) => {
        for (const key of cache.rowKeysByHost.get(normalizeMachineHost(machine?.metadata?.host)) ?? []) dirty.add(key);
    };
    const removedMachineIds = new Set(cache.machinesById.keys());
    for (const machine of machineCollectionValues(input.machinesById)) {
        removedMachineIds.delete(machine.id);
        const previous = cache.machinesById.get(machine.id);
        if (!sameMachineDisplayInput(previous, machine)) {
            invalidateMachine(machine.id);
            if (!previous || previous.revokedAt !== machine.revokedAt
                || previous.replacedByMachineId !== machine.replacedByMachineId
                || previous.metadata?.host !== machine.metadata?.host || previous.metadata?.homeDir !== machine.metadata?.homeDir) {
                invalidateHost(previous); invalidateHost(machine);
            }
        }
        cache.machinesById.set(machine.id, machine);
    }
    for (const id of removedMachineIds) {
        invalidateMachine(id); invalidateHost(cache.machinesById.get(id));
        cache.machinesById.delete(id);
    }
    let rows: SessionDisplayRow[] | readonly SessionDisplayRow[] = cache.previousRows;
    const itemsByKey = new Map<string, Extract<SessionListIndexItem, { type: 'session' }>>();
    const invalidatedByMachine = structuralChange ? new Set(dirty) : dirty;
    if (structuralChange) {
        rows = [];
        dirty.clear(); cache.machineKeyCounts.clear(); cache.headerMachineIds.clear();
        for (const item of input.listItems) {
            if (item.type === 'header' && item.headerKind === 'project') {
                const machineId = readSessionListProjectHeaderMachineId(item, input.workspaceRefs);
                if (machineId) cache.headerMachineIds.add(machineId);
            }
            if (item.type !== 'session' || !item.sessionId.trim()) continue;
            const key = resolveRowCacheKey(item, item.sessionId.trim());
            itemsByKey.set(key, item);
            dirty.add(key);
        }
        for (const key of cache.entriesByKey.keys()) if (!itemsByKey.has(key)) cache.entriesByKey.delete(key);
        cache.rowKeysByMachineId.clear(); cache.rowKeysByHost.clear();
    } else if (!input.renderablesByKey || cache.renderablesByKey !== input.renderablesByKey) {
        // Only Session input changes inspect Session references. Machine changes use the
        // dependency index above and never resolve every Session's metadata/target again.
        for (const [key, entry] of cache.entriesByKey) {
            const next = input.renderablesByKey ? input.renderablesByKey.get(key) ?? null : input.resolveSessionRenderable(entry.item);
            if (entry.renderable !== next) dirty.add(key);
        }
    }
    let position = 0;
    for (const rowCacheKey of dirty) {
        const cached = cache.entriesByKey.get(rowCacheKey);
        const item = itemsByKey.get(rowCacheKey) ?? cached?.item;
        if (!item) continue;
        const sessionId = item.sessionId.trim();
        const renderable = input.renderablesByKey ? input.renderablesByKey.get(rowCacheKey) ?? null : input.resolveSessionRenderable(item);
        // Layout/order changes consume existing displays; they do not change
        // target, label or workspace inputs. Keep simultaneous Machine edits dirty.
        const nextRow = cached && !invalidatedByMachine.has(rowCacheKey)
            && cached.renderable === renderable
            && cached.workspaceRefs === input.workspaceRefs
            && cached.workspacePathDisplayModeV1 === input.workspacePathDisplayModeV1
            ? cached.row
            : buildSessionDisplayRow({ ...input, item, sessionId, renderable });
        const previous = cached?.row;
        const row = previous && previous.machineKey === nextRow.machineKey
            && previous.display.machineId === nextRow.display.machineId
            && previous.display.machineLabel === nextRow.display.machineLabel
            && previous.display.workspaceSubtitle === nextRow.display.workspaceSubtitle
            && previous.display.workspaceSubtitleEllipsizeMode === nextRow.display.workspaceSubtitleEllipsizeMode
            ? previous : nextRow;
        const rowPosition = structuralChange ? position++ : cached!.position;
        if (!structuralChange && previous?.machineKey) {
            const count = (cache.machineKeyCounts.get(previous.machineKey) ?? 1) - 1;
            if (count) cache.machineKeyCounts.set(previous.machineKey, count); else cache.machineKeyCounts.delete(previous.machineKey);
        }
        if (row.machineKey) cache.machineKeyCounts.set(row.machineKey, (cache.machineKeyCounts.get(row.machineKey) ?? 0) + 1);
        if (rows === cache.previousRows && row !== previous) rows = [...rows];
        if (rows !== cache.previousRows) (rows as SessionDisplayRow[])[rowPosition] = row;
        if (cached && !structuralChange) {
            for (const id of cached.machineIds) indexRow(cache.rowKeysByMachineId, id, rowCacheKey, false);
            indexRow(cache.rowKeysByHost, cached.host, rowCacheKey, false);
        }
        // Dependency tracking observes the canonical target's inputs/result; it does
        // not choose a target or a replacement. Host fallback/locality rows also track
        // Machine additions, removals and ambiguity changes through the canonical host key.
        const machineIds = new Set<string>();
        for (const seed of [resolveSessionMachineId(renderable?.metadata), row.display.machineId]) {
            let id = seed;
            while (id && !machineIds.has(id)) {
                machineIds.add(id);
                id = findMachineInCollection(input.machinesById, id)?.replacedByMachineId ?? null;
            }
        }
        const host = normalizeMachineHost(renderable?.metadata?.host);
        for (const id of machineIds) indexRow(cache.rowKeysByMachineId, id, rowCacheKey, true);
        indexRow(cache.rowKeysByHost, host, rowCacheKey, true);
        cache.entriesByKey.set(rowCacheKey, { item, position: rowPosition, machineIds, host, renderable, row,
            serverId: item.serverId, sessionId, workspacePathDisplayModeV1: input.workspacePathDisplayModeV1, workspaceRefs: input.workspaceRefs });
    }
    cache.listItems = input.listItems; cache.workspaceRefs = input.workspaceRefs;
    cache.workspacePathDisplayModeV1 = input.workspacePathDisplayModeV1;
    cache.renderablesByKey = input.renderablesByKey;
    return rows;
}

function areDisplayRowsReferenceEqual(left: readonly SessionDisplayRow[], right: readonly SessionDisplayRow[]): boolean {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    return left.every((row, index) => row === right[index]);
}

function buildSummaryFromDisplayRows(rows: readonly SessionDisplayRow[], hasMultipleMachines: boolean): SessionListReachabilitySummary {
    if (rows.length === 0 && !hasMultipleMachines) {
        return EMPTY_SESSION_LIST_REACHABILITY_SUMMARY;
    }

    const displayById = new Map<string, ReachableSessionDisplay>();
    const displayByKey = new Map<string, ReachableSessionDisplay>();
    for (const row of rows) {
        displayById.set(row.sessionId, row.display);
        if (row.sessionKey) {
            displayByKey.set(row.sessionKey, row.display);
        }
    }

    return {
        displayById,
        displayByKey,
        hasMultipleMachines,
    };
}

export function buildSessionListReachabilitySummary(input: Readonly<{
    listItems: ReadonlyArray<SessionListIndexItem>;
    machinesById: MachineCollection<ReachabilityMachineDisplay>;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    resolveSessionRenderable: (item: Extract<SessionListIndexItem, { type: 'session' }>) => SessionListReachabilityRenderable | null;
    cache?: SessionListReachabilitySummaryCache;
    renderablesByKey?: ReadonlyMap<string, SessionListReachabilityRenderable>;
}>): SessionListReachabilitySummary {
    const cache = input.cache ?? createSessionListReachabilitySummaryCache();
    const rows = buildSessionDisplayRows({ ...input, cache });
    const machineKeys = new Set([...cache.machineKeyCounts.keys(), ...cache.headerMachineIds]);
    const hasMultipleMachines = machineKeys.size > 1;

    if (rows.length === 0 && !hasMultipleMachines) {
        if (input.cache) {
            input.cache.previousRows = [];
            input.cache.previousSummary = EMPTY_SESSION_LIST_REACHABILITY_SUMMARY;
        }
        return EMPTY_SESSION_LIST_REACHABILITY_SUMMARY;
    }

    if (input.cache) {
        if (
            input.cache.previousSummary
            && input.cache.previousSummary.hasMultipleMachines === hasMultipleMachines
            && areDisplayRowsReferenceEqual(input.cache.previousRows, rows)
        ) {
            return input.cache.previousSummary;
        }
        const summary = buildSummaryFromDisplayRows(rows, hasMultipleMachines);
        input.cache.previousRows = rows;
        input.cache.previousSummary = summary;
        return summary;
    }

    return buildSummaryFromDisplayRows(rows, hasMultipleMachines);
}
