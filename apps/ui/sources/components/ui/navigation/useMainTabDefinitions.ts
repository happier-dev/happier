import * as React from 'react';
import { useInboxHasContent } from '@/hooks/inbox/useInboxHasContent';
import { useInboxAvailable } from '@/hooks/inbox/useInboxAvailable';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useFriendRequestCount, useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { resolveTabBarTabs } from './resolveTabBarTabs';
import type { TabType } from './tabTypes';

const MAIN_TAB_FACTS = {
    inbox: { label: 'tabs.inbox', sfSymbol: 'tray' },
    sessions: { label: 'tabs.sessions', sfSymbol: 'bubble.left.and.bubble.right' },
    friends: { label: 'tabs.friends', sfSymbol: 'person.2' },
    settings: { label: 'tabs.settings', sfSymbol: 'gearshape' },
} as const;

export type MainTabDefinition = Readonly<{
    key: TabType;
    label: string;
    sfSymbol: string;
    badge?: Readonly<{ kind: 'count'; value: number }> | Readonly<{ kind: 'dot' }>;
}>;

/** Both presenters consume the same visibility, order, labels, and badge summaries. */
export function useMainTabDefinitions(): readonly MainTabDefinition[] {
    const friendsEnabled = useFriendsEnabled();
    const friendRequestCount = useFriendRequestCount();
    const inboxEnabled = useInboxAvailable();
    const inboxHasContent = useInboxHasContent();
    const friendsBadgeEnabled = useSetting('tabBarFriendsBadgeEnabled');
    const inboxBadgeEnabled = useSetting('tabBarInboxBadgeEnabled');
    return React.useMemo(() => resolveTabBarTabs({ inboxEnabled, friendsEnabled }).map((key): MainTabDefinition => ({
        key,
        label: t(MAIN_TAB_FACTS[key].label),
        sfSymbol: MAIN_TAB_FACTS[key].sfSymbol,
        badge: key === 'friends' && friendsBadgeEnabled && friendRequestCount > 0
            ? { kind: 'count', value: friendRequestCount }
            : key === 'inbox' && inboxBadgeEnabled && inboxHasContent ? { kind: 'dot' } : undefined,
    })), [friendsEnabled, friendRequestCount, inboxEnabled, inboxHasContent, friendsBadgeEnabled, inboxBadgeEnabled]);
}
