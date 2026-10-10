import * as React from 'react';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { Header } from '@/components/navigation/Header';
import { Platform, Pressable, View } from 'react-native';
import { Typography } from '@/constants/Typography';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { useRouter, useSegments } from 'expo-router';
import { getServerInfo } from '@/sync/domains/server/serverConfig';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useWorkflowsDestinationAccess } from '@/components/workflows/gating/workflowsDestinationAccess';
import { Text } from '@/components/ui/text/Text';
import { useConnectionHealth } from '@/components/navigation/connectionStatus/useConnectionHealth';
import { UpdatesPopoverButton } from '@/components/updates/UpdatesPopoverButton';
import { useSharedUpdatesSummary } from '@/updates/useUpdatesSummary';
import { Icon } from '@/components/ui/icons/Icon';
import { AppShellThemeToggle } from './appRail/AppShellThemeToggle';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import {
    shouldForceFreshNewSessionEntryFromPressEvent,
    useResolveNewSessionOrdinaryEntryRoute,
} from '@/components/sessions/new/navigation/newSessionOrdinaryEntryRoute';


const stylesheet = StyleSheet.create((theme, runtime) => ({
    headerButton: {
        // marginHorizontal: 4,
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconButton: {
        color: theme.colors.chrome.header.foreground,
    },
    logoContainer: {
        // marginHorizontal: 4,
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        tintColor: theme.colors.chrome.header.foreground,
    },
    titleContainer: {
        flex: 1,
        alignItems: 'center',
    },
    titleText: {
        fontSize: 16,
        color: theme.colors.chrome.header.foreground,
        ...Typography.default('semiBold'),
    },
    subtitleText: {
        fontSize: 12,
        color: theme.colors.text.secondary,
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
        fontSize: 11,
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
    const materialColor = useHappierMaterialColorResolver();
    const showWorkflows = useWorkflowsDestinationAccess().discoverable;

    return (
        <View style={{ backgroundColor: materialColor(theme.colors.background.canvas, 'transparent') }}>
            <Header
                title={<HeaderTitleWithSubtitle />}
                headerRight={() => <HeaderRight />}
                headerLeft={() => <HeaderLeft showWorkflows={showWorkflows} />}
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
            headerLeft={() => <HeaderLeft showWorkflows={false} />}
            headerShadowVisible={false}
            headerBackgroundColor={theme.colors.background.canvas}
        />
    )
});

function HeaderRight() {
    const router = useRouter();
    const resolveNewSessionOrdinaryEntryRoute = useResolveNewSessionOrdinaryEntryRoute();
    const { theme } = useUnistyles();
    const touchTarget = resolveTouchTargetFloorPx() ?? 32;
    const gap = Math.max(0, touchTarget - 32);
    const handleNewSession = React.useCallback((event?: unknown) => {
        const { draftId, draftOrigin } = resolveNewSessionOrdinaryEntryRoute({
            forceFresh: shouldForceFreshNewSessionEntryFromPressEvent(event),
        });
        router.push({ pathname: '/new', params: { draftId, draftOrigin } });
    }, [resolveNewSessionOrdinaryEntryRoute, router]);

    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap }}>
        <AppShellThemeToggle buttonSize={32} glyphSize={22} color={theme.colors.chrome.header.foreground} interactiveTargetGapPx={gap} />
        <IconButton
            testID="home-header-start-new-session"
            onPress={handleNewSession}
            size={32}
            variant="plain"
            minimumInteractiveTargetSize={touchTarget}
            interactiveTargetGapPx={gap}
            accessibilityLabel={t('newSession.title')}
            icon={<Icon name="plus" size={29} color={theme.colors.chrome.header.foreground} />}
        />
      </View>
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
            accessibilityRole="button"
            accessibilityLabel={t('server.serverConfiguration')}
        >
            <Icon name="hard-drives" size={24} color={theme.colors.chrome.header.foreground} />
        </Pressable>
    );
}

function HeaderLeft(props: { showWorkflows: boolean }) {
    const router = useRouter();
    const updates = useSharedUpdatesSummary();
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const logo = (
        <View style={styles.logoContainer}>
            <Image
                source={theme.dark ? require('@/assets/images/logo-white.png') : require('@/assets/images/logo-black.png')}
                contentFit="contain"
                style={[{ width: 24, height: 24 }]}
            />
        </View>
    );
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {/* The phone's Updates entry sits where the logo is and pushes Settings › Updates; the
                logo returns when there is nothing to act on. */}
            {updates.visible ? (
                <UpdatesPopoverButton summary={updates} variant="header" testID="home-header-updates-pill" />
            ) : logo}
            {props.showWorkflows ? (
                <Pressable
                    onPress={() => router.push('/workflows')}
                    hitSlop={15}
                    style={styles.headerButton}
                    accessibilityRole="button"
                    accessibilityLabel={t('workflows.openCollection')}
                >
                    <Icon name="tree-structure" size={20} color={theme.colors.chrome.header.foreground} />
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
