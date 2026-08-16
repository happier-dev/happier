import {
    buildSessionListIndexNodeId,
    buildSessionListViewItemNodeId,
    type SessionListIndexItem,
} from './sessionListIndex';
import type { SessionListViewItem } from './sessionListViewData';

export type BuildSessionListViewDataFromIndexParams = Readonly<{
    index: ReadonlyArray<SessionListIndexItem> | null;
    source: ReadonlyArray<SessionListViewItem> | null;
    sourceIndex: ReadonlyArray<SessionListIndexItem> | null;
    /**
     * The view data this build replaces, when the caller keeps one.
     *
     * A row is a pure function of its index item and its source row, but a projected row
     * (one whose placement differs from the source row's) is rebuilt from a spread and so
     * gets a fresh identity on every push — including the ~0.5/s pushes that change a
     * single session. Handing back the previous row object whenever the rebuilt row is
     * field-identical keeps identity where the inputs did not change, so consumers reuse
     * instead of rediscovering equality row by row.
     */
    previous?: ReadonlyArray<SessionListViewItem> | null;
}>;

function buildSourceItemsByIndexNodeId(params: BuildSessionListViewDataFromIndexParams): Map<string, SessionListViewItem> {
    const byNodeId = new Map<string, SessionListViewItem>();
    const source = params.source ?? [];
    const sourceIndex = params.sourceIndex ?? [];
    const length = Math.min(source.length, sourceIndex.length);
    for (let index = 0; index < length; index += 1) {
        const sourceItem = source[index];
        const indexItem = sourceIndex[index];
        if (!sourceItem || !indexItem) continue;
        byNodeId.set(buildSessionListIndexNodeId(indexItem), sourceItem);
    }
    return byNodeId;
}

function areNullableValuesEqual<T>(left: T | null | undefined, right: T | null | undefined): boolean {
    return (left ?? null) === (right ?? null);
}

function canReuseHeader(
    item: Extract<SessionListIndexItem, { type: 'header' }>,
    sourceHeader: Extract<SessionListViewItem, { type: 'header' }>,
): boolean {
    return sourceHeader.title === item.title
        && areNullableValuesEqual(sourceHeader.headerKind, item.headerKind)
        && areNullableValuesEqual(sourceHeader.groupKey, item.groupKey)
        && areNullableValuesEqual(sourceHeader.workspaceKey, item.workspaceKey)
        && areNullableValuesEqual(sourceHeader.workspace, item.workspace)
        && areNullableValuesEqual(sourceHeader.folderId, item.folderId)
        && areNullableValuesEqual(sourceHeader.depth, item.folderDepth)
        && areNullableValuesEqual(sourceHeader.workspaceScopeHint, item.workspaceScopeHint)
        && areNullableValuesEqual(sourceHeader.seedSessionId, item.seedSessionId)
        && areNullableValuesEqual(sourceHeader.serverId, item.serverId)
        && areNullableValuesEqual(sourceHeader.serverName, item.serverName)
        && areNullableValuesEqual(sourceHeader.subtitle, item.subtitle)
        && areNullableValuesEqual(sourceHeader.machine, item.machine);
}

function rehydrateHeader(
    item: Extract<SessionListIndexItem, { type: 'header' }>,
    sourceItem: SessionListViewItem | null | undefined,
): Extract<SessionListViewItem, { type: 'header' }> {
    const sourceHeader = sourceItem?.type === 'header' ? sourceItem : null;
    if (sourceHeader && canReuseHeader(item, sourceHeader)) {
        return sourceHeader;
    }
    return {
        ...(sourceHeader ?? { type: 'header' as const, title: item.title }),
        title: item.title,
        headerKind: item.headerKind,
        groupKey: item.groupKey,
        workspaceKey: item.workspaceKey,
        workspace: item.workspace,
        folderId: item.folderId,
        depth: item.folderDepth,
        workspaceScopeHint: item.workspaceScopeHint,
        seedSessionId: item.seedSessionId,
        serverId: item.serverId,
        serverName: item.serverName,
        subtitle: item.subtitle,
        machine: item.machine,
    };
}

