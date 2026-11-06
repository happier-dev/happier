import type { IconName } from '@/components/ui/icons/Icon';
import type { TabType } from '@/components/ui/navigation/tabTypes';
import { resolveTabBarTabs } from '@/components/ui/navigation/resolveTabBarTabs';
import { useInboxHasContent } from '@/hooks/inbox/useInboxHasContent';
import { useInboxAvailable } from '@/hooks/inbox/useInboxAvailable';
import { useSessionsHaveAttention } from '@/hooks/session/useSessionsHaveAttention';
import { useWorkflowsDestinationAccess } from '@/components/workflows/gating/workflowsDestinationAccess';
import { useSetting } from '@/sync/domains/state/storage';
import { t, type TranslationKey } from '@/text';

const MAIN_TAB_FACTS = {
    inbox: { label: 'tabs.inbox', icon: 'tray', sfSymbol: 'tray' },
    sessions: { label: 'tabs.sessions', icon: 'chats-circle', sfSymbol: 'bubble.left.and.bubble.right' },
    projects: { label: 'tabs.projects', icon: 'folder', sfSymbol: 'folder' },
    workflows: { label: 'workflows.title', icon: 'tree-structure', sfSymbol: 'point.3.connected.trianglepath.dotted' },
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
    const workflowsEnabled = useWorkflowsDestinationAccess().discoverable;
    const inboxEnabled = useInboxAvailable();
    const inboxHasContent = useInboxHasContent();
    const sessionsHaveAttention = useSessionsHaveAttention();
    const inboxBadgeEnabled = useSetting('tabBarInboxBadgeEnabled');
    const sessionsBadgeEnabled = useSetting('tabBarSessionsBadgeEnabled');
    const showSessionsAttentionBadge = sessionsBadgeEnabled && sessionsHaveAttention;
    return resolveTabBarTabs({ inboxEnabled, workflowsEnabled }).map(key => ({
        key, label: t(MAIN_TAB_FACTS[key].label), icon: MAIN_TAB_FACTS[key].icon,
        sfSymbol: MAIN_TAB_FACTS[key].sfSymbol,
        accessibilityLabel: t(key === 'sessions' && showSessionsAttentionBadge ? 'tabs.sessionsNeedsAttention' : MAIN_TAB_FACTS[key].label),
        // Friend requests reach the person through the Inbox tab, which lists them.
        badge: key === 'sessions' && showSessionsAttentionBadge || key === 'inbox' && inboxBadgeEnabled && inboxHasContent
            ? { kind: 'dot' as const } : undefined,
    }));
}
