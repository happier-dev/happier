import { buildSessionListIndexNodeId, type SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import { isSessionListPrimaryHeaderKind } from './sessionListPrimaryHeader';

export function filterCollapsedSessionListItems(
    items: ReadonlyArray<SessionListIndexItem>,
    collapsedGroupKeysV1: Readonly<Record<string, boolean> | null | undefined>,
): SessionListIndexItem[] {
    if (items.length === 0) {
        return items as SessionListIndexItem[];
    }

    const keys = collapsedGroupKeysV1 ?? {};

    let result: SessionListIndexItem[] | undefined;
    let skipUntilNextSection = false;
    let collapsedReportsDepth: number | null = null;

    const ensureResult = (index: number): SessionListIndexItem[] => {
        if (result !== undefined) return result;
        result = items.slice(0, index) as SessionListIndexItem[];
        return result;
    };

    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item.type === 'header') {
            collapsedReportsDepth = null;
            const kind = item.headerKind;
            // A collapsed section owns everything down to the next primary section
            // header. That set is the canonical one — Needs attention, Working,
            // Pinned, Active, Inactive and the one-section Sessions header — because
            // Projects and Recent activity never emit Active/Inactive, so a narrower
            // set would let a collapsed Pinned group swallow the whole corpus.
            const isSection = isSessionListPrimaryHeaderKind(kind);

            if (isSection) {
                skipUntilNextSection = false;
                const collapseKey = item.groupKey || `${kind}:${item.serverId ?? 'local'}`;
                if (keys[collapseKey]) {
                    const filteredItems = ensureResult(index);
                    filteredItems.push(item);
                    skipUntilNextSection = true;
                } else if (result !== undefined) {
                    result.push(item);
                }
                continue;
            }

            if (skipUntilNextSection) {
                ensureResult(index);
                continue;
            }
            if (result !== undefined) result.push(item);
            continue;
        }

        if (skipUntilNextSection) {
            ensureResult(index);
            continue;
        }
        const groupKey = item.groupKey ?? '';
        if (groupKey && keys[groupKey]) {
            ensureResult(index);
            continue;
        }
        const depth = item.reportsDepth ?? 0;
        if (collapsedReportsDepth !== null) {
            if (depth > collapsedReportsDepth) {
                ensureResult(index);
                continue;
            }
            collapsedReportsDepth = null;
        }
        // The same local map owns group and per-parent choices. A Bot's reports
        // start folded (projection default) behind the row's Sessions disclosure;
        // an explicit local choice either way wins.
        const localChoice = keys[buildSessionListIndexNodeId(item)];
        const collapsed = item.type === 'session' && localChoice === undefined
            ? item.reportsDefaultCollapsed === true
            : localChoice === true;
        if (collapsed) collapsedReportsDepth = depth;
        if (item.type === 'session' && item.reportsParent === true && collapsed !== (item.reportsCollapsed === true)) {
            const { reportsCollapsed: _previous, ...rest } = item;
            ensureResult(index).push(collapsed ? { ...rest, reportsCollapsed: true } : rest);
            continue;
        }
        if (result !== undefined) result.push(item);
    }

    return result ?? (items as SessionListIndexItem[]);
}
