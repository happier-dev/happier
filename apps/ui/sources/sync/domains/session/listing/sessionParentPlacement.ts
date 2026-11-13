import type { SessionOrganizationSessionAppearance } from '@happier-dev/protocol';
import type { SessionOrganizationSessionAppearancePresentation } from '@happier-dev/protocol';
import { readSessionOriginV1 } from '@happier-dev/protocol';
import { buildSessionOrganizationServerKey } from '../organization/keys';
import { readEffectiveSessionAppearancePresentation, readEffectiveSessionParentPlacement } from '../organization/sessionAppearance';
import type { SessionListViewItem } from './sessionListViewData';

type SessionRow = Extract<SessionListViewItem, { type: 'session' }>;
type Appearances = Readonly<Record<string, SessionOrganizationSessionAppearance | undefined>>;
type AppearancePresentations = Readonly<Record<string, SessionOrganizationSessionAppearancePresentation | undefined>>;
const EMPTY_APPEARANCES: Appearances = Object.freeze({});
const EMPTY_APPEARANCE_PRESENTATIONS: AppearancePresentations = Object.freeze({});
const rows = new WeakMap<SessionRow, { signature: string; row: SessionRow }>();

export function sessionChildrenCollapseKey(serverId: string, sessionId: string): string {
    return `sessionChildren:${buildSessionOrganizationServerKey(serverId, sessionId)}`;
}

function rowKey(row: SessionRow): string {
    return buildSessionOrganizationServerKey(row.serverId ?? '', row.session.id);
}

export function createCanPlaceSessionUnderParent(params: Readonly<{
    items: readonly SessionListViewItem[]; appearances: Appearances;
    appearancePresentations?: AppearancePresentations;
    serverId: string; sessionId: string;
}>): (parentSessionId: string) => boolean {
    const sessions = new Map(params.items.filter((row): row is SessionRow => row.type === 'session'
        && row.serverId === params.serverId && row.session.archivedAt == null).map(row => [row.session.id, row]));
    return parentSessionId => {
        if (!sessions.has(params.sessionId) || !sessions.has(parentSessionId)) return false;
        const seen = new Set([params.sessionId]);
        let cursor: string | null = parentSessionId;
        while (cursor) {
            if (seen.has(cursor)) return false;
            seen.add(cursor);
            const row = sessions.get(cursor);
            cursor = row ? resolveSessionParentId(row, params.appearances, params.appearancePresentations) : null;
        }
        return true;
    };
}

/** One parent decision for automatic and explicit placement. An invalid explicit choice never falls back to a different parent. */
export function resolveSessionParentId(
    row: SessionRow,
    appearances: Appearances,
    appearancePresentations: AppearancePresentations = EMPTY_APPEARANCE_PRESENTATIONS,
    organizationFolderAssigned = false,
): string | null {
    if (!row.serverId || row.session.archivedAt != null) return null;
    const key = rowKey(row);
    const placement = readEffectiveSessionParentPlacement(
        appearances[key]?.display,
        appearancePresentations[key]?.presentation,
    );
    if (placement) return placement.kind === 'session' ? placement.parentSessionId : null;
    if (row.pinned || row.groupKind === 'pinned' || row.folderId || organizationFolderAssigned) return null;
    return readSessionOriginV1(row.session.metadata)?.creatorSessionId ?? null;
}

/** Run after pin/folder placement and filtering, so an unavailable parent cannot hide a child. */
export type SessionParentPlacementProjection = Readonly<{
    items: SessionListViewItem[];
    descendantsByParentKey: ReadonlyMap<string, readonly SessionRow[]>;
}>;

