import type { ServerSelectionPresentation } from '@/sync/domains/server/selection/serverSelectionTypes';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import { applySessionListIndexPresentation } from './sessionListIndexPresentation';
import {
    applySessionListAttentionPlacementWithinGroups,
    applySessionListWorkingPlacementWithinGroups,
    buildSessionListAttentionPlacement,
    buildSessionListWorkingPlacement,
    normalizeSessionListAttentionPlacementMode,
    normalizeSessionListWorkingPlacementMode,
    type SessionListAttentionPlacementOptions,
    type SessionListWorkingPlacementOptions,
} from './sessionListAttentionPlacement';
import {
    applySessionWorkspaceOrderV1ToIndex,
    type SessionWorkspaceOrderV1,
} from './sessionWorkspaceOrderStateV1';
import { normalizeTrimmedStringArrayWithSharedEmpty } from './normalizeTrimmedStringArrayWithSharedEmpty';
import { normalizeSessionListKeyParts } from './sessionListKeyNormalization';
import { normalizeTrimmedString } from './normalizeTrimmedString';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { buildSessionFolderWorkspaceRefKey } from '@/sync/domains/session/folders/workspaceRefs';
import {
    buildSessionListSessionOrderingKey,
    compareSessionListSessionOrderingKeys,
    normalizeSessionListFolderSortModeV1,
    normalizeSessionListOrderingModeV1,
    resolveEffectiveSessionListFolderSortMode,
    resolveEffectiveSessionListOrderingModeForGroup,
    type SessionListFolderSortModeV1,
    type SessionListOrderingModeV1,
    type SessionListSessionOrderingKey,
    type SessionListOrderingSectionMode,
} from './sessionListOrderingRules';

export type { SessionListFolderSortModeV1, SessionListOrderingModeV1 } from './sessionListOrderingRules';

export type ComputeVisibleSessionListIndexParams = Readonly<{
    source: ReadonlyArray<SessionListIndexItem> | null;
    resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null;
    hideInactiveSessions: boolean;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
    sessionWorkspaceOrderV1?: SessionWorkspaceOrderV1;
    sessionListOrderingModeV1?: SessionListOrderingModeV1;
    sessionListSectionModeV1?: SessionListOrderingSectionMode;
    sessionListFolderSortModeV1?: SessionListFolderSortModeV1;
    attentionPlacement?: SessionListAttentionPlacementOptions;
    workingPlacement?: SessionListWorkingPlacementOptions;
    presentation: Readonly<{
        enabled: boolean;
        presentation: ServerSelectionPresentation;
        selectedServerIds?: ReadonlyArray<string>;
    }>;
    storageFilterApplied?: boolean;
    nowMs?: number;
}>;

const PINNED_GROUP_KEY_V1 = 'pinned-v1';

type VisibleSessionListSourceState = Readonly<{
    hasArchivedSessionItems: boolean;
    hasMissingSessionRows: boolean;
    hasInactiveSessionsThatNeedFiltering: boolean;
    hasOrphanHeaders: boolean;
    visiblePlaceholderRows: number;
}>;

function resolveSessionRowForItem(
    item: Extract<SessionListIndexItem, { type: 'session' }>,
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
): SessionListRenderableSession | null {
    const sessionId = normalizeTrimmedString(item.sessionId);
    if (!sessionId) return null;
    const serverId = normalizeTrimmedString(item.serverId) || null;
    return resolveSessionRow(serverId, sessionId);
}

function isPrimarySessionListSectionHeader(item: Extract<SessionListIndexItem, { type: 'header' }>): boolean {
    return item.headerKind === 'active' || item.headerKind === 'inactive' || item.headerKind === 'sessions';
}

function inspectVisibleSessionListSourceState(
    items: ReadonlyArray<SessionListIndexItem>,
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
): VisibleSessionListSourceState {
    let hasArchivedSessionItems = false;
    let hasMissingSessionRows = false;
    let hasInactiveSessionsThatNeedFiltering = false;
    let visiblePlaceholderRows = 0;
    let pendingSectionHeader: Extract<SessionListIndexItem, { type: 'header' }> | null = null;
    let pendingGroupHeader: Extract<SessionListIndexItem, { type: 'header' }> | null = null;

    for (const item of items) {
        if (item.type === 'header') {
            if (isPrimarySessionListSectionHeader(item)) {
                pendingSectionHeader = item;
                pendingGroupHeader = null;
            } else {
                pendingGroupHeader = item;
            }
            continue;
        }

        if (item.type !== 'session') {
            continue;
        }

        pendingSectionHeader = null;
        pendingGroupHeader = null;

        const row = resolveSessionRowForItem(item, resolveSessionRow);
        if (!row) {
            hasMissingSessionRows = true;
            visiblePlaceholderRows += 1;
            continue;
        }

        if (row.metadata == null) {
            visiblePlaceholderRows += 1;
        }

        if (!hasArchivedSessionItems && row.archivedAt != null) {
            hasArchivedSessionItems = true;
        }

        if (
            !hasInactiveSessionsThatNeedFiltering
            && item.section !== 'active'
            && row.active !== true
            && row.keepVisibleWhenInactive !== true
        ) {
            hasInactiveSessionsThatNeedFiltering = true;
        }
    }

    return {
        hasArchivedSessionItems,
        hasMissingSessionRows,
        hasInactiveSessionsThatNeedFiltering,
        hasOrphanHeaders: pendingSectionHeader != null || pendingGroupHeader != null,
        visiblePlaceholderRows,
    };
}

function countOrderedGroups(orderByGroupKey: Readonly<Record<string, ReadonlyArray<string> | undefined>> | undefined): number {
    if (!orderByGroupKey) return 0;
    return Object.values(orderByGroupKey).filter((keys) => Array.isArray(keys) && keys.length > 0).length;
}

function countPinnedSessionKeys(keys: ReadonlyArray<string> | undefined): number {
    return (keys ?? []).filter((key) => typeof key === 'string' && key.trim().length > 0).length;
}

function countVisiblePlaceholderRows(params: Readonly<{
    result: ReadonlyArray<SessionListIndexItem>;
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'];
}>): number {
    let count = 0;
    for (const item of params.result) {
        if (item.type !== 'session') continue;
        const row = resolveSessionRowForItem(item, params.resolveSessionRow);
        if (!row || row.metadata == null) {
            count += 1;
        }
    }
    return count;
}

