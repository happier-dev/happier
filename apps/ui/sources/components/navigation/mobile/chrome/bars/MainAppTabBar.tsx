import * as React from 'react';
import { View, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { layout } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { SafeExpoImage } from '@/components/ui/media/SafeExpoImage';
import { Typography } from '@/constants/Typography';
import { useInboxHasContent } from '@/hooks/inbox/useInboxHasContent';
import { useInboxAvailable } from '@/hooks/inbox/useInboxAvailable';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useSessionsHaveAttention } from '@/hooks/session/useSessionsHaveAttention';
import { useFriendRequests } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { resolveTabBarTabs } from '@/components/ui/navigation/resolveTabBarTabs';
import type { TabType } from '@/components/ui/navigation/tabTypes';

export type { TabType };

type MainAppTabBarProps = Readonly<{
    activeTab: TabType;
    onTabPress: (tab: TabType) => void;
}>;

const styles = StyleSheet.create((theme) => ({
    outerContainer: {
        backgroundColor: theme.colors.surface,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
    },
    innerContainer: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'flex-start',
        maxWidth: layout.maxWidth,
        width: '100%',
        alignSelf: 'center',
    },
    tab: {
        flex: 1,
        alignItems: 'center',
        paddingTop: 8,
        paddingBottom: 4,
    },
    tabContent: {
        alignItems: 'center',
        position: 'relative',
    },
    label: {
        fontSize: 10,
        marginTop: 3,
        ...Typography.default(),
    },
    labelActive: {
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    labelInactive: {
        color: theme.colors.textSecondary,
    },
    badge: {
        position: 'absolute',
        top: -4,
        right: -8,
        backgroundColor: theme.colors.status.error,
        borderRadius: 8,
        minWidth: 16,
        height: 16,
        paddingHorizontal: 4,
        justifyContent: 'center',
        alignItems: 'center',
    },
    badgeText: {
        color: theme.colors.button.primary.tint,
        fontSize: 10,
        ...Typography.default('semiBold'),
    },
    indicatorDot: {
        position: 'absolute',
        top: 0,
        right: -2,
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.text,
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

    const tabs: { key: TabType; icon: any; label: string }[] = React.useMemo(() => {
        const tabKeys = resolveTabBarTabs({ inboxEnabled, friendsEnabled });
        return tabKeys.map((key) => {
            switch (key) {
                case 'inbox':
                    return { key, icon: require('@/assets/images/brutalist/Brutalism 27.png'), label: t('tabs.inbox') };
                case 'projects':
                    return { key, icon: require('@/assets/images/brutalist/Brutalism 16.png'), label: t('tabs.projects') };
                case 'friends':
                    return { key, icon: require('@/assets/images/brutalist/Brutalism 28.png'), label: t('tabs.friends') };
                case 'settings':
                    return { key, icon: require('@/assets/images/brutalist/Brutalism 9.png'), label: t('tabs.settings') };
                case 'sessions':
                default:
                    return { key: 'sessions', icon: require('@/assets/images/brutalist/Brutalism 15.png'), label: t('tabs.sessions') };
            }
        });
    }, [friendsEnabled, inboxEnabled]);

    return (
        <View style={[styles.outerContainer, { paddingBottom: insets.bottom }]}>
            <View style={styles.innerContainer}>
                {tabs.map((tab) => {
                    const isActive = props.activeTab === tab.key;

                    return (
                        <Pressable
                            key={tab.key}
                            testID={`tabbar-tab-${tab.key}`}
                            style={styles.tab}
                            onPress={() => props.onTabPress(tab.key)}
                            hitSlop={8}
                        >
                            <View style={styles.tabContent}>
                                <SafeExpoImage
                                    source={tab.icon}
                                    contentFit="contain"
                                    style={{ width: 24, height: 24 }}
                                    tintColor={isActive ? theme.colors.text : theme.colors.textSecondary}
                                />
                                {tab.key === 'friends' && friendRequests.length > 0 && (
                                    <View style={styles.badge}>
                                        <Text style={styles.badgeText}>
                                            {friendRequests.length > 99 ? '99+' : friendRequests.length}
                                        </Text>
                                    </View>
                                )}
                                {tab.key === 'sessions' && sessionsHaveAttention && (
                                    <View style={styles.indicatorDot} />
                                )}
                                {tab.key === 'inbox' && inboxHasContent && (
                                    <View style={styles.indicatorDot} />
                                )}
                            </View>
                            <Text style={[
                                styles.label,
                                isActive ? styles.labelActive : styles.labelInactive,
                            ]}>
                                {tab.label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
});
