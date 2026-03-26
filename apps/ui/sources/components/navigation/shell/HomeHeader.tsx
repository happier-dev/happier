import * as React from 'react';
import { Header } from '@/components/navigation/Header';
import { Platform, Pressable, View } from 'react-native';
import { Typography } from '@/constants/Typography';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useSegments } from 'expo-router';
import { getServerInfo } from '@/sync/domains/server/serverConfig';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { Text } from '@/components/ui/text/Text';
import { useConnectionHealth } from '@/components/navigation/connectionStatus/useConnectionHealth';
import { resolveAutomationAccessibilityLabel } from '@/dev/automation/automationTestId';


const stylesheet = StyleSheet.create((theme, runtime) => ({
    headerButton: {
        // marginHorizontal: 4,
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconButton: {
        color: theme.colors.header.tint,
    },
    logoContainer: {
        // marginHorizontal: 4,
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        tintColor: theme.colors.header.tint,
    },
    titleContainer: {
        flex: 1,
        alignItems: 'center',
    },
    titleText: {
        fontSize: 17,
        color: theme.colors.header.tint,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    subtitleText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: -2,
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -2,
    },
    statusDot: {
        marginRight: 4,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    centeredTitle: {
        textAlign: Platform.OS === 'ios' ? 'center' : 'left',
        alignSelf: Platform.OS === 'ios' ? 'center' : 'flex-start',
        flex: 1,
    },
}));


export const HomeHeader = React.memo(() => {
    const { theme } = useUnistyles();
    const automationsSupport = useAutomationsSupport();
    const showAutomations = automationsSupport?.enabled !== false;

    return (
        <View style={{ backgroundColor: theme.colors.groupped.background }}>
            <Header
                title={<HeaderTitleWithSubtitle />}
                headerRight={() => <HeaderRight />}
                headerLeft={() => <HeaderLeft showAutomations={showAutomations} />}
                headerShadowVisible={false}
                headerTransparent={true}
            />
        </View>
    )
})

export const HomeHeaderNotAuth = React.memo(() => {
    useSegments(); // Re-rendered automatically when screen navigates back
    const serverInfo = getServerInfo();
    const { theme } = useUnistyles();
    return (
        <Header
            title={<HeaderTitleWithSubtitle subtitle={serverInfo.isCustom ? serverInfo.hostname + (serverInfo.port ? `:${serverInfo.port}` : '') : undefined} />}
            headerRight={() => <HeaderRightNotAuth />}
            headerLeft={() => <HeaderLeft showAutomations={false} />}
            headerShadowVisible={false}
            headerBackgroundColor={theme.colors.groupped.background}
        />
    )
});

function HeaderRight() {
    const router = useRouter();
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const e2eAccessibilityLabel = resolveAutomationAccessibilityLabel({
        testID: 'home-header-start-new-session',
        accessibilityLabel: undefined,
    });

    return (
        <Pressable
            testID="home-header-start-new-session"
            accessibilityLabel={e2eAccessibilityLabel}
            onPress={() => router.push('/new')}
            hitSlop={15}
            style={styles.headerButton}
        >
            <Ionicons name="add-outline" size={28} color={theme.colors.header.tint} />
        </Pressable>
    );
}

function HeaderRightNotAuth() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const styles = stylesheet;


    return (
        <Pressable
            testID="home-header-open-server-config"
            onPress={() => router.push('/server')}
            hitSlop={15}
            style={styles.headerButton}
        >
            <Ionicons name="server-outline" size={24} color={theme.colors.header.tint} />
        </Pressable>
    );
}

function HeaderLeft(props: { showAutomations: boolean }) {
    const router = useRouter();
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={styles.logoContainer}>
                <Image
                    source={theme.dark ? require('@/assets/images/logo-white.png') : require('@/assets/images/logo-black.png')}
                    contentFit="contain"
                    style={[{ width: 24, height: 24 }]}
                />
            </View>
            {props.showAutomations ? (
                <Pressable
                    onPress={() => router.push('/automations')}
                    hitSlop={15}
                    style={styles.headerButton}
                    accessibilityRole="button"
                    accessibilityLabel={t('automations.openA11y')}
                >
                    <Ionicons name="timer-outline" size={22} color={theme.colors.header.tint} />
                </Pressable>
            ) : null}
        </View>
    );
}

function HeaderTitleWithSubtitle({ subtitle }: { subtitle?: string }) {
    const connectionHealth = useConnectionHealth();
    const styles = stylesheet;
    const hasCustomSubtitle = !!subtitle;
    const showConnectionStatus = !hasCustomSubtitle && Boolean(connectionHealth.statusLabelKey);

    return (
        <View style={styles.titleContainer}>
            <Text style={styles.titleText}>
                {t('sidebar.sessionsTitle')}
            </Text>
            {hasCustomSubtitle && (
                <Text style={styles.subtitleText}>
                    {subtitle}
                </Text>
            )}
            {showConnectionStatus && (
                <View style={styles.statusContainer}>
                    <StatusDot
                        color={connectionHealth.color}
                        isPulsing={connectionHealth.isPulsing}
                        size={6}
                        style={styles.statusDot}
                    />
                    <Text style={[
                        styles.statusText,
                        { color: connectionHealth.color }
                    ]}>
                        {t(connectionHealth.statusLabelKey)}
                    </Text>
                </View>
            )}
        </View>
    );
}
