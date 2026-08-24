import * as React from 'react';
import { View, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSocketStatus } from '@/sync/domains/state/storage';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    useVisibleSessionListPaneState,
} from '@/hooks/session/useVisibleSessionListViewData';
import { useIsTablet } from '@/utils/platform/responsive';
import { usePathname, useRouter } from 'expo-router';
import { SessionGettingStartedGuidance } from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { HiddenInactiveSessionsEmptyState } from '@/components/sessions/guidance/HiddenInactiveSessionsEmptyState';
import { SessionsListContent } from '@/components/sessions/shell/SessionsList';
import { readSessionIdFromPathname } from '@/components/sessions/shell/readSessionIdFromPathname';
import { useSessionListStorageKind } from '@/components/sessions/model/useSessionListStorageKind';
import { SessionsListStorageChrome } from '@/components/sessions/shell/SessionsListStorageChrome';
import {
    resolveSessionListSurfaceOwnership,
    resolveSidebarSessionListSurfaceInteractive,
    SESSION_LIST_SURFACE_OWNER_SIDEBAR,
} from '@/components/sessions/shell/surface/sessionListSurfaceOwnership';
import { FABWide } from '@/components/ui/buttons/FABWide';
import { InboxView } from '@/components/navigation/shell/InboxView';
import { FriendsView } from '@/components/navigation/shell/FriendsView';
import { SessionsListWrapper } from '@/components/sessions/shell/SessionsListWrapper';
import { Header } from '@/components/navigation/Header';
import { HeaderLogo } from '@/components/ui/navigation/HeaderLogo';
import { VoiceSurface } from '@/components/voice/surface/VoiceSurface';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { isUsingCustomServer } from '@/sync/domains/server/serverConfig';
import { trackFriendsSearch } from '@/track';
import { ConnectionStatusControl } from '@/components/navigation/ConnectionStatusControl';
import { ActionOperationActivityButton } from '@/components/inbox/actionOperations/ActionOperationActivityButton';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useInboxAvailable } from '@/hooks/inbox/useInboxAvailable';
import { useTabState } from '@/hooks/ui/useTabState';
import { Text } from '@/components/ui/text/Text';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import type { FeatureId } from '@happier-dev/protocol';
import { Icon } from '@/components/ui/icons/Icon';
import {
    shouldForceFreshNewSessionEntryFromPressEvent,
    useResolveNewSessionOrdinaryEntryRoute,
} from '@/components/sessions/new/navigation/newSessionOrdinaryEntryRoute';


interface MainViewProps {
    variant: 'phone' | 'sidebar';
}

type MainViewLoadedProps = MainViewProps & Readonly<{
    isTablet: boolean;
    pathname: string;
}>;

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    sidebarContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
    },
    phoneContainer: {
        flex: 1,
    },
    sidebarContentContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
    },
    loadingContainerWrapper: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingBottom: 32,
    },
    tabletLoadingContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    emptyStateContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        flexDirection: 'column',
        backgroundColor: theme.colors.background.canvas,
    },
    emptyStateContentContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
    },
    sidebarEmptyHintContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'flex-start',
        paddingHorizontal: 16,
        paddingTop: 24,
        gap: 8,
    },
    sidebarEmptyHintTitle: {
        fontSize: 15,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    sidebarEmptyHintSubtitle: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        textAlign: 'center',
        ...Typography.default(),
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
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -2,
    },
    statusText: {
        fontSize: 11,
        lineHeight: 16,
        ...Typography.default(),
    },
    headerButton: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerButtonsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
    primaryPaneFallback: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 20,
        backgroundColor: theme.colors.background.canvas,
    },
    primaryPaneFallbackText: {
        textAlign: 'center',
        maxWidth: 520,
        color: theme.colors.text.secondary,
        fontSize: 15,
        ...Typography.default(),
    },
}));

