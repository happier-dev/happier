import * as React from 'react';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { View, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/platform/responsive';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { PhoneHomeLogoButton } from './PhoneHomeLogoButton';
import { HomeHub } from '@/components/hub/HomeHub';
import { useSessionListStorageKind } from '@/components/sessions/model/useSessionListStorageKind';
import { SessionsListStorageChrome } from '@/components/sessions/shell/SessionsListStorageChrome';
import { SIDEBAR_NEW_SESSION_INSET_PX, TabBarNewSessionButton } from '@/components/ui/navigation/TabBarNewSessionButton';
import { InboxView } from '@/components/navigation/shell/InboxView';
import { FriendsView } from '@/components/navigation/shell/FriendsView';
import { SessionsListWrapper } from '@/components/sessions/shell/SessionsListWrapper';
import { ProjectsListView } from '@/components/projects/ProjectsListView';
import { ExternalSessionsEmptyState } from '@/components/sessions/shell/ExternalSessionsEmptyState';
import { Header } from '@/components/navigation/Header';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { isUsingCustomServer } from '@/sync/domains/server/serverConfig';
import { trackFriendsSearch } from '@/track';
import { ConnectionStatusControl, type ConnectionStatusTriggerState } from '@/components/navigation/ConnectionStatusControl';
import { PhoneHomeLine } from './PhoneHomeLine';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { PhoneDestinationsMenu } from '@/components/appShell/destinations/PhoneDestinationsMenu';
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
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ActionOperationActivityButton } from '@/components/inbox/actionOperations/ActionOperationActivityButton';
import { PhoneTabNavRowProvider } from '@/components/navigation/shell/phoneTabNavRow';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useScreenSafeAreaBackdrop } from '@/components/navigation/safeArea/HorizontalSafeArea';
import { useSettingRevealRequested } from '@/components/settings/shell/SettingRow';
import { collectionSpaceSettingRefs } from '@/components/settings/session/collectionSpaceSettings';


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
    // The phone's main screen owns its plane; the session list lies transparent over it.
    phoneContainer: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    phoneHeaderContent: {
        paddingHorizontal: theme.space.s16,
    },
    sidebarContentContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
    },
    sidebarNewSession: {
        position: 'absolute',
        right: SIDEBAR_NEW_SESSION_INSET_PX,
        bottom: SIDEBAR_NEW_SESSION_INSET_PX,
    },
    titleContainer: {
        flex: 1,
        alignItems: 'flex-start',
        marginLeft: -4,
    },
    titleText: {
        ...Typography.variant('heading'),
        color: theme.colors.chrome.header.foreground,
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -2,
    },
    statusText: {
        ...Typography.variant('micro'),
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
        gap: theme.space.s2,
    },
    primaryPaneFallback: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: theme.space.s20,
        backgroundColor: theme.colors.background.canvas,
    },
    primaryPaneFallbackText: {
        textAlign: 'center',
        maxWidth: 520,
        color: theme.colors.text.secondary,
        ...Typography.variant('reading'),
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

/** Phone tabs whose page header draws the tab's name as its large title, so the bar does not repeat it. */
const TABS_WITH_PAGE_TITLE: ReadonlySet<ActiveTabType> = new Set(['inbox']);

// Header title component with connection status
const HeaderTitle = React.memo(({ activeTab }: { activeTab: ActiveTabType }) => {
    const { theme } = useUnistyles();

    return (
        <View style={styles.titleContainer}>
            {/* A tab whose page carries its own large title (lab `phone-P4`) leaves the bar to the Home it shows. */}
            {TABS_WITH_PAGE_TITLE.has(activeTab) ? null : (
                <Text style={styles.titleText}>
                    {t(TAB_TITLES[activeTab])}
                </Text>
            )}
            <ConnectionStatusControl variant="header" />
        </View>
    );
});

const renderPhoneHomeLine = (state: ConnectionStatusTriggerState) => <PhoneHomeLine state={state} />;
const SESSIONS_NAV_ROW_LEADING = <ConnectionStatusControl variant="header" renderTrigger={renderPhoneHomeLine} />;
const SessionsNavRowGlyphs = React.memo(function SessionsNavRowGlyphs() {
    return (
        <View style={styles.headerButtonsRow}>
            <ActionOperationActivityButton testID="main-header-action-operations" />
            <PhoneDestinationsMenu />
        </View>
    );
});
const SESSIONS_NAV_ROW_TRAILING = <SessionsNavRowGlyphs />;

/** The Sessions tab: the list under the safe area, carrying the shell's line in its own nav row. */
function PhoneSessionsTab(props: Readonly<{ backgroundColor: string; children: React.ReactNode }>) {
    const insets = useChromeSafeAreaInsets();
    return (
        <View style={[styles.phoneContainer, { backgroundColor: props.backgroundColor, paddingTop: insets.top }]}>
            <PhoneTabNavRowProvider leading={SESSIONS_NAV_ROW_LEADING} trailing={SESSIONS_NAV_ROW_TRAILING}>
                {props.children}
            </PhoneTabNavRowProvider>
        </View>
    );
}

// Header right button - varies by tab
const HeaderRight = React.memo(({ activeTab }: { activeTab: ActiveTabType }) => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const isCustomServer = isUsingCustomServer();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendsIdentityReady = friendsIdentityReadiness.isReady;
    if (activeTab === 'sessions') {
        return SESSIONS_NAV_ROW_TRAILING;
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
        return (
            <View style={styles.headerButton}>
                <ActionOperationActivityButton testID="main-header-action-operations" />
            </View>
        );
    }

    if (activeTab === 'projects') {
        return (
            <View style={styles.headerButton}>
                <ActionOperationActivityButton testID="main-header-action-operations" />
            </View>
        );
    }

    if (activeTab === 'settings') {
        if (!isCustomServer) {
            // Empty view to maintain header centering
            return (
                <View style={styles.headerButton}>
                    <ActionOperationActivityButton testID="main-header-action-operations" />
                </View>
            );
        }
        return (
            <View style={styles.headerButtonsRow}>
                <ActionOperationActivityButton testID="main-header-action-operations" />
                <Pressable
                    onPress={() => router.push('/settings/server')}
                    hitSlop={15}
                    accessibilityRole="button"
                    accessibilityLabel={t('server.serverConfiguration')}
                    style={styles.headerButton}
                >
                    <Icon name="hard-drives" size={24} color={theme.colors.chrome.header.foreground} />
                </Pressable>
            </View>
        );
    }

    return null;
});

