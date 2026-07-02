import * as React from 'react';
import { View, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/platform/responsive';
import { usePathname, useRouter } from 'expo-router';
import { SessionGettingStartedGuidance } from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { useSessionListStorageKind } from '@/components/sessions/model/useSessionListStorageKind';
import { SessionsListStorageChrome } from '@/components/sessions/shell/SessionsListStorageChrome';
import { FABWide } from '@/components/ui/buttons/FABWide';
import { InboxView } from '@/components/navigation/shell/InboxView';
import { FriendsView } from '@/components/navigation/shell/FriendsView';
import { SessionsListWrapper } from '@/components/sessions/shell/SessionsListWrapper';
import { ProjectsListView } from '@/components/projects/ProjectsListView';
import { ExternalSessionsEmptyState } from '@/components/sessions/shell/ExternalSessionsEmptyState';
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
import { useInboxAvailable } from '@/hooks/inbox/useInboxAvailable';
import { Text } from '@/components/ui/text/Text';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import type { FeatureId } from '@happier-dev/protocol';
import { SessionsListPaneContent } from '@/components/sessions/shell/SessionsListPaneContent';
import {
    resolveSidebarSessionListSurfaceInteractive,
    resolveSessionListSurfaceOwnership,
    SESSION_LIST_SURFACE_OWNER_SIDEBAR,
} from '@/components/sessions/shell/surface/sessionListSurfaceOwnership';
import { useMainAppTabState } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';


interface MainViewProps {
    variant: 'phone' | 'sidebar';
}

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
    projects: 'tabs.projects',
    inbox: 'tabs.inbox',
    friends: 'tabs.friends',
    settings: 'tabs.settings',
} as const;

// Active tabs (excludes zen which is disabled)
type ActiveTabType = 'sessions' | 'projects' | 'inbox' | 'friends' | 'settings';

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
                        <Ionicons name="timer-outline" size={22} color={theme.colors.chrome.header.foreground} />
                    </Pressable>
                ) : null}
                <Pressable
                    testID="main-header-start-new-session"
                    onPress={() => router.push('/new')}
                    hitSlop={15}
                    style={styles.headerButton}
                >
                    <Ionicons name="add-outline" size={28} color={theme.colors.chrome.header.foreground} />
                </Pressable>
            </View>
        );
    }

    if (activeTab === 'friends') {
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
                <Ionicons name="person-add-outline" size={24} color={theme.colors.chrome.header.foreground} />
            </Pressable>
        );
    }

    if (activeTab === 'inbox') {
        return <View style={styles.headerButton} />;
    }

    if (activeTab === 'projects') {
        // Empty view to maintain header centering (project add flow lands in Phase 4.2).
        return <View style={styles.headerButton} />;
    }

    if (activeTab === 'settings') {
        if (!isCustomServer) {
            // Empty view to maintain header centering
            return <View style={styles.headerButton} />;
        }
        return (
            <Pressable
                onPress={() => router.push('/settings/server')}
                hitSlop={15}
                style={styles.headerButton}
            >
                <Ionicons name="server-outline" size={24} color={theme.colors.chrome.header.foreground} />
            </Pressable>
        );
    }

    return null;
});

export const MainView = React.memo(({ variant }: MainViewProps) => {
    const { theme } = useUnistyles();
    const { externalSessionsEnabled, storageKind, setStorageKind } = useSessionListStorageKind();
    const isTablet = useIsTablet();
    const router = useRouter();
    const pathname = usePathname();

    const handleNewSession = React.useCallback(() => {
        router.push('/new');
    }, [router]);

    if (variant === 'sidebar') {
        const surfaceOwnership = resolveSessionListSurfaceOwnership({
            ownerKey: SESSION_LIST_SURFACE_OWNER_SIDEBAR,
            interactiveOwnerKey: SESSION_LIST_SURFACE_OWNER_SIDEBAR,
            visible: true,
            interactive: resolveSidebarSessionListSurfaceInteractive(pathname),
        });
        const storageChrome = (
            <SessionsListStorageChrome
                externalSessionsEnabled={externalSessionsEnabled}
                storageKind={storageKind}
                onSelectStorageKind={setStorageKind}
            />
        );

        return (
            <>
                <View style={styles.sidebarContainer}>
                    {storageChrome}
                    <View style={styles.sidebarContentContainer}>
                        <SessionsListPaneContent
                            storageKind={storageKind}
                            fallbackGuidanceVariant="sidebar"
                            surfaceOwnership={surfaceOwnership}
                        />
                    </View>
                </View>
                <FABWide onPress={handleNewSession} />
            </>
        );
    }

    return (
        <PhoneMainView
            externalSessionsEnabled={externalSessionsEnabled}
            storageKind={storageKind}
            isTablet={isTablet}
            themeGroupedBackground={theme.colors.background.canvas}
        />
    );
});

const PhoneMainView = React.memo((props: Readonly<{
    externalSessionsEnabled: boolean;
    storageKind: 'persisted' | 'direct';
    isTablet: boolean;
    themeGroupedBackground: string;
}>) => {
    const router = useRouter();
    const friendsEnabled = useFriendsEnabled();
    const inboxEnabled = useInboxAvailable();
    const voiceEnabled = useFeatureEnabled('voice');
    const { activeTab, setActiveTab } = useMainAppTabState();

    React.useEffect(() => {
        if (!inboxEnabled && activeTab === 'inbox') {
            void setActiveTab('sessions');
            return;
        }

        if (friendsEnabled) return;
        if (activeTab !== 'friends') return;
        void setActiveTab('sessions');
    }, [activeTab, friendsEnabled, inboxEnabled, setActiveTab]);

    const headerTab: ActiveTabType = React.useMemo(() => {
        const normalized = (activeTab === 'inbox' || activeTab === 'friends' || activeTab === 'projects' || activeTab === 'sessions' || activeTab === 'settings')
            ? activeTab
            : 'sessions';
        if (!inboxEnabled && normalized === 'inbox') return 'sessions';
        if (!friendsEnabled && normalized === 'friends') return 'sessions';
        return normalized;
    }, [activeTab, friendsEnabled, inboxEnabled]);

    const renderTabContent = React.useCallback(() => {
        switch (activeTab) {
            case 'inbox':
                return inboxEnabled ? <InboxView /> : <SessionsListWrapper pathname="/" />;
            case 'friends':
                return friendsEnabled ? <FriendsView /> : <SessionsListWrapper pathname="/" />;
            case 'projects':
                return <ProjectsListView />;
            case 'sessions':
            default:
                return <SessionsListWrapper pathname="/" />;
        }
    }, [activeTab, friendsEnabled, inboxEnabled]);

    if (props.isTablet) {
        const buildPolicyDecision = getFeatureBuildPolicyDecision(SESSION_GETTING_STARTED_GUIDANCE_FEATURE_ID);
        if (buildPolicyDecision !== 'deny') {
            if (props.externalSessionsEnabled && props.storageKind === 'direct') {
                return (
                    <View style={styles.primaryPaneFallback}>
                        <ExternalSessionsEmptyState surface="primaryPane" />
                    </View>
                );
            }
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
            <View style={{ backgroundColor: props.themeGroupedBackground }}>
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