const SESSION_GETTING_STARTED_GUIDANCE_FEATURE_ID = 'app.ui.sessionGettingStartedGuidance' as const satisfies FeatureId;

// Tab header configuration (zen excluded as that tab is disabled)
const TAB_TITLES = {
    sessions: 'tabs.sessions',
    inbox: 'tabs.inbox',
    friends: 'tabs.friends',
    settings: 'tabs.settings',
} as const;

// Active tabs (excludes zen which is disabled)
type ActiveTabType = 'sessions' | 'inbox' | 'friends' | 'settings';

// Header title component with connection status
const HeaderTitle = React.memo(({ activeTab }: { activeTab: ActiveTabType }) => {
    const { theme } = useUnistyles();

    return (
        <View style={styles.titleContainer}>
            <Text style={styles.titleText}>
                {t(TAB_TITLES[activeTab])}
            </Text>
            <ConnectionStatusControl variant="header" />
        </View>
    );
});

// Header right button - varies by tab
const HeaderRight = React.memo(({ activeTab }: { activeTab: ActiveTabType }) => {
    const router = useRouter();
    const resolveNewSessionOrdinaryEntryRoute = useResolveNewSessionOrdinaryEntryRoute();
    const { theme } = useUnistyles();
    const isCustomServer = isUsingCustomServer();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendsIdentityReady = friendsIdentityReadiness.isReady;
    const automationsSupport = useAutomationsSupport();
    const showAutomations = automationsSupport?.enabled !== false;
    const handleNewSession = React.useCallback((event?: unknown) => {
        const { draftId, draftOrigin } = resolveNewSessionOrdinaryEntryRoute({
            forceFresh: shouldForceFreshNewSessionEntryFromPressEvent(event),
        });
        router.push({ pathname: '/new', params: { draftId, draftOrigin } });
    }, [resolveNewSessionOrdinaryEntryRoute, router]);

    if (activeTab === 'sessions') {
        return (
            <View style={styles.headerButtonsRow}>
                <ActionOperationActivityButton testID="main-header-action-operations" />
                {showAutomations ? (
                    <Pressable
                        onPress={() => router.push('/automations')}
                        hitSlop={15}
                        style={styles.headerButton}
                    >
                        <Icon name="timer" size={20} color={theme.colors.chrome.header.foreground} />
                    </Pressable>
                ) : null}
                <Pressable
                    testID="main-header-start-new-session"
                    onPress={handleNewSession}
                    hitSlop={15}
                    style={styles.headerButton}
                >
                    <Icon name="plus" size={29} color={theme.colors.chrome.header.foreground} />
                </Pressable>
            </View>
        );
    }

    if (activeTab === 'friends') {
        return (
            <View style={styles.headerButtonsRow}>
                <ActionOperationActivityButton testID="main-header-action-operations" />
                <Pressable
                    onPress={() => {
                        trackFriendsSearch();
                        router.push('/friends/search');
                    }}
                    hitSlop={15}
                    style={[styles.headerButton, { opacity: friendsIdentityReady ? 1 : 0.5 }]}
                    disabled={!friendsIdentityReady}
                    accessibilityState={{ disabled: !friendsIdentityReady }}
                >
                    <Icon name="user-plus" size={24} color={theme.colors.chrome.header.foreground} />
                </Pressable>
            </View>
        );
    }

    if (activeTab === 'inbox') {
        return <ActionOperationActivityButton testID="main-header-action-operations" />;
    }

    if (activeTab === 'settings') {
        if (!isCustomServer) {
            // Empty view to maintain header centering
            return <ActionOperationActivityButton testID="main-header-action-operations" />;
        }
        return (
            <View style={styles.headerButtonsRow}>
                <ActionOperationActivityButton testID="main-header-action-operations" />
                <Pressable
                    onPress={() => router.push('/settings/server')}
                    hitSlop={15}
                    style={styles.headerButton}
                >
                    <Icon name="hard-drives" size={24} color={theme.colors.chrome.header.foreground} />
                </Pressable>
            </View>
        );
    }

    return null;
});

