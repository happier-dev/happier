import { useFriendRequests, useSetting } from '@/sync/domains/state/storage';
import * as React from 'react';
import { Platform, View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { Typography } from '@/constants/Typography';
import { VoiceSurface } from '@/components/voice/surface/VoiceSurface';
import { MainView } from './MainView';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useInboxHasContent } from '@/hooks/inbox/useInboxHasContent';
import { useInboxAvailable } from '@/hooks/inbox/useInboxAvailable';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { PopoverScope } from '@/components/ui/popover';
import { ConnectionStatusControl } from '@/components/navigation/ConnectionStatusControl';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { config } from '@/config';
import { isStackContext } from '@/sync/domains/server/serverContext';
import { isUsingCustomServer } from '@/sync/domains/server/serverConfig';
import { resolveVisibleAppEnvironmentBadge } from '@/sync/runtime/appVariant';
import { Text } from '@/components/ui/text/Text';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { SIDEBAR_DOCK_MIN_WIDTH_PX } from './sidebarSizing';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';

export type SidebarViewProps = Readonly<{
    sidebarWidthPx?: number | null;
}>;

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        borderStyle: 'solid',
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        overflow: 'visible',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: theme.colors.groupped.background,
        position: 'relative',
        zIndex: 100,
        overflow: 'visible',
    },
    logoContainer: {
        width: 32,
    },
    logo: {
        height: 24,
        width: 24,
    },
    titleContainerLeft: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        minWidth: 0,
        flexDirection: 'column',
        alignItems: 'flex-start',
        marginLeft: 8,
        justifyContent: 'center',
        overflow: 'visible',
    },
    titleText: {
        fontSize: 16,
        color: theme.colors.header.tint,
        ...Typography.default('semiBold'),
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
    },
    statusControlWrapper: {
        alignSelf: 'stretch',
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
    },
    envBadge: {
        marginTop: -4,
        marginLeft: -4,
        paddingHorizontal: 4,
        paddingVertical: 1,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    envBadgeText: {
        fontSize: 6,
        lineHeight: 8,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
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
        ...Typography.default('regular'),
        lineHeight: 16,
        ...Typography.default(),
    },
    rightContainer: {
        marginLeft: 'auto',
        alignItems: 'center',
        flexDirection: 'row',
        gap: 4,
    },
    iconButton: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    settingsButton: {
        color: theme.colors.header.tint,
    },
    notificationButton: {
        position: 'relative',
    },
    badge: {
        position: 'absolute',
        top: -4,
        right: -4,
        backgroundColor: theme.colors.status.error,
        borderRadius: 8,
        minWidth: 16,
        height: 16,
        paddingHorizontal: 4,
        justifyContent: 'center',
        alignItems: 'center',
    },
    badgeText: {
        color: '#FFFFFF',
        fontSize: 10,
        ...Typography.default('semiBold'),
    },
    indicatorDot: {
        position: 'absolute',
        top: 4,
        right: 2,
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.text,
    },
}));

