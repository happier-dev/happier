import { Ionicons, Octicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { useInboxHasContent } from '@/hooks/inbox/useInboxHasContent';
import { useInboxAvailable } from '@/hooks/inbox/useInboxAvailable';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { t } from '@/text';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { useFriendRequests } from '@/sync/domains/state/storage';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { desktopSidebarChromeStyles } from './desktopSidebarChromeStyles';

type SidebarHeaderActionsResult = Readonly<{
    headerActions: ItemAction[];
    topUtilityActions: ItemAction[];
    renderHeaderOverflowVisual: () => React.ReactNode;
}>;

export function useSidebarHeaderActions(): SidebarHeaderActionsResult {
    const styles = desktopSidebarChromeStyles;
    const { theme } = useUnistyles();
    const router = useRouter();
    const friendRequests = useFriendRequests();
    const inboxHasContent = useInboxHasContent();
    const friendsEnabled = useFriendsEnabled();
    const inboxEnabled = useInboxAvailable();
    const friendRequestCount = friendRequests.length;

    const navigate = React.useCallback((pathname: string, tag: string) => {
        const result = runGuardedNavigation(() => router.push(pathname));
        if (result !== true) {
            fireAndForget(result, { tag });
        }
    }, [router]);

    const headerActions = React.useMemo((): ItemAction[] => {
        const out: ItemAction[] = [];

        if (inboxEnabled) {
            out.push({
                id: 'inbox',
                title: t('tabs.inbox'),
                inlineTestID: 'sidebar-inbox-button',
                icon: (
                    <View style={[styles.iconButton, styles.notificationButton]}>
                        <Octicons name="inbox" size={20} color={theme.colors.header.tint} />
                        {inboxHasContent ? <View style={styles.indicatorDot} /> : null}
                    </View>
                ),
                onPress: () => navigate('/(app)/inbox', 'SidebarView.nav.inbox'),
            });
        }

        if (friendsEnabled) {
            out.push({
                id: 'friends',
                title: t('tabs.friends'),
                icon: (
                    <View style={[styles.iconButton, styles.notificationButton]}>
                        <Ionicons name="people-outline" size={24} color={theme.colors.header.tint} />
                        {friendRequestCount > 0 ? (
                            <View style={styles.badge}>
                                <Text style={styles.badgeText}>
                                    {friendRequestCount > 99 ? '99+' : friendRequestCount}
                                </Text>
                            </View>
                        ) : null}
                    </View>
                ),
                onPress: () => navigate('/(app)/friends', 'SidebarView.nav.friends'),
            });
        }

        out.push({
            id: 'projects',
            title: t('tabs.sessions'),
            inlineTestID: 'nav-projects',
            icon: (
                <View style={styles.iconButton}>
                    <Ionicons name="folder-outline" size={24} color={theme.colors.header.tint} />
                </View>
            ),
            onPress: () => navigate('/projects', 'SidebarView.nav.projects'),
        });

        out.push({
            id: 'settings',
            title: t('settings.title'),
            inlineTestID: 'nav-settings',
            icon: (
                <View style={styles.iconButton}>
                    <Ionicons name="cog-outline" size={24} color={theme.colors.header.tint} />
                </View>
            ),
            onPress: () => navigate('/settings', 'SidebarView.nav.settings'),
        });

        out.push({
            id: 'newSession',
            title: t('newSession.title'),
            inlineTestID: 'nav-new-session',
            icon: (
                <View style={styles.trailingIconButton}>
                    <Ionicons name="add-outline" size={24} color={theme.colors.header.tint} />
                </View>
            ),
            onPress: () => navigate('/new', 'SidebarView.nav.newSession'),
        });

        return out;
    }, [
        friendRequestCount,
        friendsEnabled,
        inboxEnabled,
        inboxHasContent,
        navigate,
        styles.badge,
        styles.badgeText,
        styles.iconButton,
        styles.indicatorDot,
        styles.notificationButton,
        styles.trailingIconButton,
        theme.colors.header.tint,
    ]);

    const topUtilityActions = React.useMemo((): ItemAction[] => {
        const out: ItemAction[] = [];

        if (inboxEnabled) {
            out.push({
                id: 'inbox',
                title: t('tabs.inbox'),
                inlineTestID: 'sidebar-inbox-button',
                icon: (
                    <View style={styles.topNotificationButton}>
                        <Octicons name="inbox" size={15} color={theme.colors.header.tint} />
                        {inboxHasContent ? <View style={styles.topIndicatorDot} /> : null}
                    </View>
                ),
                onPress: () => navigate('/(app)/inbox', 'SidebarView.nav.inbox'),
            });
        }

        out.push({
            id: 'settings',
            title: t('settings.title'),
            inlineTestID: 'nav-settings',
            icon: 'cog-outline' as const,
            onPress: () => navigate('/settings', 'SidebarView.nav.settings'),
        });

        return out;
    }, [
        inboxEnabled,
        inboxHasContent,
        navigate,
        styles.topIndicatorDot,
        styles.topNotificationButton,
        theme.colors.header.tint,
    ]);

    const renderHeaderOverflowVisual = React.useCallback(() => {
        const shouldShowBadge = friendRequestCount > 0;
        const shouldShowDot = !shouldShowBadge && inboxHasContent;

        return (
            <View style={[styles.iconButton, styles.notificationButton]}>
                <Ionicons name="ellipsis-horizontal" size={14} color={theme.colors.header.tint} />
                {shouldShowBadge ? (
                    <View style={styles.badge}>
                        <Text style={styles.badgeText}>
                            {friendRequestCount > 99 ? '99+' : friendRequestCount}
                        </Text>
                    </View>
                ) : shouldShowDot ? (
                    <View style={styles.indicatorDot} />
                ) : null}
            </View>
        );
    }, [
        friendRequestCount,
        inboxHasContent,
        styles.badge,
        styles.badgeText,
        styles.iconButton,
        styles.indicatorDot,
        styles.notificationButton,
        theme.colors.header.tint,
    ]);

    return {
        headerActions,
        topUtilityActions,
        renderHeaderOverflowVisual,
    };
}