const SidebarMainViewContent = React.memo(function SidebarMainViewContent({
    isTablet,
    pathname,
}: Readonly<{
    isTablet: boolean;
    pathname: string;
}>) {
    const { theme } = useUnistyles();
    const { directSessionsEnabled, storageKind, setStorageKind } = useSessionListStorageKind();
    const router = useRouter();
    const resolveNewSessionOrdinaryEntryRoute = useResolveNewSessionOrdinaryEntryRoute();
    const activeSessionId = React.useMemo(() => readSessionIdFromPathname(pathname), [pathname]);
    const surfaceOwnership = React.useMemo(
        () => resolveSessionListSurfaceOwnership({
            ownerKey: SESSION_LIST_SURFACE_OWNER_SIDEBAR,
            interactiveOwnerKey: SESSION_LIST_SURFACE_OWNER_SIDEBAR,
            visible: true,
            interactive: resolveSidebarSessionListSurfaceInteractive(pathname),
        }),
        [pathname],
    );
    const {
        sessionListViewData,
        visibleSessionCount,
        hasHiddenInactiveSessions,
    } = useVisibleSessionListPaneState(storageKind, {
        activeSessionId,
        sessionListSurfaceDataActive: surfaceOwnership.dataActive,
    });

    const handleNewSession = React.useCallback((event?: unknown) => {
        const { draftId, draftOrigin } = resolveNewSessionOrdinaryEntryRoute({
            forceFresh: shouldForceFreshNewSessionEntryFromPressEvent(event),
        });
        router.push({ pathname: '/new', params: { draftId, draftOrigin } });
    }, [resolveNewSessionOrdinaryEntryRoute, router]);

    const storageChrome = (
        <SessionsListStorageChrome
            directSessionsEnabled={directSessionsEnabled}
            storageKind={storageKind}
            onSelectStorageKind={setStorageKind}
        />
    );

    let content: React.ReactNode;
    if (sessionListViewData === null) {
        content = (
            <View style={styles.sidebarContainer}>
                {storageChrome}
                <View style={styles.sidebarContentContainer}>
                    <View style={styles.tabletLoadingContainer}>
                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    </View>
                </View>
            </View>
        );
    } else if (visibleSessionCount === 0) {
        const suppressSidebarGuidance = isTablet && pathname === '/';
        content = (
            <View style={styles.sidebarContainer}>
                {storageChrome}
                <View style={styles.sidebarContentContainer}>
                    <View style={styles.emptyStateContainer}>
                        {hasHiddenInactiveSessions ? (
                            <HiddenInactiveSessionsEmptyState />
                        ) : suppressSidebarGuidance ? (
                            <View style={styles.sidebarEmptyHintContainer}>
                                <Text style={styles.sidebarEmptyHintTitle}>{t('components.emptySessionsTablet.noActiveSessions')}</Text>
                                <Text style={styles.sidebarEmptyHintSubtitle}>{t('components.emptySessionsTablet.startNewSessionDescription')}</Text>
                            </View>
                        ) : (
                            <SessionGettingStartedGuidance variant="sidebar" />
                        )}
                    </View>
                </View>
            </View>
        );
    } else {
        content = (
            <View style={styles.sidebarContainer}>
                {storageChrome}
                <View style={styles.sidebarContentContainer}>
                    <SessionsListContent
                        storageKind={storageKind}
                        data={sessionListViewData}
                        pathname={pathname}
                        surfaceOwnership={surfaceOwnership}
                    />
                </View>
            </View>
        );
    }

    return (
        <>
            {content}
            <FABWide onPress={handleNewSession} />
        </>
    );
});

const PhoneMainViewContent = React.memo(function PhoneMainViewContent({
    isTablet,
    pathname,
}: Readonly<{
    isTablet: boolean;
    pathname: string;
}>) {
    return <PhoneTabbedMainViewContent isTablet={isTablet} pathname={pathname} />;
});

