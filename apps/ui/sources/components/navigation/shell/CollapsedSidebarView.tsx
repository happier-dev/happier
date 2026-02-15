import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useFriendRequests, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useInboxHasContent } from '@/hooks/inbox/useInboxHasContent';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        alignItems: 'center',
        borderStyle: 'solid',
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    header: {
        width: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 8,
    },
    iconButton: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 12,
    },
    iconButtonPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    nav: {
        flex: 1,
        width: '100%',
        alignItems: 'center',
        gap: 6,
        paddingTop: 10,
    },
    badge: {
        position: 'absolute',
        top: 6,
        right: 6,
        backgroundColor: theme.colors.status.error,
        borderRadius: 10,
        minWidth: 18,
        height: 18,
        paddingHorizontal: 5,
        justifyContent: 'center',
        alignItems: 'center',
    },
    badgeText: {
        color: '#FFFFFF',
        fontSize: 10,
        fontWeight: '700',
    },
    indicatorDot: {
        position: 'absolute',
        top: 10,
        right: 10,
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: theme.colors.text,
    },
    footer: {
        width: '100%',
        alignItems: 'center',
        paddingBottom: 10,
        gap: 6,
    },
}));

export const CollapsedSidebarView = React.memo(() => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const [, setSidebarCollapsed] = useLocalSettingMutable('sidebarCollapsed');
    const inboxFriendsEnabled = useFriendsEnabled();
    const friendRequests = useFriendRequests();
    const inboxHasContent = useInboxHasContent();

    return (
        <View style={[styles.container, { paddingTop: safeArea.top, paddingBottom: safeArea.bottom }]}>
            <View style={styles.header}>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Expand sidebar"
                    onPress={() => setSidebarCollapsed(false)}
                    style={({ pressed }) => [styles.iconButton, pressed ? styles.iconButtonPressed : null]}
                    hitSlop={10}
                >
                    <Ionicons name="chevron-forward-outline" size={22} color={theme.colors.header.tint} />
                </Pressable>
            </View>

            <View style={styles.nav}>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('tabs.sessions')}
                    onPress={() => router.push('/')}
                    style={({ pressed }) => [styles.iconButton, pressed ? styles.iconButtonPressed : null]}
                    hitSlop={10}
                >
                    <Ionicons name="chatbubble-ellipses-outline" size={22} color={theme.colors.header.tint} />
                </Pressable>

                {inboxFriendsEnabled ? (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('tabs.inbox')}
                        onPress={() => router.push('/(app)/friends')}
                        style={({ pressed }) => [styles.iconButton, pressed ? styles.iconButtonPressed : null]}
                        hitSlop={10}
                    >
                        <Ionicons name="people-outline" size={22} color={theme.colors.header.tint} />
                        {friendRequests.length > 0 ? (
                            <View style={styles.badge}>
                                <Text style={styles.badgeText}>
                                    {friendRequests.length > 99 ? '99+' : friendRequests.length}
                                </Text>
                            </View>
                        ) : inboxHasContent ? (
                            <View style={styles.indicatorDot} />
                        ) : null}
                    </Pressable>
                ) : null}

                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('settings.title')}
                    onPress={() => router.push('/settings')}
                    style={({ pressed }) => [styles.iconButton, pressed ? styles.iconButtonPressed : null]}
                    hitSlop={10}
                >
                    <Ionicons name="cog-outline" size={22} color={theme.colors.header.tint} />
                </Pressable>
            </View>

            <View style={styles.footer}>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('newSession.title')}
                    onPress={() => router.push('/new')}
                    style={({ pressed }) => [styles.iconButton, pressed ? styles.iconButtonPressed : null]}
                    hitSlop={10}
                >
                    <Ionicons name="add-outline" size={26} color={theme.colors.header.tint} />
                </Pressable>
            </View>
        </View>
    );
});