function countSessionItems(items: ReadonlyArray<SessionListIndexItem>): number {
    let count = 0;
    for (const item of items) {
        if (item.type === 'session') {
            count += 1;
        }
    }
    return count;
}

function hasNonCustomEffectiveSessionOrdering(
    source: ReadonlyArray<SessionListIndexItem>,
    orderingMode: SessionListOrderingModeV1,
    sectionMode: SessionListOrderingSectionMode,
): boolean {
    for (const item of source) {
        if (item.type !== 'session') continue;
        if (resolveEffectiveOrderingModeForSessionItem(item, orderingMode, sectionMode) !== 'custom') {
            return true;
        }
    }
    return false;
}

function nowMs(): number {
    const perf = (globalThis as unknown as { performance?: { now?: () => number } }).performance;
    if (typeof perf?.now === 'function') {
        return perf.now();
    }
    return Date.now();
}

type SessionIndexItem = Extract<SessionListIndexItem, { type: 'session' }>;

function resolveEffectiveOrderingModeForSessionItem(
    item: SessionIndexItem,
    orderingMode: SessionListOrderingModeV1,
    sectionMode: SessionListOrderingSectionMode,
): SessionListOrderingModeV1 {
    return resolveEffectiveSessionListOrderingModeForGroup({
        section: sectionMode === 'single' ? 'sessions' : item.section,
        sectionMode,
        groupKind: item.groupKind,
        userOrderingMode: orderingMode,
    });
}

function resolveSessionOrderingScopeKey(item: SessionIndexItem, sectionMode: SessionListOrderingSectionMode): string | null {
    const groupKey = normalizeTrimmedString(item.groupKey);
    if (!groupKey) return null;
    const section = sectionMode === 'single'
        ? 'sessions'
        : normalizeTrimmedString(item.section) || 'active';
    return `${section}\u0000${groupKey}`;
}

function buildOrderingKeyCache(
    sessions: ReadonlyArray<SessionIndexItem>,
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
): Map<SessionIndexItem, SessionListSessionOrderingKey> {
    const cache = new Map<SessionIndexItem, SessionListSessionOrderingKey>();
    for (const item of sessions) {
        cache.set(item, buildSessionListSessionOrderingKey({
            item,
            row: resolveSessionRowForItem(item, resolveSessionRow),
        }));
    }
    return cache;
}

function compareSessionItemsByOrderingKey(
    a: SessionIndexItem,
    b: SessionIndexItem,
    orderingMode: SessionListOrderingModeV1,
    keyCache: ReadonlyMap<SessionIndexItem, SessionListSessionOrderingKey>,
): number {
    const keyA = keyCache.get(a);
    const keyB = keyCache.get(b);
    if (!keyA || !keyB) return 0;
    return compareSessionListSessionOrderingKeys(keyA, keyB, orderingMode);
}

function isSessionListIndexItemsAlreadyOrderedByOrderingMode(
    source: ReadonlyArray<SessionListIndexItem>,
    orderingMode: SessionListOrderingModeV1,
    sectionMode: SessionListOrderingSectionMode,
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
): boolean {
    const lastSessionByScopeKey = new Map<string, SessionIndexItem>();
    const keyCache = new Map<SessionIndexItem, SessionListSessionOrderingKey>();

    for (const item of source) {
        if (item.type !== 'session') continue;

        const scopeKey = resolveSessionOrderingScopeKey(item, sectionMode);
        if (!scopeKey) continue;
        const effectiveMode = resolveEffectiveOrderingModeForSessionItem(item, orderingMode, sectionMode);
        if (effectiveMode === 'custom') continue;
        keyCache.set(item, buildSessionListSessionOrderingKey({
            item,
            row: resolveSessionRowForItem(item, resolveSessionRow),
        }));

        const previous = lastSessionByScopeKey.get(scopeKey);
        if (previous && compareSessionItemsByOrderingKey(previous, item, effectiveMode, keyCache) > 0) {
            return false;
        }

        lastSessionByScopeKey.set(scopeKey, item);
    }

    return lastSessionByScopeKey.size > 0;
}

function sortSessionListIndexItemsByOrderingMode(
    source: ReadonlyArray<SessionListIndexItem>,
    orderingMode: SessionListOrderingModeV1,
    sectionMode: SessionListOrderingSectionMode,
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
): SessionListIndexItem[] {
    if (isSessionListIndexItemsAlreadyOrderedByOrderingMode(source, orderingMode, sectionMode, resolveSessionRow)) {
        return source as SessionListIndexItem[];
    }

    const sessionsByScopeKey = new Map<string, SessionIndexItem[]>();
    const effectiveModeByScopeKey = new Map<string, SessionListOrderingModeV1>();
    for (const item of source) {
        if (item.type !== 'session') continue;
        const scopeKey = resolveSessionOrderingScopeKey(item, sectionMode);
        if (!scopeKey) continue;
        const effectiveMode = resolveEffectiveOrderingModeForSessionItem(item, orderingMode, sectionMode);
        if (effectiveMode === 'custom') continue;
        if (!sessionsByScopeKey.has(scopeKey)) {
            sessionsByScopeKey.set(scopeKey, []);
            effectiveModeByScopeKey.set(scopeKey, effectiveMode);
        }
        sessionsByScopeKey.get(scopeKey)!.push(item);
    }

    const sortedByScopeKey = new Map<string, SessionIndexItem[]>();
    for (const [scopeKey, sessions] of sessionsByScopeKey.entries()) {
        if (sessions.length < 2) continue;
        const effectiveMode = effectiveModeByScopeKey.get(scopeKey) ?? orderingMode;
        const keyCache = buildOrderingKeyCache(sessions, resolveSessionRow);
        const next = [...sessions].sort((a, b) => compareSessionItemsByOrderingKey(a, b, effectiveMode, keyCache));
        sortedByScopeKey.set(scopeKey, next);
    }

    if (sortedByScopeKey.size === 0) {
        return source as SessionListIndexItem[];
    }

    const indicesByScopeKey = new Map<string, number>();
    const out: SessionListIndexItem[] = [];
    let didChange = false;
    for (const item of source) {
        if (item.type !== 'session') {
            out.push(item);
            continue;
        }
        const scopeKey = resolveSessionOrderingScopeKey(item, sectionMode);
        if (!scopeKey) {
            out.push(item);
            continue;
        }
        const replacementList = sortedByScopeKey.get(scopeKey);
        if (!replacementList) {
            out.push(item);
            continue;
        }
        const index = indicesByScopeKey.get(scopeKey) ?? 0;
        const replacement = replacementList[index] ?? item;
        if (replacement !== item) {
            didChange = true;
        }
        out.push(replacement);
        indicesByScopeKey.set(scopeKey, index + 1);
    }

    return didChange ? out : (source as SessionListIndexItem[]);
}

