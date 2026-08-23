import * as React from 'react';
import { View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { useInboxHasContent } from '@/hooks/inbox/useInboxHasContent';
import { useInboxAvailable } from '@/hooks/inbox/useInboxAvailable';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { Text } from '@/components/ui/text/Text';
import { FloatingTabBarSurface } from '@/components/ui/navigation/FloatingTabBarSurface';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { resolveTabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { useFriendRequests, useSetting } from '@/sync/domains/state/storage';
import type { TabType } from './tabTypes';
import { resolveTabBarTabs } from './resolveTabBarTabs';
import { Icon, type IconName } from '@/components/ui/icons/Icon';


export type { TabType };

interface TabBarProps {
    activeTab: TabType;
    onTabPress: (tab: TabType) => void;
    /**
     * A sibling capsule rendered beside the pill (see `FloatingTabBarSurface`).
     * It is deliberately not a tab: the bar stays a pure navigation control, and
     * the caller owns which surfaces offer the action.
     */
    trailingAccessory?: React.ReactNode;
}

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

export const TabBar = React.memo(({ activeTab, onTabPress, trailingAccessory }: TabBarProps) => {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const friendsEnabled = useFriendsEnabled();
    const friendRequests = useFriendRequests();
    const inboxEnabled = useInboxAvailable();
    const inboxHasContent = useInboxHasContent();
    const friendsBadgeEnabled = useSetting('tabBarFriendsBadgeEnabled');
    const inboxBadgeEnabled = useSetting('tabBarInboxBadgeEnabled');
    const metrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'));

    const tabs: { key: TabType; label: string }[] = React.useMemo(() => {
        const tabKeys = resolveTabBarTabs({ inboxEnabled, friendsEnabled });
        return tabKeys.map((key) => {
            switch (key) {
                case 'inbox':
                    return { key, label: t('tabs.inbox') };
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

    return (
        <FloatingTabBarSurface bottomInset={insets.bottom} trailingAccessory={trailingAccessory}>
            <View style={[styles.innerContainer, { gap: metrics.rowGap }]}>
                {tabs.map((tab) => {
                    const isActive = activeTab === tab.key;

                    return (
                        <Pressable
                            key={tab.key}
                            testID={`tabbar-tab-${tab.key}`}
                            style={[styles.tab, { paddingVertical: metrics.tabPaddingVertical, paddingHorizontal: metrics.tabPaddingHorizontal }]}
                            onPress={() => onTabPress(tab.key)}
                            hitSlop={8}
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
                                {tab.key === 'inbox' && inboxBadgeEnabled && inboxHasContent ? (
                                    <TabBadge variant="dot" />
                                ) : null}
                            </View>
                            {metrics.showLabels ? (
                                <Text
                                    // A wrapped label would grow the bar, and the chrome host
                                    // publishes that height to the surfaces that pad by it.
                                    numberOfLines={1}
                                    style={[
                                        styles.label,
                                        isActive ? styles.labelActive : styles.labelInactive
                                    ]}
                                >
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

// Match the app's cockpit-bar line icons (all Phosphor, same weight):
// mailbox for Inbox, chat for Sessions, sliders for Settings, people for Friends.
function renderMainTabIcon(key: TabType, size: number, color: string): React.ReactNode {
    const name: IconName = key === 'inbox'
        ? 'mailbox'
        : key === 'settings'
            ? 'sliders-horizontal'
            : key === 'friends'
                ? 'users'
                : 'chats-circle';
    return <Icon name={name} size={size} color={color} />;
}