export const MainView = React.memo(({ variant }: MainViewProps) => {
    const { theme } = useUnistyles();
    const { externalSessionsEnabled, storageKind } = useSessionListStorageKind();
    const isTablet = useIsTablet();
    const pathname = usePathname();

    if (variant === 'sidebar') {
        const surfaceOwnership = resolveSessionListSurfaceOwnership({
            ownerKey: SESSION_LIST_SURFACE_OWNER_SIDEBAR,
            interactiveOwnerKey: SESSION_LIST_SURFACE_OWNER_SIDEBAR,
            visible: true,
            interactive: resolveSidebarSessionListSurfaceInteractive(pathname),
        });
        const storageChrome = (
            <SessionsListStorageChrome
                storageKind={storageKind}
                column="sessions"
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
                    {/* The sidebar's one "+": the phone's glass button, over the list's bottom-right. */}
                    <View style={styles.sidebarNewSession}>
                        <TabBarNewSessionButton placement="sidebar" />
                    </View>
                </View>
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
    storageKind: 'all' | 'persisted' | 'direct';
    isTablet: boolean;
    themeGroupedBackground: string;
}>) => {
    const materialColor = useHappierMaterialColorResolver();
    const backgroundColor = materialColor(props.themeGroupedBackground, 'transparent');
    useScreenSafeAreaBackdrop(backgroundColor);
    const router = useRouter();
    const friendsEnabled = useFriendsEnabled();
    const inboxEnabled = useInboxAvailable();
    const { activeTab, setActiveTab, isLoading } = useMainAppTabState();
    const filtersRequested = useSettingRevealRequested([collectionSpaceSettingRefs('sessionWork').filters]);

    React.useEffect(() => {
        if (filtersRequested && !isLoading) void setActiveTab('sessions');
    }, [filtersRequested, isLoading, setActiveTab]);

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
                    <View style={[styles.primaryPaneFallback, { backgroundColor }]}>
                        <ExternalSessionsEmptyState surface="primaryPane" />
                    </View>
                );
            }
            // The empty main pane is the app home hub (it shows the getting-started guidance until a
            // machine can run a session).
            return <HomeHub />;
        }
        return (
            <View testID="mainview-tablet-primary-pane-fallback" style={[styles.primaryPaneFallback, { backgroundColor }]}>
                <Text style={styles.primaryPaneFallbackText}>
                    {t('components.emptyMainScreen.readyToCode')}
                </Text>
            </View>
        );
    }

    if (headerTab === 'sessions') {
        return <PhoneSessionsTab backgroundColor={backgroundColor}>{renderTabContent()}</PhoneSessionsTab>;
    }

    return (
        <View style={[styles.phoneContainer, { backgroundColor }]}>
            <View style={{ backgroundColor }}>
                <Header
                    title={<HeaderTitle activeTab={headerTab} />}
                    headerRight={() => <HeaderRight activeTab={headerTab} />}
                    headerLeft={() => <PhoneHomeLogoButton />}
                    headerContentStyle={styles.phoneHeaderContent}
                    headerShadowVisible={false}
                    headerTransparent={true}
                />
            </View>
            {renderTabContent()}
        </View>
    );
});