function reorderSessionItemsByKeys(
    items: ReadonlyArray<Extract<SessionListIndexItem, { type: 'session' }>>,
    keys: ReadonlyArray<string> | undefined,
): Array<Extract<SessionListIndexItem, { type: 'session' }>> {
    if (!keys || keys.length === 0 || items.length < 2) {
        return [...items];
    }

    const byKey = new Map<string, Extract<SessionListIndexItem, { type: 'session' }>>();
    for (const item of items) {
        const k = normalizeSessionListKeyParts(item.serverId, item.sessionId).sessionKey;
        if (k) {
            byKey.set(k, item);
        }
    }

    const out: Array<Extract<SessionListIndexItem, { type: 'session' }>> = [];
    const used = new Set<Extract<SessionListIndexItem, { type: 'session' }>>();

    for (const key of keys) {
        const normalized = typeof key === 'string' ? key.trim() : '';
        if (!normalized) continue;
        const found = byKey.get(normalized);
        if (found && !used.has(found)) {
            out.push(found);
            used.add(found);
        }
    }

    const unordered = items.filter((item) => !used.has(item));
    return [...unordered, ...out];
}

function reorderPinnedSessionItemsByStructuralKeys(
    items: ReadonlyArray<SessionIndexItem>,
    structuralKeys: ReadonlyArray<string> | undefined,
    fallbackKeys: ReadonlyArray<string> | undefined,
): SessionIndexItem[] {
    if (items.length < 2) {
        return [...items];
    }

    const byKey = new Map<string, SessionIndexItem>();
    for (const item of items) {
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId).sessionKey;
        if (key) {
            byKey.set(key, item);
        }
    }

    const out: SessionIndexItem[] = [];
    const used = new Set<SessionIndexItem>();
    const appendKnownKeys = (keys: ReadonlyArray<string> | undefined) => {
        for (const key of keys ?? []) {
            const normalized = normalizeTrimmedString(key);
            if (!normalized) continue;
            const found = byKey.get(normalized);
            if (found && !used.has(found)) {
                out.push(found);
                used.add(found);
            }
        }
    };

    appendKnownKeys(structuralKeys);
    appendKnownKeys(fallbackKeys);

    const remaining = items
        .filter((item) => !used.has(item))
        .sort((a, b) => {
            const keyA = normalizeSessionListKeyParts(a.serverId, a.sessionId).sessionKey || a.sessionId;
            const keyB = normalizeSessionListKeyParts(b.serverId, b.sessionId).sessionKey || b.sessionId;
            return keyA.localeCompare(keyB);
        });
    return [...out, ...remaining];
}

function orderPinnedSessionItems(params: Readonly<{
    items: ReadonlyArray<SessionIndexItem>;
    structuralKeys: ReadonlyArray<string> | undefined;
    fallbackKeys: ReadonlyArray<string> | undefined;
    orderingMode: SessionListOrderingModeV1;
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'];
}>): SessionIndexItem[] {
    if (params.orderingMode === 'custom') {
        return reorderPinnedSessionItemsByStructuralKeys(
            params.items,
            params.structuralKeys,
            params.fallbackKeys,
        );
    }

    return sortSessionListIndexItemsByOrderingMode(
        params.items,
        params.orderingMode,
        'single',
        params.resolveSessionRow,
    ) as SessionIndexItem[];
}

function isManualSessionOrderSupported(
    item: Extract<SessionListIndexItem, { type: 'session' }>,
    sectionMode: SessionListOrderingSectionMode,
): boolean {
    return resolveEffectiveOrderingModeForSessionItem(item, 'custom', sectionMode) === 'custom';
}

function buildFolderOrderKey(folderIdRaw: unknown): string | null {
    const folderId = typeof folderIdRaw === 'string' ? folderIdRaw.trim() : '';
    return folderId ? `folder:${folderId}` : null;
}

function buildListItemOrderKey(item: SessionListIndexItem): string | null {
    if (item.type === 'session') {
        return normalizeSessionListKeyParts(item.serverId, item.sessionId).sessionKey;
    }
    if (item.headerKind === 'folder') {
        return buildFolderOrderKey(item.folderId);
    }
    return null;
}

function readFolderDepth(item: SessionListIndexItem): number {
    const depth = item.type === 'header' ? item.folderDepth : item.folderDepth;
    return typeof depth === 'number' && Number.isFinite(depth) ? Math.max(0, Math.trunc(depth)) : 0;
}

function buildFolderRootGroupKey(item: Extract<SessionListIndexItem, { type: 'header' }>): string | null {
    if (!item.workspace) return null;
    const serverId = String(item.serverId ?? item.workspace.serverId ?? 'local').trim() || 'local';
    return `folder:${serverId}:${buildSessionFolderWorkspaceRefKey(item.workspace)}:root`;
}

function resolveFolderParentGroupKeyFromVisibleItems(params: Readonly<{
    items: ReadonlyArray<SessionListIndexItem>;
    itemIndex: number;
    folder: Extract<SessionListIndexItem, { type: 'header' }>;
}>): string | null {
    const depth = readFolderDepth(params.folder);
    if (depth <= 0) return buildFolderRootGroupKey(params.folder);
    for (let index = params.itemIndex - 1; index >= 0; index -= 1) {
        const candidate = params.items[index];
        if (candidate?.type !== 'header' || candidate.headerKind !== 'folder') continue;
        if (readFolderDepth(candidate) < depth) {
            return String(candidate.groupKey ?? '').trim() || null;
        }
    }
    return buildFolderRootGroupKey(params.folder);
}