function canReuseSession(
    item: Extract<SessionListIndexItem, { type: 'session' }>,
    sourceSession: Extract<SessionListViewItem, { type: 'session' }>,
): boolean {
    const keepVisibleWhenInactive = item.keepVisibleWhenInactive === true;
    return (sourceSession.session.keepVisibleWhenInactive === true) === keepVisibleWhenInactive
        && areNullableValuesEqual(sourceSession.section, item.section)
        && areNullableValuesEqual(sourceSession.groupKey, item.groupKey)
        && areNullableValuesEqual(sourceSession.groupKind, item.groupKind)
        && areNullableValuesEqual(sourceSession.folderId, item.folderId)
        && areNullableValuesEqual(sourceSession.folderDepth, item.folderDepth)
        && (sourceSession.pinned === true) === (item.pinned === true)
        && areNullableValuesEqual(sourceSession.attentionPromotionReason, item.attentionPromotionReason)
        && areNullableValuesEqual(sourceSession.workingPlacementReason, item.workingPlacementReason)
        && areNullableValuesEqual(sourceSession.variant, item.variant)
        && areNullableValuesEqual(sourceSession.serverId, item.serverId)
        && areNullableValuesEqual(sourceSession.serverName, item.serverName)
        && areNullableValuesEqual(sourceSession.workspace, item.workspace);
}

function rehydrateSession(
    item: Extract<SessionListIndexItem, { type: 'session' }>,
    sourceItem: SessionListViewItem | null | undefined,
): Extract<SessionListViewItem, { type: 'session' }> | null {
    if (sourceItem?.type !== 'session') return null;
    if (canReuseSession(item, sourceItem)) {
        return sourceItem;
    }
    const keepVisibleWhenInactive = item.keepVisibleWhenInactive === true;
    const session = (sourceItem.session.keepVisibleWhenInactive === true) === keepVisibleWhenInactive
        ? sourceItem.session
        : {
            ...sourceItem.session,
            keepVisibleWhenInactive,
        };
    return {
        ...sourceItem,
        session,
        section: item.section,
        groupKey: item.groupKey,
        groupKind: item.groupKind,
        folderId: item.folderId,
        folderDepth: item.folderDepth,
        pinned: item.pinned,
        attentionPromotionReason: item.attentionPromotionReason,
        workingPlacementReason: item.workingPlacementReason,
        variant: item.variant,
        serverId: item.serverId,
        serverName: item.serverName,
        workspace: item.workspace,
    };
}

/**
 * Every declared field of a header row. A rebuilt header may reuse its source row's
 * fields wholesale (`sessionCount`, `parentFolderId`, `renderWorkspaceKey` are carried,
 * not projected), so previous-row reuse compares the whole row rather than the subset
 * the index owns.
 */
function areHeaderRowsEquivalent(
    previous: Extract<SessionListViewItem, { type: 'header' }>,
    next: Extract<SessionListViewItem, { type: 'header' }>,
): boolean {
    if (previous === next) return true;
    return previous.title === next.title
        && areNullableValuesEqual(previous.headerKind, next.headerKind)
        && areNullableValuesEqual(previous.groupKey, next.groupKey)
        && areNullableValuesEqual(previous.workspaceKey, next.workspaceKey)
        && areNullableValuesEqual(previous.workspace, next.workspace)
        && areNullableValuesEqual(previous.renderWorkspaceKey, next.renderWorkspaceKey)
        && areNullableValuesEqual(previous.folderId, next.folderId)
        && areNullableValuesEqual(previous.parentFolderId, next.parentFolderId)
        && areNullableValuesEqual(previous.depth, next.depth)
        && areNullableValuesEqual(previous.sessionCount, next.sessionCount)
        && areNullableValuesEqual(previous.workspaceScopeHint, next.workspaceScopeHint)
        && areNullableValuesEqual(previous.seedSessionId, next.seedSessionId)
        && areNullableValuesEqual(previous.serverId, next.serverId)
        && areNullableValuesEqual(previous.serverName, next.serverName)
        && areNullableValuesEqual(previous.subtitle, next.subtitle)
        && areNullableValuesEqual(previous.machine, next.machine);
}