const PhoneTabbedMainViewContent = React.memo(function PhoneTabbedMainViewContent({
    isTablet,
    pathname,
}: Readonly<{
    isTablet: boolean;
    pathname: string;
}>) {
    const { theme } = useUnistyles();
    const friendsEnabled = useFriendsEnabled();
    const inboxEnabled = useInboxAvailable();
    const voiceEnabled = useFeatureEnabled('voice');
    // Tab state management
    // NOTE: Zen tab removed - the feature never got to a useful state
    const { activeTab, setActiveTab } = useTabState();
    const routePinnedPhoneTab: ActiveTabType | null = pathname === '/' ? 'sessions' : null;
    const effectiveActiveTab = routePinnedPhoneTab ?? activeTab;

    React.useEffect(() => {
        if (routePinnedPhoneTab !== null) return;
        if (!inboxEnabled && activeTab === 'inbox') {
            void setActiveTab('sessions');
            return;
        }

        if (friendsEnabled) return;
        if (activeTab !== 'friends') return;
        void setActiveTab('sessions');
    }, [activeTab, friendsEnabled, inboxEnabled, routePinnedPhoneTab, setActiveTab]);

    const headerTab: ActiveTabType = React.useMemo(() => {
        const normalized = (effectiveActiveTab === 'inbox' || effectiveActiveTab === 'friends' || effectiveActiveTab === 'sessions' || effectiveActiveTab === 'settings')
            ? effectiveActiveTab
            : 'sessions';
        if (!inboxEnabled && normalized === 'inbox') return 'sessions';
        if (!friendsEnabled && normalized === 'friends') return 'sessions';
        return normalized;
    }, [effectiveActiveTab, friendsEnabled, inboxEnabled]);

    const renderTabContent = React.useCallback(() => {
        switch (effectiveActiveTab) {
            case 'inbox':
                return inboxEnabled ? <InboxView /> : <SessionsListWrapper />;
            case 'friends':
                return friendsEnabled ? <FriendsView /> : <SessionsListWrapper />;
            case 'sessions':
            default:
                return <SessionsListWrapper pathname="/" />;
        }
    }, [effectiveActiveTab, friendsEnabled, inboxEnabled]);

    if (isTablet) {
        const buildPolicyDecision = getFeatureBuildPolicyDecision(SESSION_GETTING_STARTED_GUIDANCE_FEATURE_ID);
        if (buildPolicyDecision !== 'deny') {
            return <SessionGettingStartedGuidance variant="primaryPane" />;
        }
        return (
            <View testID="mainview-tablet-primary-pane-fallback" style={styles.primaryPaneFallback}>
                <Text style={styles.primaryPaneFallbackText}>
                    {t('components.emptyMainScreen.readyToCode')}
                </Text>
            </View>
        );
    }

    return (
        <View style={styles.phoneContainer}>
            <View style={{ backgroundColor: theme.colors.background.canvas }}>
                <Header
                    title={<HeaderTitle activeTab={headerTab} />}
                    headerRight={() => <HeaderRight activeTab={headerTab} />}
                    headerLeft={() => <HeaderLogo />}
                    headerShadowVisible={false}
                    headerTransparent={true}
                />
                {voiceEnabled ? <VoiceSurface variant="sidebar" /> : null}
            </View>
            {renderTabContent()}
        </View>
    );
});

const MainViewLoaded = React.memo(({ variant, isTablet, pathname }: MainViewLoadedProps) => {
    if (variant === 'sidebar') {
        return <SidebarMainViewContent isTablet={isTablet} pathname={pathname} />;
    }
    return <PhoneMainViewContent isTablet={isTablet} pathname={pathname} />;
});

export const MainView = React.memo((props: MainViewProps) => {
    const pathname = usePathname();
    const isTablet = useIsTablet();
    return <MainViewLoaded {...props} pathname={pathname} isTablet={isTablet} />;
});
