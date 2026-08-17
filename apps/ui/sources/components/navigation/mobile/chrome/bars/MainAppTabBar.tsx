import * as React from 'react';
import { Platform, View, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { Text } from '@/components/ui/text/Text';
import { FloatingTabBarSurface } from '@/components/ui/navigation/FloatingTabBarSurface';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { resolveTabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { Typography } from '@/constants/Typography';
import { useInboxHasContent } from '@/hooks/inbox/useInboxHasContent';
import { useInboxAvailable } from '@/hooks/inbox/useInboxAvailable';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useSessionsHaveAttention } from '@/hooks/session/useSessionsHaveAttention';
import { useFriendRequests, useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { resolveTabBarTabs } from '@/components/ui/navigation/resolveTabBarTabs';
import type { TabType } from '@/components/ui/navigation/tabTypes';
import { Icon } from '@/components/ui/icons/Icon';

export type { TabType };

type MainAppTabBarProps = Readonly<{
    activeTab: TabType;
    onTabPress: (tab: TabType) => void;
}>;

type WebTabKeyDownEvent = Readonly<{
    key?: string;
    nativeEvent?: Readonly<{ key?: string }>;
    preventDefault?: () => void;
}>;

type WebTabKeyDownProps = Readonly<{
    onKeyDown?: (event: WebTabKeyDownEvent) => void;
}>;

const styles = StyleSheet.create((theme) => ({
    innerContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    tab: {
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 50,
        flexShrink: 1,
    },
    tabContent: {
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
    },
    // Selection highlight behind the whole active tab (icon + label). Subtle
    // overlay of the foreground color so it reads softly over the glass material.
    activePill: {
        position: 'absolute',
        top: 3,
        bottom: 3,
        left: 4,
        right: 4,
        borderRadius: 16,
        backgroundColor: theme.colors.text.primary,
        opacity: 0.05,
    },
    label: {
        fontSize: 10,
        marginTop: 3,
        ...Typography.default(),
    },
    labelActive: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    labelInactive: {
        color: theme.colors.text.secondary,
    },
}));

export const MainAppTabBar = React.memo((props: MainAppTabBarProps) => {
    const { theme } = useUnistyles();
    const insets = useChromeSafeAreaInsets();
    const friendsEnabled = useFriendsEnabled();
    const friendRequests = useFriendRequests();
    const inboxEnabled = useInboxAvailable();
    const inboxHasContent = useInboxHasContent();
    const sessionsHaveAttention = useSessionsHaveAttention();
    const friendsBadgeEnabled = useSetting('tabBarFriendsBadgeEnabled');
    const inboxBadgeEnabled = useSetting('tabBarInboxBadgeEnabled');
    const sessionsBadgeEnabled = useSetting('tabBarSessionsBadgeEnabled');
    const metrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'));

    const tabs: { key: TabType; label: string }[] = React.useMemo(() => {
        const tabKeys = resolveTabBarTabs({ inboxEnabled, friendsEnabled });
        return tabKeys.map((key) => {
            switch (key) {
                case 'inbox':
                    return { key, label: t('tabs.inbox') };
                case 'projects':
                    return { key, label: t('tabs.projects') };
                case 'friends':
                    return { key, label: t('tabs.friends') };
                case 'settings':
                    return { key, label: t('tabs.settings') };
                case 'sessions':
                default:
                    return { key: 'sessions', label: t('tabs.sessions') };
            }
        });
    }, [friendsEnabled, inboxEnabled]);
    const handleTabKeyDown = React.useCallback((tab: TabType, event: WebTabKeyDownEvent) => {
        if (Platform.OS !== 'web') return;
        const key = event?.nativeEvent?.key ?? event?.key;
        // RNW Pressable owns Enter and pointer activation. Its Space handling
        // only applies to button-like roles, so role=tab needs this supplement.
        if (key !== ' ' && key !== 'Spacebar') return;
        event?.preventDefault?.();
        props.onTabPress(tab);
    }, [props.onTabPress]);

    return (
        <FloatingTabBarSurface bottomInset={insets.bottom}>
            <View
                accessibilityRole="tablist"
                style={[styles.innerContainer, { gap: metrics.rowGap }]}
            >
                {tabs.map((tab) => {
                    const isActive = props.activeTab === tab.key;
                    const webKeyDownProps: WebTabKeyDownProps = Platform.OS === 'web'
                        ? { onKeyDown: (event) => handleTabKeyDown(tab.key, event) }
                        : {};

                    return (
                        <Pressable
                            key={tab.key}
                            testID={`tabbar-tab-${tab.key}`}
                            style={[styles.tab, { paddingVertical: metrics.tabPaddingVertical, paddingHorizontal: metrics.tabPaddingHorizontal }]}
                            onPress={() => props.onTabPress(tab.key)}
                            hitSlop={8}
                            accessibilityRole="tab"
                            accessibilityLabel={tab.label}
                            accessibilityState={{ selected: isActive }}
                            aria-selected={isActive}
                            {...webKeyDownProps}
                        >
                            {isActive ? <View pointerEvents="none" style={[styles.activePill, { borderRadius: metrics.activePillRadius }]} /> : null}
                            <View style={styles.tabContent}>
                                {renderMainTabIcon(
                                    tab.key,
                                    metrics.iconSize,
                                    isActive ? theme.colors.text.primary : theme.colors.text.secondary,
                                )}
                                {tab.key === 'friends' && friendsBadgeEnabled && friendRequests.length > 0 && (
                                    <TabBadge variant="count" value={friendRequests.length} />
                                )}
                                {tab.key === 'sessions' && sessionsBadgeEnabled && sessionsHaveAttention && (
                                    <TabBadge variant="dot" />
                                )}
                                {tab.key === 'inbox' && inboxBadgeEnabled && inboxHasContent && (
                                    <TabBadge variant="dot" />
                                )}
                            </View>
                            {metrics.showLabels ? (
                                <Text style={[
                                    styles.label,
                                    isActive ? styles.labelActive : styles.labelInactive,
                                ]}>
                                    {tab.label}
                                </Text>
                            ) : null}
                        </Pressable>
                    );
                })}
            </View>
        </FloatingTabBarSurface>
    );
});

// Match the app's cockpit-bar line icons (all same weight):
// tray for Inbox, chat for Sessions, gear for Settings, people for Friends.
function renderMainTabIcon(key: TabType, size: number, color: string): React.ReactNode {
    const name = key === 'inbox'
        ? 'tray'
        : key === 'settings'
            ? 'gear'
            : key === 'friends'
                ? 'users'
                : key === 'projects'
                    ? 'folder'
                    : 'chats-circle';
    return <Icon name={name} size={size} color={color} />;
}
