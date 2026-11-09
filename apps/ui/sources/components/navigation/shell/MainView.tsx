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
        const storageChrome = (
            <SessionsListStorageChrome
                column="sessions"
            />
        );

        return (
            <>
                <View style={styles.sidebarContainer}>
                    {storageChrome}
                    <View style={styles.sidebarContentContainer}>
                        <SessionsListPaneContent
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

    const renderTabContent = React.useCallback(() => {
        switch (headerTab) {
            case 'inbox':
                return <InboxView />;
            case 'projects':
                return <ProjectsListView />;
            case 'sessions':
            default:
                return <SessionsListWrapper pathname="/" />;
        }
    }, [headerTab]);

    if (props.isTablet) {
        return <TabletSessionHome backgroundColor={backgroundColor} />;
    }

    return (
        <View style={[styles.phoneContainer, { backgroundColor, paddingTop: insets.top }]}>
            <PhoneMainTabShell>
                {/* The list draws the line in its own nav row, beside its controls. */}
                {headerTab === 'sessions' ? null : <PhoneMainTabLine />}
                {renderTabContent()}
            </PhoneMainTabShell>
        </View>
    );
});