function isInsideFolderBlock(item: SessionListIndexItem, folderDepth: number): boolean {
    if (item.type === 'session') {
        return readFolderDepth(item) > folderDepth;
    }
    return item.headerKind === 'folder' && readFolderDepth(item) > folderDepth;
}

function findFolderBlockEnd(items: ReadonlyArray<SessionListIndexItem>, startIndex: number, folderDepth: number): number {
    let cursor = startIndex + 1;
    while (cursor < items.length && isInsideFolderBlock(items[cursor]!, folderDepth)) {
        cursor += 1;
    }
    return cursor;
}

type ChildOrderEntry = Readonly<{
    key: string;
    start: number;
    end: number;
}>;

function collectDirectChildOrderEntries(
    items: ReadonlyArray<SessionListIndexItem>,
    groupKey: string,
): ChildOrderEntry[] {
    const entries: ChildOrderEntry[] = [];
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        if (item.type === 'session') {
            if (item.groupKey !== groupKey) continue;
            const key = buildListItemOrderKey(item);
            if (key) entries.push({ key, start: index, end: index + 1 });
            continue;
        }

        if (item.headerKind !== 'folder') continue;
        if (resolveFolderParentGroupKeyFromVisibleItems({ items, itemIndex: index, folder: item }) !== groupKey) continue;
        const key = buildListItemOrderKey(item);
        if (!key) continue;
        const end = findFolderBlockEnd(items, index, readFolderDepth(item));
        entries.push({ key, start: index, end });
        index = end - 1;
    }
    return entries;
}

function collectDirectFolderOrderEntries(
    items: ReadonlyArray<SessionListIndexItem>,
    groupKey: string,
): ChildOrderEntry[] {
    const entries: ChildOrderEntry[] = [];
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        if (item.type !== 'header' || item.headerKind !== 'folder') continue;
        if (resolveFolderParentGroupKeyFromVisibleItems({ items, itemIndex: index, folder: item }) !== groupKey) continue;
        const key = buildListItemOrderKey(item);
        if (!key) continue;
        const end = findFolderBlockEnd(items, index, readFolderDepth(item));
        entries.push({ key, start: index, end });
        index = end - 1;
    }
    return entries;
}

function reorderEntriesByKeys(
    entries: ReadonlyArray<ChildOrderEntry>,
    keys: ReadonlyArray<string>,
): ChildOrderEntry[] {
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    const used = new Set<ChildOrderEntry>();
    const out: ChildOrderEntry[] = [];
    for (const key of keys) {
        const normalized = typeof key === 'string' ? key.trim() : '';
        if (!normalized) continue;
        const found = byKey.get(normalized);
        if (found && !used.has(found)) {
            out.push(found);
            used.add(found);
        }
    }
    const unordered = entries.filter((entry) => !used.has(entry));
    return [...unordered, ...out];
}

function splitChildOrderEntriesIntoContiguousRuns(entries: ReadonlyArray<ChildOrderEntry>): ChildOrderEntry[][] {
    const runs: ChildOrderEntry[][] = [];
    for (const entry of entries) {
        const current = runs[runs.length - 1];
        const previous = current?.[current.length - 1];
        if (!current || !previous || previous.end !== entry.start) {
            runs.push([entry]);
            continue;
        }
        current.push(entry);
    }
    return runs;
}

function applyChildOrderEntryRuns(
    source: ReadonlyArray<SessionListIndexItem>,
    entries: ReadonlyArray<ChildOrderEntry>,
    keys: ReadonlyArray<string>,
): SessionListIndexItem[] {
    const runs = splitChildOrderEntriesIntoContiguousRuns(entries).filter((run) => run.length >= 2);
    if (runs.length === 0) {
        return source as SessionListIndexItem[];
    }

    const out: SessionListIndexItem[] = [];
    let cursor = 0;
    let didChange = false;
    for (const run of runs) {
        const reordered = reorderEntriesByKeys(run, keys);
        const firstEntry = run[0]!;
        const lastEntry = run[run.length - 1]!;
        out.push(...source.slice(cursor, firstEntry.start));
        const activeRun = reordered.every((entry, index) => entry === run[index]) ? run : reordered;
        if (activeRun !== run) {
            didChange = true;
        }
        out.push(...activeRun.flatMap((entry) => source.slice(entry.start, entry.end)));
        cursor = lastEntry.end;
    }
    out.push(...source.slice(cursor));
    return didChange ? out : (source as SessionListIndexItem[]);
}

function applyMixedChildOrderingForGroup(
    source: ReadonlyArray<SessionListIndexItem>,
    groupKey: string,
    keys: ReadonlyArray<string>,
): SessionListIndexItem[] {
    if (!keys.some((key) => typeof key === 'string' && key.startsWith('folder:'))) {
        return source as SessionListIndexItem[];
    }
    const entries = collectDirectChildOrderEntries(source, groupKey);
    if (entries.length < 2) {
        return source as SessionListIndexItem[];
    }
    return applyChildOrderEntryRuns(source, entries, keys);
}

function applyMixedChildOrdering(
    source: ReadonlyArray<SessionListIndexItem>,
    orderByGroupKey: Readonly<Record<string, ReadonlyArray<string> | undefined>>,
): SessionListIndexItem[] {
    let out = source as SessionListIndexItem[];
    for (const [groupKeyRaw, keys] of Object.entries(orderByGroupKey)) {
        const groupKey = String(groupKeyRaw ?? '').trim();
        if (!groupKey || !keys || keys.length === 0) continue;
        out = applyMixedChildOrderingForGroup(out, groupKey, keys);
    }
    return out;
}

function applyFoldersFirstStructuralOrderingForGroup(
    source: ReadonlyArray<SessionListIndexItem>,
    groupKey: string,
    keys: ReadonlyArray<string>,
): SessionListIndexItem[] {
    if (!keys.some((key) => typeof key === 'string' && key.startsWith('folder:'))) {
        return source as SessionListIndexItem[];
    }
    const entries = collectDirectFolderOrderEntries(source, groupKey);
    if (entries.length < 2) {
        return source as SessionListIndexItem[];
    }
    return applyChildOrderEntryRuns(source, entries, keys);
}