export const SidebarView = React.memo((props: SidebarViewProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useChromeSafeAreaInsets();
    const router = useRouter();
    const headerHeight = useHeaderHeight();
    const popoverBoundaryRef = React.useRef<any>(null);
    const friendRequests = useFriendRequests();
    const inboxHasContent = useInboxHasContent();
    const showEnvironmentBadge = useSetting('showEnvironmentBadge');
    const friendsEnabled = useFriendsEnabled();
    const inboxEnabled = useInboxAvailable();
    const voiceEnabled = useFeatureEnabled('voice');
    const environmentBadge = resolveVisibleAppEnvironmentBadge({
        showEnvironmentBadge,
        appVariant: config.variant,
        envAppEnv: process.env.APP_ENV,
        envExpoPublicAppEnv: process.env.EXPO_PUBLIC_APP_ENV,
        isStackContext: isStackContext(),
        isUsingCustomServer: isUsingCustomServer(),
    });

    const handleNewSession = React.useCallback(() => {
        const result = runGuardedNavigation(() => router.push('/new'));
        if (result !== true) {
            fireAndForget(result, { tag: 'SidebarView.nav.newSession' });
        }
    }, [router]);

    const handleHome = React.useCallback(() => {
        const result = runGuardedNavigation(() => router.push('/'));
        if (result !== true) {
            fireAndForget(result, { tag: 'SidebarView.nav.home' });
        }
    }, [router]);

    const headerActions = React.useMemo((): ItemAction[] => {
        const out: ItemAction[] = [];

        if (inboxEnabled) {
            out.push({
                id: 'inbox',
                title: t('tabs.inbox'),
                inlineTestID: 'sidebar-inbox-button',
                icon: (
                    <View style={[styles.iconButton, styles.notificationButton]}>
                        <Octicons name="inbox" size={20} color={theme.colors.header.tint} />
                        {inboxHasContent ? <View style={styles.indicatorDot} /> : null}
                    </View>
                ),
                onPress: () => {
                    const result = runGuardedNavigation(() => router.push('/(app)/inbox'));
                    if (result !== true) {
                        fireAndForget(result, { tag: 'SidebarView.nav.inbox' });
                    }
                },
            });
        }

        if (friendsEnabled) {
            const count = friendRequests.length;
            out.push({
                id: 'friends',
                title: t('tabs.friends'),
                icon: (
                    <View style={[styles.iconButton, styles.notificationButton]}>
                        <Ionicons name="people-outline" size={24} color={theme.colors.header.tint} />
                        {count > 0 ? (
                            <View style={styles.badge}>
                                <Text style={styles.badgeText}>
                                    {count > 99 ? '99+' : count}
                                </Text>
                            </View>
                        ) : null}
                    </View>
                ),
                onPress: () => {
                    const result = runGuardedNavigation(() => router.push('/(app)/friends'));
                    if (result !== true) {
                        fireAndForget(result, { tag: 'SidebarView.nav.friends' });
                    }
                },
            });
        }

        out.push({
            id: 'projects',
            title: t('tabs.projects'),
            inlineTestID: 'nav-projects',
            icon: (
                <View style={styles.iconButton}>
                    <Ionicons name="folder-outline" size={24} color={theme.colors.header.tint} />
                </View>
            ),
            onPress: () => {
                const result = runGuardedNavigation(() => router.push('/projects'));
                if (result !== true) {
                    fireAndForget(result, { tag: 'SidebarView.nav.projects' });
                }
            },
        });

        out.push({
            id: 'settings',
            title: t('settings.title'),
            inlineTestID: 'nav-settings',
            icon: (
                <View style={styles.iconButton}>
                    <Ionicons name="cog-outline" size={24} color={theme.colors.header.tint} />
                </View>
            ),
            onPress: () => {
                const result = runGuardedNavigation(() => router.push('/settings'));
                if (result !== true) {
                    fireAndForget(result, { tag: 'SidebarView.nav.settings' });
                }
            },
        });

        out.push({
            id: 'newSession',
            title: t('newSession.title'),
            inlineTestID: 'nav-new-session',
            icon: (
                <View style={styles.iconButton}>
                    <Ionicons name="add-outline" size={24} color={theme.colors.header.tint} />
                </View>
            ),
            onPress: handleNewSession,
        });

        return out;
    }, [
        friendRequests.length,
        friendsEnabled,
        handleNewSession,
        inboxEnabled,
        inboxHasContent,
        router,
        styles.badge,
        styles.badgeText,
        styles.iconButton,
        styles.indicatorDot,
        styles.notificationButton,
        t,
        theme.colors.header.tint,
    ]);

    const renderHeaderOverflowVisual = React.useCallback(() => {
        const shouldShowBadge = friendRequests.length > 0;
        const shouldShowDot = !shouldShowBadge && inboxHasContent;

        return (
            <View style={[styles.iconButton, styles.notificationButton]}>
                <Ionicons name="ellipsis-horizontal" size={14} color={theme.colors.header.tint} />
                {shouldShowBadge ? (
                    <View style={styles.badge}>
                        <Text style={styles.badgeText}>
                            {friendRequests.length > 99 ? '99+' : friendRequests.length}
                        </Text>
                    </View>
                ) : shouldShowDot ? (
                    <View style={styles.indicatorDot} />
                ) : null}
            </View>
        );
    }, [
        friendRequests.length,
        inboxHasContent,
        styles.badge,
        styles.badgeText,
        styles.iconButton,
        styles.indicatorDot,
        styles.notificationButton,
        theme.colors.header.tint,
    ]);

    // Title content used in both centered and left-justified modes (DRY)
    const titleContent = (
        <>
            <View style={styles.titleRow}>
                <Text style={styles.titleText}>{t('sidebar.sessionsTitle')}</Text>
                {environmentBadge ? (
                    <View style={styles.envBadge}>
                        <Text style={styles.envBadgeText}>{environmentBadge}</Text>
                    </View>
                ) : null}
            </View>
            <View
                style={[
                    styles.statusControlWrapper,
                    Platform.OS === 'web' ? ({ pointerEvents: 'auto' } as any) : null,
                ]}
            >
                <ConnectionStatusControl
                    variant="sidebar"
                    alignSelf="stretch"
                />
            </View>
        </>
    );

    return (
        <>
            <View testID="sidebar-view" ref={popoverBoundaryRef} style={[styles.container, { paddingTop: safeArea.top }]}>
                <PopoverScope boundaryRef={popoverBoundaryRef}>
                <View style={[styles.header, { height: headerHeight }]}>
                    {/* Logo - always first */}
                    <Pressable
                        onPress={handleHome}
                        hitSlop={15}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.home')}
                        style={[styles.logoContainer, styles.iconButton]}
                    >
                        <Image
                            source={theme.dark ? require('@/assets/images/logo-white.png') : require('@/assets/images/logo-black.png')}
                            contentFit="contain"
                            style={[styles.logo, { height: 24, width: 24 }]}
                        />
                    </Pressable>
                    {/* Title - left-justified next to logo */}
                    <View style={styles.titleContainerLeft}>
                        {titleContent}
                    </View>

                    {/* Navigation icons */}
                    <View style={styles.rightContainer}>
                        <ItemRowActions
                            title={t('common.moreActions')}
                            actions={headerActions}
                            layoutWidthPx={props.sidebarWidthPx ?? null}
                            compactThreshold={SIDEBAR_DOCK_MIN_WIDTH_PX + 120}
                            compactActionIds={['projects', 'settings', 'newSession']}
                            pinnedActionIds={['projects', 'settings', 'newSession']}
                            overflowPosition="beforePinned"
                            overflowPlacement="bottom"
                            overflowPortal={{ anchorAlign: 'center' }}
                            overflowTriggerTestID="sidebar-header-actions-overflow"
                            popoverBoundaryRef={popoverBoundaryRef}
                            renderOverflowAnchorOverlay={renderHeaderOverflowVisual}
                            gap={4}
                            renderOverflowTrigger={({ open, toggle, testID, accessibilityLabel, accessibilityHint }) => (
                                <Pressable
                                    testID={testID}
                                    hitSlop={15}
                                    style={open ? { opacity: 0 } : undefined}
                                    onPress={toggle}
                                    accessibilityRole="button"
                                    accessibilityLabel={accessibilityLabel}
                                    accessibilityHint={accessibilityHint}
                                    accessibilityState={{ expanded: open }}
                                >
                                    {renderHeaderOverflowVisual()}
                                </Pressable>
                            )}
                        />
                    </View>

                </View>
                {voiceEnabled ? <VoiceSurface variant="sidebar" /> : null}
                <MainView variant="sidebar" />
                </PopoverScope>
            </View>
        </>
    )
});
