import { Ionicons } from '@expo/vector-icons';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { DependabotIcon } from '@/components/ui/icons/DependabotIcon';
import { getPreferredLanguage, t } from '@/text';
import { LruMap } from '@/utils/cache/lruMap';

import { readSessionListShellCacheMaxEntriesFromEnv } from '../sessionListShellCacheConfig';

const EMPTY_SESSION_VIEW_HEADER_ACTION_ITEMS: readonly DropdownMenuItem[] = Object.freeze([]);
const SESSION_VIEW_HEADER_ACTION_ITEMS_CACHE = new LruMap<string, readonly DropdownMenuItem[]>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

function buildCacheKey(input: Readonly<{
    shouldShowSubagentsButton: boolean;
    subagentActiveCount: number;
    sessionExecutionRunsSupported: boolean;
    showAutomations: boolean;
    actionIconColor: string;
}>): string {
    return JSON.stringify([
        getPreferredLanguage(),
        input.shouldShowSubagentsButton ? 1 : 0,
        input.subagentActiveCount,
        input.sessionExecutionRunsSupported ? 1 : 0,
        input.showAutomations ? 1 : 0,
        input.actionIconColor,
    ]);
}

export function resolveSessionViewHeaderActionItems(input: Readonly<{
    shouldFoldHeaderIconActions: boolean;
    shouldShowSubagentsButton: boolean;
    subagentActiveCount: number;
    sessionExecutionRunsSupported: boolean;
    showAutomations: boolean;
    actionIconColor: string;
}>): readonly DropdownMenuItem[] {
    if (!input.shouldFoldHeaderIconActions) {
        return EMPTY_SESSION_VIEW_HEADER_ACTION_ITEMS;
    }

    const cacheKey = buildCacheKey(input);
    const cached = SESSION_VIEW_HEADER_ACTION_ITEMS_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const items: DropdownMenuItem[] = [];
    if (input.shouldShowSubagentsButton) {
        items.push({
            id: 'header.openSubagents',
            title: t('session.openSubagents', { count: input.subagentActiveCount }),
            icon: <DependabotIcon size={18} color={input.actionIconColor} />,
        });
    }
    if (input.sessionExecutionRunsSupported) {
        items.push({
            id: 'header.openRuns',
            title: t('session.openRuns'),
            icon: <Ionicons name="play-outline" size={18} color={input.actionIconColor} />,
        });
    }
    if (input.showAutomations) {
        items.push({
            id: 'header.openAutomations',
            title: t('session.openAutomations'),
            icon: <Ionicons name="timer-outline" size={18} color={input.actionIconColor} />,
        });
    }

    const next = items.length > 0 ? items : EMPTY_SESSION_VIEW_HEADER_ACTION_ITEMS;
    SESSION_VIEW_HEADER_ACTION_ITEMS_CACHE.set(cacheKey, next);
    return next;
}