function applyFoldersFirstStructuralOrdering(
    source: ReadonlyArray<SessionListIndexItem>,
    orderByGroupKey: Readonly<Record<string, ReadonlyArray<string> | undefined>>,
): SessionListIndexItem[] {
    let out = source as SessionListIndexItem[];
    for (const [groupKeyRaw, keys] of Object.entries(orderByGroupKey)) {
        const groupKey = String(groupKeyRaw ?? '').trim();
        if (!groupKey || !keys || keys.length === 0) continue;
        out = applyFoldersFirstStructuralOrderingForGroup(out, groupKey, keys);
    }
    return out;
}

function applySessionOnlyGroupOrdering(
    source: ReadonlyArray<SessionListIndexItem>,
    orderByGroupKey: Readonly<Record<string, ReadonlyArray<string> | undefined>>,
    sectionMode: SessionListOrderingSectionMode,
): SessionListIndexItem[] {
    const sessionsByScope = new Map<string, {
        groupKey: string;
        items: Array<Extract<SessionListIndexItem, { type: 'session' }>>;
    }>();

    for (const item of source) {
        if (item.type !== 'session') continue;
        if (!isManualSessionOrderSupported(item, sectionMode)) continue;
        const groupKey = typeof item.groupKey === 'string' ? item.groupKey : '';
        if (!groupKey) continue;
        const scopeKey = resolveSessionOrderingScopeKey(item, sectionMode);
        if (!scopeKey) continue;
        if (!sessionsByScope.has(scopeKey)) {
            sessionsByScope.set(scopeKey, { groupKey, items: [] });
        }
        sessionsByScope.get(scopeKey)!.items.push(item);
    }

    const reorderedByScope = new Map<string, Array<Extract<SessionListIndexItem, { type: 'session' }>>>();
    for (const [scopeKey, { groupKey, items }] of sessionsByScope.entries()) {
        const keys = orderByGroupKey[groupKey];
        if (!keys || keys.length === 0) continue;
        reorderedByScope.set(scopeKey, reorderSessionItemsByKeys(items, keys));
    }

    if (reorderedByScope.size === 0) {
        return source as SessionListIndexItem[];
    }

    const indicesByScope = new Map<string, number>();
    const out: SessionListIndexItem[] = [];
    let didChange = false;
    for (const item of source) {
        if (item.type !== 'session') {
            out.push(item);
            continue;
        }
        const scopeKey = resolveSessionOrderingScopeKey(item, sectionMode);
        if (!scopeKey) {
            out.push(item);
            continue;
        }
        const replacementList = reorderedByScope.get(scopeKey);
        if (!replacementList) {
            out.push(item);
            continue;
        }
        const index = indicesByScope.get(scopeKey) ?? 0;
        const replacement = replacementList[index] ?? item;
        if (replacement !== item) {
            didChange = true;
        }
        out.push(replacement);
        indicesByScope.set(scopeKey, index + 1);
    }

    return didChange ? out : (source as SessionListIndexItem[]);
}

function applySessionListStructuralGroupOrder(
    source: ReadonlyArray<SessionListIndexItem>,
    orderByGroupKey: Readonly<Record<string, ReadonlyArray<string> | undefined>>,
    folderSortMode: SessionListFolderSortModeV1,
): SessionListIndexItem[] {
    return folderSortMode === 'mixed'
        ? applyMixedChildOrdering(source, orderByGroupKey)
        : applyFoldersFirstStructuralOrdering(source, orderByGroupKey);
}

function applySessionListSessionSiblingOrder(
    source: ReadonlyArray<SessionListIndexItem>,
    orderByGroupKey: Readonly<Record<string, ReadonlyArray<string> | undefined>>,
    sectionMode: SessionListOrderingSectionMode,
): SessionListIndexItem[] {
    return applySessionOnlyGroupOrdering(source, orderByGroupKey, sectionMode);
}

function applySessionListIndexGroupOrdering(
    source: ReadonlyArray<SessionListIndexItem>,
    orderByGroupKey: Readonly<Record<string, ReadonlyArray<string> | undefined>>,
    folderSortMode: SessionListFolderSortModeV1,
    sectionMode: SessionListOrderingSectionMode,
): SessionListIndexItem[] {
    const sessionOrdered = applySessionListSessionSiblingOrder(source, orderByGroupKey, sectionMode);
    return applySessionListStructuralGroupOrder(sessionOrdered, orderByGroupKey, folderSortMode);
}

type VisibleSessionListHeaderState = {
    pendingSectionHeader: Extract<SessionListIndexItem, { type: 'header' }> | null;
    pendingGroupHeaders: Array<Extract<SessionListIndexItem, { type: 'header' }>>;
};

function createVisibleSessionListHeaderState(): VisibleSessionListHeaderState {
    return {
        pendingSectionHeader: null,
        pendingGroupHeaders: [],
    };
}

function pendingHeadersContainFolder(headers: ReadonlyArray<Extract<SessionListIndexItem, { type: 'header' }>>): boolean {
    return headers.some((item) => item.headerKind === 'folder');
}

function flushPendingFolderHeaders(params: Readonly<{
    out: SessionListIndexItem[];
    headerState: VisibleSessionListHeaderState;
}>): boolean {
    if (!pendingHeadersContainFolder(params.headerState.pendingGroupHeaders)) return false;
    if (params.headerState.pendingSectionHeader) {
        params.out.push(params.headerState.pendingSectionHeader);
    }
    params.out.push(...params.headerState.pendingGroupHeaders);
    params.headerState.pendingSectionHeader = null;
    params.headerState.pendingGroupHeaders = [];
    return true;
}

function pruneOrphanHeaders(items: ReadonlyArray<SessionListIndexItem>): SessionListIndexItem[] {
    const out: SessionListIndexItem[] = [];
    const headerState = createVisibleSessionListHeaderState();

    for (const item of items) {
        if (item.type === 'header') {
            flushPendingFolderHeaders({ out, headerState });
            if (isPrimarySessionListSectionHeader(item)) {
                headerState.pendingSectionHeader = item;
                headerState.pendingGroupHeaders = [];
            } else {
                headerState.pendingGroupHeaders.push(item);
            }
            continue;
        }
        if (item.type === 'session') {
            if (headerState.pendingSectionHeader) {
                out.push(headerState.pendingSectionHeader);
                headerState.pendingSectionHeader = null;
            }
            if (headerState.pendingGroupHeaders.length > 0) {
                out.push(...headerState.pendingGroupHeaders);
                headerState.pendingGroupHeaders = [];
            }
            out.push(item);
            continue;
        }
    }

    flushPendingFolderHeaders({ out, headerState });
    return out;
}