/**
 * Every declared field of a session row. The session payload is compared by identity
 * because the store preserves the renderable of a session it did not change; a session
 * that did change arrives as a new object and correctly defeats reuse here.
 */
function areSessionRowsEquivalent(
    previous: Extract<SessionListViewItem, { type: 'session' }>,
    next: Extract<SessionListViewItem, { type: 'session' }>,
): boolean {
    if (previous === next) return true;
    return previous.session === next.session
        && areNullableValuesEqual(previous.section, next.section)
        && areNullableValuesEqual(previous.groupKey, next.groupKey)
        && areNullableValuesEqual(previous.groupKind, next.groupKind)
        && areNullableValuesEqual(previous.folderId, next.folderId)
        && areNullableValuesEqual(previous.folderDepth, next.folderDepth)
        && (previous.pinned === true) === (next.pinned === true)
        && areNullableValuesEqual(previous.attentionPromotionReason, next.attentionPromotionReason)
        && areNullableValuesEqual(previous.workingPlacementReason, next.workingPlacementReason)
        && areNullableValuesEqual(previous.variant, next.variant)
        && areNullableValuesEqual(previous.serverId, next.serverId)
        && areNullableValuesEqual(previous.serverName, next.serverName)
        && areNullableValuesEqual(previous.workspace, next.workspace);
}

function buildPreviousItemsByNodeId(
    previous: ReadonlyArray<SessionListViewItem> | null | undefined,
): Map<string, SessionListViewItem> | null {
    if (!previous || previous.length === 0) return null;
    const byNodeId = new Map<string, SessionListViewItem>();
    for (const item of previous) {
        byNodeId.set(buildSessionListViewItemNodeId(item), item);
    }
    return byNodeId;
}

function reuseHeaderRow(
    previousItem: SessionListViewItem | undefined,
    header: Extract<SessionListViewItem, { type: 'header' }>,
): Extract<SessionListViewItem, { type: 'header' }> {
    if (previousItem?.type !== 'header') return header;
    return areHeaderRowsEquivalent(previousItem, header) ? previousItem : header;
}

function reuseSessionRow(
    previousItem: SessionListViewItem | undefined,
    session: Extract<SessionListViewItem, { type: 'session' }>,
): Extract<SessionListViewItem, { type: 'session' }> {
    if (previousItem?.type !== 'session') return session;
    return areSessionRowsEquivalent(previousItem, session) ? previousItem : session;
}

function hasSameSessionListViewItems(
    previous: ReadonlyArray<SessionListViewItem>,
    next: ReadonlyArray<SessionListViewItem>,
): boolean {
    if (previous.length !== next.length) return false;
    for (let index = 0; index < next.length; index += 1) {
        if (previous[index] !== next[index]) return false;
    }
    return true;
}

export function buildSessionListViewDataFromIndex(
    params: BuildSessionListViewDataFromIndexParams,
): SessionListViewItem[] | null {
    if (!params.index) return null;
    if (params.index === params.sourceIndex && params.source) {
        return params.source as SessionListViewItem[];
    }

    const sourceItemsByNodeId = buildSourceItemsByIndexNodeId(params);
    const previousItemsByNodeId = buildPreviousItemsByNodeId(params.previous);
    const out: SessionListViewItem[] = [];
    for (const item of params.index) {
        const nodeId = buildSessionListIndexNodeId(item);
        const sourceItem = sourceItemsByNodeId.get(nodeId);
        const previousItem = previousItemsByNodeId?.get(nodeId);
        if (item.type === 'header') {
            out.push(reuseHeaderRow(previousItem, rehydrateHeader(item, sourceItem)));
            continue;
        }
        const session = rehydrateSession(item, sourceItem);
        if (session) out.push(reuseSessionRow(previousItem, session));
    }
    if (params.previous && hasSameSessionListViewItems(params.previous, out)) {
        return params.previous as SessionListViewItem[];
    }
    return out;
}
