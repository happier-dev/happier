import * as React from 'react';
import { View, Text, Platform, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { InboxView } from '@/components/navigation/shell/InboxView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHeaderHeight, useIsTablet } from '@/utils/platform/responsive';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useRequireInboxFriendsEnabled } from '@/hooks/inbox/useRequireInboxFriendsEnabled';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    header: {
        backgroundColor: theme.colors.header.background,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    headerContent: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
    },
    backButton: {
        marginRight: 16,
    },
    headerTitle: {
        fontSize: 17,
        color: theme.colors.header.tint,
        ...Typography.default('semiBold'),
    },
}));

export default function InboxPage() {
    const enabled = useRequireInboxFriendsEnabled();
    const router = useRouter();
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const isTablet = useIsTablet();
    const headerHeight = useHeaderHeight();

    if (!enabled) return null;

    if (isTablet) {
        return <InboxView />;
    }

    return (
        <View style={styles.container}>
            <View style={[styles.header, { paddingTop: insets.top }]}>
                <View style={[styles.headerContent, { height: headerHeight }]}>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('common.back')}
                        onPress={() => router.back()}
                        style={styles.backButton}
                        hitSlop={15}
                    >
                        <Ionicons
                            name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                            size={24}
                            color={theme.colors.header.tint}
                        />
                    </Pressable>
                    <Text style={styles.headerTitle}>{t('tabs.inbox')}</Text>
                </View>
            </View>
            <InboxView />
        </View>
    );
}