export function buildSessionParentPlacementProjection(
    source: readonly SessionListViewItem[],
    appearances: Appearances = EMPTY_APPEARANCES,
    collapsed: Readonly<Record<string, boolean>> = {},
    folderAssignments: Readonly<Record<string, string | null | undefined>> = {},
    appearancePresentations: AppearancePresentations = EMPTY_APPEARANCE_PRESENTATIONS,
): SessionParentPlacementProjection {
    const sessions = new Map<string, SessionRow>();
    for (const row of source) if (row.type === 'session') sessions.set(rowKey(row), row);
    const parents = new Map<string, string>();
    for (const [key, row] of sessions) {
        const parentId = resolveSessionParentId(
            row,
            appearances,
            appearancePresentations,
            Boolean(folderAssignments[key]),
        );
        if (!parentId || parentId === row.session.id) continue;
        const parentKey = buildSessionOrganizationServerKey(row.serverId!, parentId);
        const parent = sessions.get(parentKey);
        if (parent && parent.session.archivedAt == null) parents.set(key, parentKey);
    }
    // Break every edge in a cycle, not whichever edge happens to be visited first.
    const checked = new Set<string>();
    for (const key of parents.keys()) {
        const chain: string[] = [];
        const positions = new Map<string, number>();
        let cursor: string | undefined = key;
        while (cursor && !checked.has(cursor)) {
            const cycleAt = positions.get(cursor);
            if (cycleAt !== undefined) {
                for (const member of chain.slice(cycleAt)) parents.delete(member);
                break;
            }
            positions.set(cursor, chain.length);
            chain.push(cursor);
            cursor = parents.get(cursor);
        }
        for (const member of chain) checked.add(member);
    }
    const children = new Map<string, string[]>();
    for (const [key, parent] of parents) {
        const list = children.get(parent) ?? [];
        list.push(key);
        children.set(parent, list);
    }
    const descendantsByParentKey = new Map<string, readonly SessionRow[]>();
    const collectDescendants = (parentKey: string): readonly SessionRow[] => {
        const existing = descendantsByParentKey.get(parentKey);
        if (existing) return existing;
        const descendants: SessionRow[] = [];
        for (const childKey of children.get(parentKey) ?? []) {
            descendants.push(...collectDescendants(childKey), sessions.get(childKey)!);
        }
        descendantsByParentKey.set(parentKey, descendants);
        return descendants;
    };
    for (const parentKey of children.keys()) collectDescendants(parentKey);
    const result: SessionListViewItem[] = [];
    for (const item of source) {
        if (item.type === 'header') { result.push(item); continue; }
        if (parents.has(rowKey(item))) continue;
        const pending = [{ key: rowKey(item), depth: 0 }];
        while (pending.length) {
            const entry = pending.pop()!;
            const row = sessions.get(entry.key)!;
            const parent = parents.get(entry.key);
            const childKeys = children.get(entry.key) ?? [];
            const isCollapsed = childKeys.length > 0 && collapsed[sessionChildrenCollapseKey(row.serverId ?? '', row.session.id)] === true;
            const identity = readEffectiveSessionAppearancePresentation(
                appearances[entry.key]?.display,
                appearancePresentations[entry.key]?.presentation,
            ).identity === 'independent' ? 'independent' as const : undefined;
            const parentId = parent ? sessions.get(parent)!.session.id : undefined;
            const signature = JSON.stringify([parentId, entry.depth, childKeys.length > 0, isCollapsed, identity]);
            const cached = rows.get(row);
            const unchanged = row.parentSessionId === parentId && (row.nestingDepth ?? 0) === entry.depth
                && Boolean(row.hasChildren) === (childKeys.length > 0) && Boolean(row.childrenCollapsed) === isCollapsed && row.identityOverride === identity;
            const projected = unchanged ? row : cached?.signature === signature ? cached.row : {
                ...row, parentSessionId: parentId, nestingDepth: entry.depth,
                hasChildren: childKeys.length > 0, childrenCollapsed: isCollapsed, identityOverride: identity,
            };
            if (projected !== row) rows.set(row, { signature, row: projected });
            result.push(projected);
            if (!isCollapsed) for (let i = childKeys.length - 1; i >= 0; i--) pending.push({ key: childKeys[i], depth: entry.depth + 1 });
        }
    }
    // Moving a child across projects must not leave its now-empty project heading behind.
    function headersWithSessions(items: readonly SessionListViewItem[]) {
        const used = new Set<SessionListViewItem>();
        const headers: Array<{ row: SessionListViewItem; level: number }> = [];
        for (const row of items) {
            if (row.type === 'session') { for (const header of headers) used.add(header.row); continue; }
            const level = row.headerKind === 'folder' ? 2 + (row.depth ?? 0) : row.headerKind === 'project' ? 1 : 0;
            while (headers.length && headers[headers.length - 1].level >= level) headers.pop();
            headers.push({ row, level });
        }
        return used;
    }
    const previouslyUsed = headersWithSessions(source);
    const usedHeaders = headersWithSessions(result);
    const visible = result.filter(row => row.type === 'session' || !previouslyUsed.has(row) || usedHeaders.has(row));
    return {
        items: visible.length === source.length && visible.every((row, index) => row === source[index])
            ? source as SessionListViewItem[]
            : visible,
        descendantsByParentKey,
    };
}

/** Run after pin/folder placement and filtering, so an unavailable parent cannot hide a child. */
export function applySessionParentPlacementToSessionListViewData(
    source: readonly SessionListViewItem[],
    appearances: Appearances = EMPTY_APPEARANCES,
    collapsed: Readonly<Record<string, boolean>> = {},
    folderAssignments: Readonly<Record<string, string | null | undefined>> = {},
    appearancePresentations: AppearancePresentations = EMPTY_APPEARANCE_PRESENTATIONS,
): SessionListViewItem[] {
    return buildSessionParentPlacementProjection(
        source,
        appearances,
        collapsed,
        folderAssignments,
        appearancePresentations,
    ).items;
}
