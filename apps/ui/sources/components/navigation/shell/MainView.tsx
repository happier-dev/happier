import * as React from 'react';
import { View, ActivityIndicator, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useFriendRequests, useSocketStatus } from '@/sync/domains/state/storage';
import { useVisibleSessionListViewData } from '@/hooks/session/useVisibleSessionListViewData';
import { useIsTablet } from '@/utils/platform/responsive';
import { usePathname, useRouter } from 'expo-router';
import { SessionGettingStartedGuidance } from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { SessionsList } from '@/components/sessions/shell/SessionsList';
import { FABWide } from '@/components/ui/buttons/FABWide';
import { TabBar, TabType } from '@/components/ui/navigation/TabBar';
import { InboxView } from '@/components/navigation/shell/InboxView';
import { SettingsViewWrapper } from '@/components/settings/shell/SettingsViewWrapper';
import { SessionsListWrapper } from '@/components/sessions/shell/SessionsListWrapper';
import { Header } from '@/components/navigation/Header';
import { HeaderLogo } from '@/components/ui/navigation/HeaderLogo';
import { VoiceSurface } from '@/components/voice/surface/VoiceSurface';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { isUsingCustomServer } from '@/sync/domains/server/serverConfig';
import { trackFriendsSearch } from '@/track';
import { ConnectionStatusControl } from '@/components/navigation/ConnectionStatusControl';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useTabState } from '@/hooks/ui/useTabState';
import { Text } from '@/components/ui/text/Text';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import type { FeatureId } from '@happier-dev/protocol';


interface MainViewProps {
    variant: 'phone' | 'sidebar';
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
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
        backgroundColor: theme.colors.groupped.background,
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
        backgroundColor: theme.colors.groupped.background,
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
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    sidebarEmptyHintSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
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
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -2,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '500',
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
        backgroundColor: theme.colors.groupped.background,
    },
    primaryPaneFallbackText: {
        textAlign: 'center',
        maxWidth: 520,
        color: theme.colors.textSecondary,
        fontSize: 15,
        ...Typography.default(),
    },
}));

const SESSION_GETTING_STARTED_GUIDANCE_FEATURE_ID = 'app.ui.sessionGettingStartedGuidance' as const satisfies FeatureId;

// Tab header configuration (zen excluded as that tab is disabled)
const TAB_TITLES = {
    sessions: 'tabs.sessions',
    inbox: 'tabs.inbox',
    settings: 'tabs.settings',
} as const;

// Active tabs (excludes zen which is disabled)
type ActiveTabType = 'sessions' | 'inbox' | 'settings';

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
    const { theme } = useUnistyles();
    const isCustomServer = isUsingCustomServer();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendsIdentityReady = friendsIdentityReadiness.isReady;
    const automationsSupport = useAutomationsSupport();
    const showAutomations = automationsSupport?.enabled !== false;

    if (activeTab === 'sessions') {
        return (
            <View style={styles.headerButtonsRow}>
                {showAutomations ? (
                    <Pressable
                        onPress={() => router.push('/automations')}
                        hitSlop={15}
                        style={styles.headerButton}
                    >
                        <Ionicons name="timer-outline" size={22} color={theme.colors.header.tint} />
                    </Pressable>
                ) : null}
                <Pressable
                    testID="main-header-start-new-session"
                    onPress={() => router.push('/new')}
                    hitSlop={15}
                    style={styles.headerButton}
                >
                    <Ionicons name="add-outline" size={28} color={theme.colors.header.tint} />
                </Pressable>
            </View>
        );
    }

    if (activeTab === 'inbox') {
        return (
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
                <Ionicons name="person-add-outline" size={24} color={theme.colors.header.tint} />
            </Pressable>
        );
    }

    if (activeTab === 'settings') {
        if (!isCustomServer) {
            // Empty view to maintain header centering
            return <View style={styles.headerButton} />;
        }
        return (
            <Pressable
                onPress={() => router.push('/server')}
                hitSlop={15}
                style={styles.headerButton}
            >
                <Ionicons name="server-outline" size={24} color={theme.colors.header.tint} />
            </Pressable>
        );
    }

    return null;
});

export const MainView = React.memo(({ variant }: MainViewProps) => {
    const { theme } = useUnistyles();
    const sessionListViewData = useVisibleSessionListViewData();
    const isTablet = useIsTablet();
    const router = useRouter();
    const pathname = usePathname();
    const friendRequests = useFriendRequests();
    const inboxFriendsEnabled = useFriendsEnabled();
    const voiceEnabled = useFeatureEnabled('voice');
    // Tab state management
    // NOTE: Zen tab removed - the feature never got to a useful state
    const { activeTab, setActiveTab } = useTabState();

    React.useEffect(() => {
        if (inboxFriendsEnabled) return;
        if (activeTab !== 'inbox') return;
        void setActiveTab('sessions');
    }, [activeTab, inboxFriendsEnabled, setActiveTab]);

    const headerTab: ActiveTabType = React.useMemo(() => {
        const normalized = (activeTab === 'inbox' || activeTab === 'sessions' || activeTab === 'settings')
            ? activeTab
            : 'sessions';
        if (!inboxFriendsEnabled && normalized === 'inbox') return 'sessions';
        return normalized;
    }, [activeTab, inboxFriendsEnabled]);

    const handleNewSession = React.useCallback(() => {
        router.push('/new');
    }, [router]);

    const handleTabPress = React.useCallback((tab: TabType) => {
        void setActiveTab(tab);
    }, [setActiveTab]);

    // Regular phone mode with tabs - define this before any conditional returns
    const renderTabContent = React.useCallback(() => {
        switch (activeTab) {
            case 'inbox':
                return inboxFriendsEnabled ? <InboxView /> : <SessionsListWrapper />;
            case 'settings':
                return <SettingsViewWrapper />;
            case 'sessions':
            default:
                return <SessionsListWrapper />;
        }
    }, [activeTab, inboxFriendsEnabled]);

    // Sidebar variant
    if (variant === 'sidebar') {
        // Loading state
        if (sessionListViewData === null) {
            return (
                <View style={styles.sidebarContentContainer}>
                    <View style={styles.tabletLoadingContainer}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                </View>
            );
        }

        // Empty state
        if (sessionListViewData.length === 0) {
            const suppressSidebarGuidance = isTablet && pathname === '/';
            return (
                <View style={styles.sidebarContentContainer}>
                    <View style={styles.emptyStateContainer}>
                        {suppressSidebarGuidance ? (
                            <View style={styles.sidebarEmptyHintContainer}>
                                <Text style={styles.sidebarEmptyHintTitle}>{t('components.emptySessionsTablet.noActiveSessions')}</Text>
                                <Text style={styles.sidebarEmptyHintSubtitle}>{t('components.emptySessionsTablet.startNewSessionDescription')}</Text>
                            </View>
                        ) : (
                            <SessionGettingStartedGuidance variant="sidebar" />
                        )}
                    </View>
                </View>
            );
        }

        // Sessions list
        return (
            <View style={styles.sidebarContentContainer}>
                <SessionsList />
            </View>
        );
    }

    // Phone variant
    // Tablet in phone mode - special case (when showing index view on tablets, show empty view)
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

    // Regular phone mode with tabs
    return (
        <>
            <View style={styles.phoneContainer}>
                <View style={{ backgroundColor: theme.colors.groupped.background }}>
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
            <TabBar
                activeTab={activeTab}
                onTabPress={handleTabPress}
                inboxBadgeCount={friendRequests.length}
            />
        </>
    );
});
