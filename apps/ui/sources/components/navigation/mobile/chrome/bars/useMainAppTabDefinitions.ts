import type { IconName } from '@/components/ui/icons/Icon';
import type { TabType } from '@/components/ui/navigation/tabTypes';
import { resolveTabBarTabs } from '@/components/ui/navigation/resolveTabBarTabs';
import { useInboxHasContent } from '@/hooks/inbox/useInboxHasContent';
import { useInboxAvailable } from '@/hooks/inbox/useInboxAvailable';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useSessionsHaveAttention } from '@/hooks/session/useSessionsHaveAttention';
import { useFriendRequestCount, useSetting } from '@/sync/domains/state/storage';
import { t, type TranslationKey } from '@/text';

const MAIN_TAB_FACTS = {
    inbox: { label: 'tabs.inbox', icon: 'tray', sfSymbol: 'tray' },
    sessions: { label: 'tabs.sessions', icon: 'chats-circle', sfSymbol: 'bubble.left.and.bubble.right' },
    projects: { label: 'tabs.projects', icon: 'folder', sfSymbol: 'folder' },
    friends: { label: 'tabs.friends', icon: 'users', sfSymbol: 'person.2' },
    settings: { label: 'tabs.settings', icon: 'gear', sfSymbol: 'gearshape' },
} as const satisfies Record<TabType, { label: TranslationKey; icon: IconName; sfSymbol: string }>;

export type MainAppTabDefinition = Readonly<{
    key: TabType;
    label: string;
    accessibilityLabel: string;
    icon: IconName;
    sfSymbol: string;
    badge?: Readonly<{ kind: 'count'; value: number }> | Readonly<{ kind: 'dot' }>;
}>;

/** Shared presentation facts; the main-tab state provider remains navigation authority. */
export function useMainAppTabDefinitions(): readonly MainAppTabDefinition[] {
    const friendsEnabled = useFriendsEnabled();
    const friendRequestCount = useFriendRequestCount();
    const inboxEnabled = useInboxAvailable();
    const inboxHasContent = useInboxHasContent();
    const sessionsHaveAttention = useSessionsHaveAttention();
    const friendsBadgeEnabled = useSetting('tabBarFriendsBadgeEnabled');
    const inboxBadgeEnabled = useSetting('tabBarInboxBadgeEnabled');
    const sessionsBadgeEnabled = useSetting('tabBarSessionsBadgeEnabled');
    const showSessionsAttentionBadge = sessionsBadgeEnabled && sessionsHaveAttention;
    return resolveTabBarTabs({ inboxEnabled, friendsEnabled }).map(key => ({
        key, label: t(MAIN_TAB_FACTS[key].label), icon: MAIN_TAB_FACTS[key].icon,
        sfSymbol: MAIN_TAB_FACTS[key].sfSymbol,
        accessibilityLabel: t(key === 'sessions' && showSessionsAttentionBadge ? 'tabs.sessionsNeedsAttention' : MAIN_TAB_FACTS[key].label),
        badge: key === 'friends' && friendsBadgeEnabled && friendRequestCount > 0
            ? { kind: 'count' as const, value: friendRequestCount }
            : key === 'sessions' && showSessionsAttentionBadge || key === 'inbox' && inboxBadgeEnabled && inboxHasContent
                ? { kind: 'dot' as const } : undefined,
    }));
}
