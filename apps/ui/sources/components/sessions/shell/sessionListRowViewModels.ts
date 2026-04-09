import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
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

export function buildSessionListRowViewModels(input: Readonly<{
    listItems: ReadonlyArray<SessionListIndexItem>;
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
        const sessionId = String(item.sessionId ?? '').trim();
        const sessionKey = typeof item.serverId === 'string' && sessionId ? `${item.serverId}:${sessionId}` : null;
        const pinned = item.pinned === true || (sessionKey ? input.pinnedSessionKeys.has(sessionKey) : false);
        const reachableDisplay = input.reachableSessionDisplayById.get(sessionId);
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
            selected: input.selectedSessionId != null && input.selectedSessionId === sessionId,
            tags: getTagsForSession(input.sessionTags, sessionKey ?? ''),
            secondaryLineMode: resolveSessionListSecondaryLineMode({ groupKind: item.groupKind }),
        };
    });
    return next;
}