function filterHideInactiveSessions(
    items: ReadonlyArray<SessionListIndexItem>,
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
): SessionListIndexItem[] {
    const out: SessionListIndexItem[] = [];
    const headerState = createVisibleSessionListHeaderState();

    for (const item of items) {
        if (item.type === 'header') {
            flushPendingFolderHeaders({ out, headerState });
            if (isPrimarySessionListSectionHeader(item)) {
                headerState.pendingSectionHeader = item;
                headerState.pendingGroupHeaders = [];
            } else {
                headerState.pendingGroupHeaders.push(item);
            }
            continue;
        }
        if (item.type === 'session') {
            const row = resolveSessionRowForItem(item, resolveSessionRow);
            const isActive = item.section === 'active' || row?.active === true;
            const keepVisible = item.keepVisibleWhenInactive === true || row?.keepVisibleWhenInactive === true;
            if (!isActive && !keepVisible) {
                continue;
            }
            if (headerState.pendingSectionHeader) {
                if (headerState.pendingSectionHeader.headerKind !== 'inactive') {
                    out.push(headerState.pendingSectionHeader);
                }
                headerState.pendingSectionHeader = null;
            }
            if (headerState.pendingGroupHeaders.length > 0) {
                out.push(...headerState.pendingGroupHeaders);
                headerState.pendingGroupHeaders = [];
            }
            out.push(item);
        }
    }

    flushPendingFolderHeaders({ out, headerState });
    return out;
}

function applyPinnedSessionListIndexFlags(params: Readonly<{
    ordered: ReadonlyArray<SessionListIndexItem>;
    pinnedSessionKeys: ReadonlyArray<string>;
    trackMissingPinnedSessionKeys: boolean;
}>): Readonly<{
    ordered: SessionListIndexItem[];
    missingPinnedSessionKeys: number;
}> {
    if (params.pinnedSessionKeys.length === 0 || params.ordered.length === 0) {
        return {
            ordered: params.ordered as SessionListIndexItem[],
            missingPinnedSessionKeys: params.trackMissingPinnedSessionKeys ? params.pinnedSessionKeys.length : 0,
        };
    }

    const pinnedSet = new Set(params.pinnedSessionKeys);
    const missingPinnedSet = params.trackMissingPinnedSessionKeys
        ? new Set(params.pinnedSessionKeys)
        : null;
    let changed = false;
    const next = params.ordered.map((item) => {
        if (item.type !== 'session') return item;
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId).sessionKey;
        if (!key || !pinnedSet.has(key)) return item;
        missingPinnedSet?.delete(key);
        if (item.pinned === true && item.variant === 'default') return item;
        changed = true;
        return {
            ...item,
            pinned: true,
            variant: 'default' as const,
        };
    });

    return {
        ordered: changed ? next : params.ordered as SessionListIndexItem[],
        missingPinnedSessionKeys: missingPinnedSet?.size ?? 0,
    };
}

function buildPinnedSessionListIndexItems(params: Readonly<{
    ordered: ReadonlyArray<SessionListIndexItem>;
    pinnedSessionKeys: ReadonlyArray<string>;
}>): Readonly<{
    pinnedSessions: Array<Extract<SessionListIndexItem, { type: 'session' }>>;
    remainder: SessionListIndexItem[];
}> {
    const pinnedSet = new Set(params.pinnedSessionKeys);
    const pinnedSessions: Array<Extract<SessionListIndexItem, { type: 'session' }>> = [];
    const remainder: SessionListIndexItem[] = [];

    for (const item of params.ordered) {
        if (item.type !== 'session') {
            remainder.push(item);
            continue;
        }
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId).sessionKey;
        if (key && pinnedSet.has(key)) {
            pinnedSessions.push({
                ...item,
                pinned: true,
                groupKey: PINNED_GROUP_KEY_V1,
                groupKind: 'pinned',
                variant: 'default',
                attentionPlacementReason: undefined,
                workingPlacementReason: undefined,
            });
            continue;
        }
        remainder.push(item);
    }

    return { pinnedSessions, remainder };
}

type VisibleSessionListProjectionTelemetry = Readonly<{
    missingPinnedSessionKeys: number;
    visiblePlaceholderRows: number;
}>;

type VisibleSessionListTelemetrySink = {
    projectionTelemetry?: VisibleSessionListProjectionTelemetry;
};

function recordSourceProjectionTelemetry(
    telemetrySink: VisibleSessionListTelemetrySink | undefined,
    visiblePlaceholderRows: number,
): void {
    if (!telemetrySink) return;
    telemetrySink.projectionTelemetry = {
        missingPinnedSessionKeys: 0,
        visiblePlaceholderRows,
    };
}

type VisibleSessionListGlobalPlacementPlan = Readonly<{
    attentionPlacement: ReturnType<typeof buildSessionListAttentionPlacement>;
    workingPlacement: ReturnType<typeof buildSessionListWorkingPlacement>;
    remainder: SessionListIndexItem[];
}>;

function buildVisibleSessionListGlobalPlacementPlan(params: Readonly<{
    ordered: ReadonlyArray<SessionListIndexItem>;
    options: ComputeVisibleSessionListIndexParams;
    nowMs: number;
}>): VisibleSessionListGlobalPlacementPlan {
    const globalAttentionSource = pruneOrphanHeaders(params.ordered);
    const attentionPlacement = buildSessionListAttentionPlacement({
        source: globalAttentionSource,
        options: params.options.attentionPlacement,
        resolveSessionRow: params.options.resolveSessionRow,
        nowMs: params.nowMs,
    });
    const orderedWithoutGlobalAttention = attentionPlacement
        ? pruneOrphanHeaders(attentionPlacement.remainder)
        : globalAttentionSource;
    const workingPlacement = buildSessionListWorkingPlacement({
        source: pruneOrphanHeaders(orderedWithoutGlobalAttention),
        options: params.options.workingPlacement,
        resolveSessionRow: params.options.resolveSessionRow,
        nowMs: params.nowMs,
    });

    return {
        attentionPlacement,
        workingPlacement,
        remainder: workingPlacement
            ? pruneOrphanHeaders(workingPlacement.remainder)
            : orderedWithoutGlobalAttention,
    };
}

