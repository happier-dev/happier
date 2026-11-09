import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { getPreferredLanguage, t } from '@/text';
import { LruMap } from '@/utils/cache/lruMap';

import { readSessionListShellCacheMaxEntriesFromEnv } from '../sessionListShellCacheConfig';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';

/** The Session header's menu entries for the places the header itself no longer carries. */
export const SESSION_HEADER_MENU_OPEN_WORK_ID = 'header.openSubagents';
export const SESSION_HEADER_MENU_OPEN_TERMINAL_ID = 'header.openTerminal';
export const SESSION_HEADER_MENU_OPEN_BROWSER_ID = 'header.openBrowser';
export const SESSION_HEADER_MENU_OPEN_AUTOMATIONS_ID = 'header.openAutomations';

const EMPTY_SESSION_VIEW_HEADER_ACTION_ITEMS: readonly DropdownMenuItem[] = Object.freeze([]);
const SESSION_VIEW_HEADER_ACTION_ITEMS_CACHE = new LruMap<string, readonly DropdownMenuItem[]>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

type SessionViewHeaderActionItemsInput = Readonly<{
    /**
     * The Session's right rail is not on screen (a phone, narrow web, multi-pane off, no rail): its
     * destinations are reached from ⋯ instead (calm-shell R2-1). With the rail, the rail carries them.
     */
    destinationsInMenu: boolean;
    workAvailable: boolean;
    workCount: number;
    terminalAvailable: boolean;
    browserAvailable: boolean;
    showAutomations: boolean;
    actionIconColor: string;
}>;

/**
 * The header's own ⋯ entries: Work, Terminal and Browser while the rail is not visible (People and
 * Computer join from the menu's own owners), and Automations, which has no fixed glyph any more.
 */
export function resolveSessionViewHeaderActionItems(input: SessionViewHeaderActionItemsInput): readonly DropdownMenuItem[] {
    const cacheKey = JSON.stringify([getPreferredLanguage(), input.destinationsInMenu, input.workAvailable, input.workCount,
        input.terminalAvailable, input.browserAvailable, input.showAutomations, input.actionIconColor]);
    const cached = SESSION_VIEW_HEADER_ACTION_ITEMS_CACHE.get(cacheKey);
    if (cached) return cached;

    // Menu rows share one glyph size, so every title starts on the same edge.
    const icon = (name: React.ComponentProps<typeof Icon>['name']) => <Icon name={name} size={ICON_SIZE.sm} color={input.actionIconColor} />;
    const items: DropdownMenuItem[] = [];
    if (input.destinationsInMenu && input.workAvailable) {
        // No separate "Runs" entry: the Work roster is the one list of a Session's runs and agents.
        items.push({ id: SESSION_HEADER_MENU_OPEN_WORK_ID, title: t('session.openSubagents', { count: input.workCount }), icon: icon('robot') });
    }
    if (input.destinationsInMenu && input.terminalAvailable) {
        items.push({ id: SESSION_HEADER_MENU_OPEN_TERMINAL_ID, title: t('settings.terminal'), icon: icon('terminal') });
    }
    if (input.destinationsInMenu && input.browserAvailable) {
        items.push({ id: SESSION_HEADER_MENU_OPEN_BROWSER_ID, title: t('browserSurface.title'), icon: icon('globe') });
    }
    if (input.showAutomations) {
        items.push({ id: SESSION_HEADER_MENU_OPEN_AUTOMATIONS_ID, title: t('session.openAutomations'), icon: icon('timer') });
    }

    const next = items.length > 0 ? items : EMPTY_SESSION_VIEW_HEADER_ACTION_ITEMS;
    SESSION_VIEW_HEADER_ACTION_ITEMS_CACHE.set(cacheKey, next);
    return next;
}
