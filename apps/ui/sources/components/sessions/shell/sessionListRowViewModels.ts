import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { resolveSessionListSecondaryLineMode } from '@/sync/domains/session/listing/deriveSessionListActivity';

import { getTagsForSession } from './sessionTagUtils';

type SessionReachableDisplay = Readonly<{
    machineId: string | null;
    machineLabel: string;
    pathSubtitle: string;
}>;

export type SessionListRowViewModel = Readonly<{
    groupKey: string;
    sessionKey: string | null;
    isFirst: boolean;
    isLast: boolean;
    isSingle: boolean;
    subtitleOverride: string | null;
    pinned: boolean;
    showServerBadge: boolean;
    selected: boolean;
    tags: string[];
    secondaryLineMode: ReturnType<typeof resolveSessionListSecondaryLineMode>;
}>;

const EMPTY_SESSION_LIST_ROW_VIEW_MODELS: ReadonlyArray<SessionListRowViewModel | null> = [];
const SESSION_LIST_ROW_VIEW_MODELS_CACHE = new Map<string, ReadonlyArray<SessionListRowViewModel | null>>();

export function buildSessionListRowViewModels(input: Readonly<{
    listItems: ReadonlyArray<SessionListViewItem>;
    reachableSessionDisplayById: ReadonlyMap<string, SessionReachableDisplay>;
    hasMultipleMachines: boolean;
    pinnedSessionKeys: ReadonlySet<string>;
    sessionTags: Record<string, string[]>;
    selectedSessionId: string | null;
    showServerBadge: boolean;
    showPinnedServerBadge: boolean;
}>): ReadonlyArray<SessionListRowViewModel | null> {
    if (input.listItems.length === 0) {
        return EMPTY_SESSION_LIST_ROW_VIEW_MODELS;
    }

    const cacheKey = JSON.stringify([
        input.listItems,
        Array.from(input.reachableSessionDisplayById.entries()),
        input.hasMultipleMachines,
        Array.from(input.pinnedSessionKeys.values()),
        input.sessionTags,
        input.selectedSessionId,
        input.showServerBadge,
        input.showPinnedServerBadge,
    ]);
    const cached = SESSION_LIST_ROW_VIEW_MODELS_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const next = input.listItems.map((item, index) => {
        if (item.type !== 'session') {
            return null;
        }

        const groupKey = String(item.groupKey ?? '').trim();
        const prev = index > 0 ? input.listItems[index - 1] : null;
        const next = index < input.listItems.length - 1 ? input.listItems[index + 1] : null;
        const prevGroupKey = prev && prev.type === 'session' ? String(prev.groupKey ?? '').trim() : '';
        const nextGroupKey = next && next.type === 'session' ? String(next.groupKey ?? '').trim() : '';
        const isFirst = !groupKey || prevGroupKey !== groupKey;
        const isLast = !groupKey || nextGroupKey !== groupKey;
        const sessionKey = typeof item.serverId === 'string' ? `${item.serverId}:${item.session.id}` : null;
        const pinned = item.pinned === true || (sessionKey ? input.pinnedSessionKeys.has(sessionKey) : false);
        const reachableDisplay = input.reachableSessionDisplayById.get(item.session.id);
        const pathSubtitle = reachableDisplay?.pathSubtitle ?? '';
        const machineLabel = reachableDisplay?.machineLabel ?? '';
        const subtitle = input.hasMultipleMachines
            ? (machineLabel && pathSubtitle ? `${machineLabel} · ${pathSubtitle}` : machineLabel || pathSubtitle)
            : pathSubtitle;

        return {
            groupKey,
            sessionKey,
            isFirst,
            isLast,
            isSingle: isFirst && isLast,
            subtitleOverride: item.groupKind === 'project' && item.variant === 'no-path' ? null : (subtitle || null),
            pinned,
            showServerBadge: pinned ? input.showPinnedServerBadge : input.showServerBadge,
            selected: input.selectedSessionId != null && input.selectedSessionId === item.session.id,
            tags: getTagsForSession(input.sessionTags, sessionKey ?? ''),
            secondaryLineMode: resolveSessionListSecondaryLineMode({ groupKind: item.groupKind }),
        };
    });

    SESSION_LIST_ROW_VIEW_MODELS_CACHE.set(cacheKey, next);
    return next;
}