function applyVisibleSessionListWithinGroupPlacement(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    options: ComputeVisibleSessionListIndexParams;
    nowMs: number;
    attentionPlacement: ReturnType<typeof buildSessionListAttentionPlacement>;
    workingPlacement: ReturnType<typeof buildSessionListWorkingPlacement>;
}>): SessionListIndexItem[] {
    const remainderPruned = pruneOrphanHeaders(params.source);
    const remainderAfterWorking = params.workingPlacement
        ? remainderPruned
        : applySessionListWorkingPlacementWithinGroups({
            source: remainderPruned,
            options: params.options.workingPlacement,
            resolveSessionRow: params.options.resolveSessionRow,
            nowMs: params.nowMs,
        });
    const remainderAfterAttention = params.attentionPlacement
        ? remainderAfterWorking
        : applySessionListAttentionPlacementWithinGroups({
            source: remainderAfterWorking,
            options: params.options.attentionPlacement,
            resolveSessionRow: params.options.resolveSessionRow,
            nowMs: params.nowMs,
        });
    return params.attentionPlacement || params.workingPlacement
        ? pruneOrphanHeaders(remainderAfterAttention)
        : remainderAfterAttention;
}

function computeVisibleSessionListIndexUnmeasured(
    params: ComputeVisibleSessionListIndexParams,
    telemetrySink?: VisibleSessionListTelemetrySink,
): SessionListIndexItem[] | null {
    const source = params.source;
    if (!source) return null;

    const sessionListOrderingModeV1 = normalizeSessionListOrderingModeV1(params.sessionListOrderingModeV1);
    const sessionListSectionModeV1: SessionListOrderingSectionMode = params.sessionListSectionModeV1 === 'single'
        ? 'single'
        : 'activity';
    const sessionListFolderSortModeV1 = resolveEffectiveSessionListFolderSortMode({
        orderingMode: sessionListOrderingModeV1,
        folderSortMode: normalizeSessionListFolderSortModeV1(params.sessionListFolderSortModeV1),
    });
    const pinnedSessionKeys = normalizeTrimmedStringArrayWithSharedEmpty(params.pinnedSessionKeysV1);
    const presentationEnabled = params.presentation.enabled === true;
    const attentionPlacementMode = normalizeSessionListAttentionPlacementMode(params.attentionPlacement?.mode);
    const attentionPlacementEnabled = attentionPlacementMode !== 'off';
    const workingPlacementMode = normalizeSessionListWorkingPlacementMode(params.workingPlacement?.mode);
    const workingPlacementEnabled = workingPlacementMode !== 'off';
    const placementNowMs = params.nowMs ?? Date.now();
    const noOrderingOverrides = !Object.values(params.sessionListGroupOrderV1 ?? {}).some(
        (keys) => Array.isArray(keys) && keys.length > 0,
    ) && !Object.values(params.sessionWorkspaceOrderV1 ?? {}).some(
        (keys) => Array.isArray(keys) && keys.length > 0,
    );
    const sourceState = inspectVisibleSessionListSourceState(source, params.resolveSessionRow);
    const hasNonCustomSessionOrdering = hasNonCustomEffectiveSessionOrdering(source, sessionListOrderingModeV1, sessionListSectionModeV1);

    if (
        sessionListOrderingModeV1 === 'custom'
        && !params.hideInactiveSessions
        && pinnedSessionKeys.length === 0
        && !attentionPlacementEnabled
        && !workingPlacementEnabled
        && !presentationEnabled
        && noOrderingOverrides
        && !sourceState.hasArchivedSessionItems
        && !sourceState.hasMissingSessionRows
        && !sourceState.hasOrphanHeaders
        && !hasNonCustomSessionOrdering
    ) {
        recordSourceProjectionTelemetry(telemetrySink, sourceState.visiblePlaceholderRows);
        return source as SessionListIndexItem[];
    }

    const orderedByWorkspace = applySessionWorkspaceOrderV1ToIndex(source, params.sessionWorkspaceOrderV1 ?? {});
    const orderedByGroup =
        sessionListOrderingModeV1 === 'custom'
            ? applySessionListIndexGroupOrdering(orderedByWorkspace, params.sessionListGroupOrderV1 ?? {}, sessionListFolderSortModeV1, sessionListSectionModeV1)
            : applySessionListStructuralGroupOrder(orderedByWorkspace, params.sessionListGroupOrderV1 ?? {}, sessionListFolderSortModeV1);
    if (
        sessionListOrderingModeV1 === 'custom'
        && orderedByGroup === source
        && !params.hideInactiveSessions
        && pinnedSessionKeys.length === 0
        && !attentionPlacementEnabled
        && !workingPlacementEnabled
        && !presentationEnabled
        && !sourceState.hasArchivedSessionItems
        && !sourceState.hasMissingSessionRows
        && !sourceState.hasOrphanHeaders
        && !hasNonCustomSessionOrdering
    ) {
        recordSourceProjectionTelemetry(telemetrySink, sourceState.visiblePlaceholderRows);
        return source as SessionListIndexItem[];
    }

    const ordered = sortSessionListIndexItemsByOrderingMode(
        orderedByGroup,
        sessionListOrderingModeV1,
        sessionListSectionModeV1,
        params.resolveSessionRow,
    );
    if (
        sessionListOrderingModeV1 !== 'custom'
        && ordered === source
        && !params.hideInactiveSessions
        && pinnedSessionKeys.length === 0
        && !attentionPlacementEnabled
        && !workingPlacementEnabled
        && !presentationEnabled
        && !sourceState.hasArchivedSessionItems
        && !sourceState.hasMissingSessionRows
        && !sourceState.hasOrphanHeaders
    ) {
        recordSourceProjectionTelemetry(telemetrySink, sourceState.visiblePlaceholderRows);
        return source as SessionListIndexItem[];
    }

    if (
        sessionListOrderingModeV1 === 'custom'
        && params.hideInactiveSessions
        && pinnedSessionKeys.length === 0
        && !attentionPlacementEnabled
        && !workingPlacementEnabled
        && !presentationEnabled
        && noOrderingOverrides
        && !sourceState.hasArchivedSessionItems
        && !sourceState.hasMissingSessionRows
        && !sourceState.hasOrphanHeaders
        && !sourceState.hasInactiveSessionsThatNeedFiltering
        && !hasNonCustomSessionOrdering
    ) {
        recordSourceProjectionTelemetry(telemetrySink, sourceState.visiblePlaceholderRows);
        return source as SessionListIndexItem[];
    }

    const orderedWithoutArchived = ordered.filter((item) => {
        if (!item || item.type !== 'session') return true;
        const row = resolveSessionRowForItem(item, params.resolveSessionRow);
        return row != null && row.archivedAt == null;
    });

    const {
        ordered: orderedWithPinnedFlags,
        missingPinnedSessionKeys,
    } = applyPinnedSessionListIndexFlags({
        ordered: orderedWithoutArchived,
        pinnedSessionKeys,
        trackMissingPinnedSessionKeys: telemetrySink != null,
    });

    const globalPlacement = buildVisibleSessionListGlobalPlacementPlan({
        ordered: orderedWithPinnedFlags,
        options: params,
        nowMs: placementNowMs,
    });
    const { attentionPlacement, workingPlacement } = globalPlacement;

    const { pinnedSessions, remainder: nonPinnedRemainder } = buildPinnedSessionListIndexItems({
        ordered: globalPlacement.remainder,
        pinnedSessionKeys,
    });

    const pinnedHeader: Extract<SessionListIndexItem, { type: 'header' }> | null =
        pinnedSessions.length > 0
            ? { type: 'header', title: 'Pinned', headerKind: 'pinned', groupKey: PINNED_GROUP_KEY_V1 }
            : null;

    const pinnedOrdered = orderPinnedSessionItems({
        items: pinnedSessions,
        structuralKeys: params.sessionListGroupOrderV1?.[PINNED_GROUP_KEY_V1],
        fallbackKeys: pinnedSessionKeys,
        orderingMode: sessionListOrderingModeV1,
        resolveSessionRow: params.resolveSessionRow,
    });

    const remainderAfterAttentionPruned = applyVisibleSessionListWithinGroupPlacement({
        source: nonPinnedRemainder,
        options: params,
        nowMs: placementNowMs,
        attentionPlacement,
        workingPlacement,
    });
    const remainderFiltered = params.hideInactiveSessions
        ? filterHideInactiveSessions(remainderAfterAttentionPruned, params.resolveSessionRow)
        : remainderAfterAttentionPruned;

    const remainderPresented = applySessionListIndexPresentation(remainderFiltered, {
        enabled: params.presentation.enabled,
        presentation: params.presentation.presentation,
        selectedServerIds: params.presentation.selectedServerIds,
    });

    // Placed rows left the remainder before it was filtered, so the same
    // hide-inactive filter has to run over the placed band too. Every earned
    // attention reason stamps `keepVisibleWhenInactive` and passes through
    // untouched; only a row standing purely by the account default is hidden
    // here, like any other inactive row.
    const attentionItems = attentionPlacement
        ? (params.hideInactiveSessions
            ? filterHideInactiveSessions(attentionPlacement.attentionItems, params.resolveSessionRow)
            : attentionPlacement.attentionItems)
        : [];

    const result = [
        ...attentionItems,
        ...(workingPlacement ? workingPlacement.workingItems : []),
        ...(pinnedHeader ? [pinnedHeader, ...pinnedOrdered] : []),
        ...remainderPresented,
    ];
    if (telemetrySink) {
        telemetrySink.projectionTelemetry = {
            missingPinnedSessionKeys,
            visiblePlaceholderRows: countVisiblePlaceholderRows({
                result,
                resolveSessionRow: params.resolveSessionRow,
            }),
        };
    }
    return result;
}

