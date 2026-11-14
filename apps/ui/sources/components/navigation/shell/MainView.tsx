import * as React from 'react';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/platform/responsive';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';
import { HomeHub } from '@/components/hub/HomeHub';
import { useSessionListViewFilterController } from '@/components/sessions/shell/search/useSessionListViewFilterController';
import { SessionsListStorageChrome } from '@/components/sessions/shell/SessionsListStorageChrome';
import { SIDEBAR_NEW_SESSION_INSET_PX, TabBarNewSessionButton } from '@/components/ui/navigation/TabBarNewSessionButton';
import { InboxView } from '@/components/navigation/shell/InboxView';
import { SessionsListWrapper } from '@/components/sessions/shell/SessionsListWrapper';
import { ProjectsListView } from '@/components/projects/ProjectsListView';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { ExternalSessionsEmptyState } from '@/components/sessions/shell/ExternalSessionsEmptyState';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useInboxAvailable } from '@/hooks/inbox/useInboxAvailable';
import { Text } from '@/components/ui/text/Text';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';
import { SessionsListPaneContent } from '@/components/sessions/shell/SessionsListPaneContent';
import {
    resolveSidebarSessionListSurfaceInteractive,
    resolveSessionListSurfaceOwnership,
    SESSION_LIST_SURFACE_OWNER_SIDEBAR,
} from '@/components/sessions/shell/surface/sessionListSurfaceOwnership';
import { useMainAppTabState } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { PhoneMainTabLine, PhoneMainTabShell } from '@/components/navigation/shell/PhoneMainTabLine';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useScreenSafeAreaBackdrop } from '@/components/navigation/safeArea/HorizontalSafeArea';
import { useSettingRevealRequested } from '@/components/settings/shell/SettingRow';
import { collectionSpaceSettingRefs } from '@/components/settings/session/collectionSpaceSettings';

/**
 * The Sessions column's own rows (pinned boards, its destinations). The list draws them under its title, so the
 * title leads the column on the shell's title row. One element, so the list's memo boundaries hold across renders.
 */
const SIDEBAR_COLUMN_ROWS = <SessionsListStorageChrome column="sessions" />;

/**
 * The phone's home-route tab bodies take no props from the tab host, so each is one element: a switch then leaves the
 * suspended tabs' memo boundaries untouched. Rebuilt elements re-suspended both frozen tabs while a third first
 * mounted, which cascaded ~500 empty commits (web phone viewport) and never drained under act.
 */
const PHONE_SESSIONS_TAB = <SessionsListWrapper pathname="/" />;
const PHONE_PROJECTS_TAB = <ProjectsListView />;
const PHONE_INBOX_TAB = <InboxView />;

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
        backgroundColor: theme.colors.surface.base,
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
    primaryPaneFallback: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: theme.space.s20,
        backgroundColor: theme.colors.surface.base,
    },
    primaryPaneFallbackText: {
        textAlign: 'center',
        maxWidth: 520,
        color: theme.colors.text.secondary,
        ...Typography.variant('reading'),
    },
}));

const SESSION_GETTING_STARTED_GUIDANCE_FEATURE_ID = 'app.ui.sessionGettingStartedGuidance' as const satisfies FeatureId;

// The home route's tabs; Workflows is its own route (owner Q4).
type ActiveTabType = 'sessions' | 'projects' | 'inbox';


export const MainView = React.memo(({ variant }: MainViewProps) => {
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    const pathname = usePathname();

    if (variant === 'sidebar') {
        const surfaceOwnership = resolveSessionListSurfaceOwnership({
            ownerKey: SESSION_LIST_SURFACE_OWNER_SIDEBAR,
            interactiveOwnerKey: SESSION_LIST_SURFACE_OWNER_SIDEBAR,
            visible: true,
            interactive: resolveSidebarSessionListSurfaceInteractive(pathname),
        });
        return (
            <>
                <View style={styles.sidebarContainer}>
                    <View style={styles.sidebarContentContainer}>
                        <SessionsListPaneContent
                            fallbackGuidanceVariant="sidebar"
                            surfaceOwnership={surfaceOwnership}
                            leading={SIDEBAR_COLUMN_ROWS}
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
            isTablet={isTablet}
            themeGroupedBackground={theme.colors.surface.base}
        />
    );
});

function TabletSessionHome(props: Readonly<{ backgroundColor: string }>) {
    const filters = useSessionListViewFilterController();
    if (filters.sourceAvailable && filters.displayFilters.source === 'direct') {
        return <View style={[styles.container, { backgroundColor: props.backgroundColor }]}><ExternalSessionsEmptyState /></View>;
    }
    if (getFeatureBuildPolicyDecision(SESSION_GETTING_STARTED_GUIDANCE_FEATURE_ID) !== 'deny') return <HomeHub />;
    return (
        <View testID="mainview-tablet-primary-pane-fallback" style={[styles.primaryPaneFallback, { backgroundColor: props.backgroundColor }]}>
            <Text style={styles.primaryPaneFallbackText}>{t('components.emptyMainScreen.readyToCode')}</Text>
        </View>
    );
}

const PhoneMainView = React.memo((props: Readonly<{
    isTablet: boolean;
    themeGroupedBackground: string;
}>) => {
    const materialColor = useHappierMaterialColorResolver();
    const backgroundColor = materialColor(props.themeGroupedBackground, 'transparent');
    const insets = useChromeSafeAreaInsets();
    useScreenSafeAreaBackdrop(backgroundColor);
    const inboxEnabled = useInboxAvailable();
    const { activeTab, setActiveTab, isLoading } = useMainAppTabState();
    const filtersRequested = useSettingRevealRequested([collectionSpaceSettingRefs('sessionWork').filters]);

    React.useEffect(() => {
        if (filtersRequested && !isLoading) void setActiveTab('sessions');
    }, [filtersRequested, isLoading, setActiveTab]);

    React.useEffect(() => {
        if (!inboxEnabled && activeTab === 'inbox') void setActiveTab('sessions');
    }, [activeTab, inboxEnabled, setActiveTab]);

    // Workflows is its own route, so the home route shows Sessions for it.
    const headerTab: ActiveTabType = activeTab === 'projects' ? 'projects' : activeTab === 'inbox' && inboxEnabled ? 'inbox' : 'sessions';

    if (props.isTablet) {
        return <TabletSessionHome backgroundColor={backgroundColor} />;
    }

    return (
        <View style={[styles.phoneContainer, { backgroundColor, paddingTop: insets.top }]}>
            <PhoneMainTabShell>
                {/* My work and Projects open on the line through their main-screen head; the Inbox draws it here. */}
                {headerTab === 'inbox' ? <PhoneMainTabLine /> : null}
                {/* A visited tab stays mounted and suspended while another is shown: returning to it (Sessions, and the
                    Home it holds on an empty Account) re-presents it instead of rebuilding it from nothing. */}
                <RetainedPanelSurface isActive={headerTab === 'sessions'} suspendWhenHidden>{PHONE_SESSIONS_TAB}</RetainedPanelSurface>
                <RetainedPanelSurface isActive={headerTab === 'projects'} suspendWhenHidden>{PHONE_PROJECTS_TAB}</RetainedPanelSurface>
                {inboxEnabled ? (
                    <RetainedPanelSurface isActive={headerTab === 'inbox'} suspendWhenHidden>{PHONE_INBOX_TAB}</RetainedPanelSurface>
                ) : null}
            </PhoneMainTabShell>
        </View>
    );
});
