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
import { DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX } from './desktopChromeMetrics';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import {
    shouldForceFreshNewSessionEntryFromPressEvent,
    useResolveNewSessionOrdinaryEntryRoute,
} from '@/components/sessions/new/navigation/newSessionOrdinaryEntryRoute';

type SidebarHeaderActionsResult = Readonly<{
    headerActions: ItemAction[];
    topUtilityActions: ItemAction[];
    renderHeaderOverflowVisual: () => React.ReactNode;
}>;

export function useSidebarHeaderActions(): SidebarHeaderActionsResult {
    const styles = desktopSidebarChromeStyles;
    const { theme } = useUnistyles();
    const router = useRouter();
    const resolveNewSessionOrdinaryEntryRoute = useResolveNewSessionOrdinaryEntryRoute();
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
    const navigateToNewSession = React.useCallback((event?: unknown) => {
        const { draftId, draftOrigin } = resolveNewSessionOrdinaryEntryRoute({
            forceFresh: shouldForceFreshNewSessionEntryFromPressEvent(event),
        });
        const result = runGuardedNavigation(() => router.push({
            pathname: '/new',
            params: { draftId, draftOrigin },
        }));
        if (result !== true) {
            fireAndForget(result, { tag: 'SidebarView.nav.newSession' });
        }
    }, [resolveNewSessionOrdinaryEntryRoute, router]);

    const headerActions = React.useMemo((): ItemAction[] => {
        const out: ItemAction[] = [];

        if (inboxEnabled) {
            out.push({
                id: 'inbox',
                title: t('tabs.inbox'),
                inlineTestID: 'sidebar-inbox-button',
                icon: (
                    <View style={[styles.iconButton, styles.notificationButton]}>
                        <Icon name="mailbox" size={ICON_SIZE.md} color={theme.colors.chrome.header.foreground} />
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
                        <Icon name="users" size={ICON_SIZE.md} color={theme.colors.chrome.header.foreground} />
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
            id: 'settings',
            title: t('settings.title'),
            inlineTestID: 'nav-settings',
            icon: (
                <View style={styles.iconButton}>
                    <Icon name="sliders-horizontal" size={ICON_SIZE.md} color={theme.colors.chrome.header.foreground} />
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
                    <Icon name="plus" size={ICON_SIZE.md} color={theme.colors.chrome.header.foreground} />
                </View>
            ),
            onPress: navigateToNewSession,
        });

        return out;
    }, [
        friendRequestCount,
        friendsEnabled,
        inboxEnabled,
        inboxHasContent,
        navigate,
        navigateToNewSession,
        styles.badge,
        styles.badgeText,
        styles.iconButton,
        styles.indicatorDot,
        styles.notificationButton,
        styles.trailingIconButton,
        theme.colors.chrome.header.foreground,
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
                        {/* The one glyph in the top strip that is built here rather than named, so
                            it has to reach for the strip's size itself or it stays behind when the
                            others move. */}
                        <Icon
                            name="mailbox"
                            size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                            color={theme.colors.chrome.header.foreground}
                        />
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
            icon: 'sliders-horizontal' as const,
            onPress: () => navigate('/settings', 'SidebarView.nav.settings'),
        });

        return out;
    }, [
        inboxEnabled,
        inboxHasContent,
        navigate,
        styles.badge,
        styles.badgeText,
        styles.topIndicatorDot,
        styles.topNotificationButton,
        theme.colors.chrome.header.foreground,
    ]);

    const renderHeaderOverflowVisual = React.useCallback(() => {
        const shouldShowBadge = friendRequestCount > 0;
        const shouldShowDot = !shouldShowBadge && inboxHasContent;

        return (
            <View style={[styles.iconButton, styles.notificationButton]}>
                <Icon name="dots-three" size={ICON_SIZE.md} color={theme.colors.chrome.header.foreground} />
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
        theme.colors.chrome.header.foreground,
    ]);

    return {
        headerActions,
        topUtilityActions,
        renderHeaderOverflowVisual,
    };
}