export function computeVisibleSessionListIndex(
    params: ComputeVisibleSessionListIndexParams,
): SessionListIndexItem[] | null {
    const source = params.source;
    if (!source) return null;
    if (!syncPerformanceTelemetry.isEnabled()) {
        return computeVisibleSessionListIndexUnmeasured(params);
    }

    const startedAtMs = nowMs();
    const telemetrySink: VisibleSessionListTelemetrySink = {};
    const result = computeVisibleSessionListIndexUnmeasured(params, telemetrySink);
    const sessionCount = countSessionItems(source);
    const projectionTelemetry = telemetrySink.projectionTelemetry ?? {
        missingPinnedSessionKeys: 0,
        visiblePlaceholderRows: 0,
    };
    syncPerformanceTelemetry.recordDuration(
        'sync.sessions.list.visible.compute',
        nowMs() - startedAtMs,
        {
            items: source.length,
            sessions: sessionCount,
            headers: source.length - sessionCount,
            fastPath: result === source ? 1 : 0,
            hideInactive: params.hideInactiveSessions === true ? 1 : 0,
            pins: countPinnedSessionKeys(params.pinnedSessionKeysV1),
            missingPinnedSessionKeys: projectionTelemetry.missingPinnedSessionKeys,
            visiblePlaceholderRows: projectionTelemetry.visiblePlaceholderRows,
            customOrder: countOrderedGroups(params.sessionListGroupOrderV1),
            attentionPlacementEnabled: normalizeSessionListAttentionPlacementMode(params.attentionPlacement?.mode) === 'off' ? 0 : 1,
            attentionPlacementGlobal: normalizeSessionListAttentionPlacementMode(params.attentionPlacement?.mode) === 'global' ? 1 : 0,
            attentionPlacementWithinGroups: normalizeSessionListAttentionPlacementMode(params.attentionPlacement?.mode) === 'withinGroups' ? 1 : 0,
            workingPlacementEnabled: normalizeSessionListWorkingPlacementMode(params.workingPlacement?.mode) === 'off' ? 0 : 1,
            workingPlacementGlobal: normalizeSessionListWorkingPlacementMode(params.workingPlacement?.mode) === 'global' ? 1 : 0,
            workingPlacementWithinGroups: normalizeSessionListWorkingPlacementMode(params.workingPlacement?.mode) === 'withinGroups' ? 1 : 0,
            presentationEnabled: params.presentation.enabled === true ? 1 : 0,
            storageFilter: params.storageFilterApplied === true ? 1 : 0,
        },
    );
    return result;
}
