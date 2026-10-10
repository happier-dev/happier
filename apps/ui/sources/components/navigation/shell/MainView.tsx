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
import { TabBarNewSessionButton } from '@/components/ui/navigation/TabBarNewSessionButton';
import { InboxView } from '@/components/navigation/shell/InboxView';
import { FriendsView } from '@/components/navigation/shell/FriendsView';
import { SessionsListWrapper } from '@/components/sessions/shell/SessionsListWrapper';
import { ProjectsListView } from '@/components/projects/ProjectsListView';
import { ExternalSessionsEmptyState } from '@/components/sessions/shell/ExternalSessionsEmptyState';
import { Header } from '@/components/navigation/Header';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { isUsingCustomServer } from '@/sync/domains/server/serverConfig';
import { trackFriendsSearch } from '@/track';
import { ConnectionStatusControl } from '@/components/navigation/ConnectionStatusControl';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { useWorkflowsDestinationAccess } from '@/components/workflows/gating/workflowsDestinationAccess';
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
import { Icon } from '@/components/ui/icons/Icon';
import { ActionOperationActivityButton } from '@/components/inbox/actionOperations/ActionOperationActivityButton';


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
        paddingHorizontal: 16,
    },
    sidebarContentContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
    },
    sidebarNewSession: {
        position: 'absolute',
        right: 12,
        bottom: 12,
    },
    titleContainer: {
        flex: 1,
        alignItems: 'flex-start',
        marginLeft: -4,
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
    const showWorkflows = useWorkflowsDestinationAccess().discoverable;
    if (activeTab === 'sessions') {
        return (
            <View style={styles.headerButtonsRow}>
                <ActionOperationActivityButton testID="main-header-action-operations" />
                {showWorkflows ? (
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
                {/* New sessions start from the glass "+" beside the tab bar: the one "+". */}
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
    const router = useRouter();
    const friendsEnabled = useFriendsEnabled();
    const inboxEnabled = useInboxAvailable();
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
