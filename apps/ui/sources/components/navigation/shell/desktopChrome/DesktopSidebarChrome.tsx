import { Image } from 'expo-image';
import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { ConnectionStatusControl } from '@/components/navigation/ConnectionStatusControl';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { DESKTOP_SIDEBAR_CHROME_ACTIONS_COMPACT_THRESHOLD_PX } from './desktopChromeMetrics';
import { desktopSidebarChromeStyles } from './desktopSidebarChromeStyles';
import { DesktopShellUpdateIndicatorHost } from './DesktopShellUpdateIndicatorHost';
import { DesktopShellWindowControlsHost } from './DesktopShellWindowControlsHost';

type DesktopSidebarChromeProps = Readonly<{
    sidebarWidthPx?: number | null;
    headerHeightPx: number;
    onPressHome: () => void;
    environmentBadge: string | null;
    headerActions: ItemAction[];
    renderHeaderOverflowVisual: () => React.ReactNode;
    popoverBoundaryRef: React.RefObject<any>;
    desktopWindowControls?: React.ReactNode;
    desktopUpdateIndicator?: React.ReactNode;
}>;

export const DesktopSidebarChrome = React.memo((props: DesktopSidebarChromeProps) => {
    const styles = desktopSidebarChromeStyles;
    const { theme } = useUnistyles();
    const hasDesktopWindowControls = props.desktopWindowControls != null;

    return (
        <View testID="desktop-sidebar-chrome" style={styles.header}>
            {hasDesktopWindowControls ? (
                <View testID="desktop-sidebar-chrome-controls-row" style={styles.windowControlsRow}>
                    <DesktopShellWindowControlsHost>
                        {props.desktopWindowControls}
                    </DesktopShellWindowControlsHost>
                </View>
            ) : null}

            <View testID="desktop-sidebar-chrome-content-row" style={[styles.contentRow, { minHeight: props.headerHeightPx }]}>
                <View testID="desktop-sidebar-chrome-brand-group" style={styles.brandGroup}>
                    <Pressable
                        onPress={props.onPressHome}
                        hitSlop={15}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.home')}
                        style={[styles.logoContainer, styles.iconButton]}
                    >
                        <Image
                            source={theme.dark ? require('@/assets/images/logo-white.png') : require('@/assets/images/logo-black.png')}
                            contentFit="contain"
                            style={styles.logo}
                        />
                    </Pressable>

                    <View style={styles.titleContainerLeft}>
                        <View style={styles.titleRow}>
                            <Text style={styles.titleText}>{t('sidebar.sessionsTitle')}</Text>
                            {props.environmentBadge ? (
                                <View style={styles.envBadge}>
                                    <Text style={styles.envBadgeText}>{props.environmentBadge}</Text>
                                </View>
                            ) : null}
                        </View>
                        <View
                            style={[
                                styles.statusControlWrapper,
                                Platform.OS === 'web' ? ({ pointerEvents: 'auto' } as const) : null,
                            ]}
                        >
                            <ConnectionStatusControl
                                variant="sidebar"
                                alignSelf="stretch"
                            />
                        </View>
                    </View>
                </View>

                <View testID="desktop-sidebar-chrome-actions-row" style={styles.rightContainer}>
                    <DesktopShellUpdateIndicatorHost>
                        {props.desktopUpdateIndicator}
                    </DesktopShellUpdateIndicatorHost>
                    <ItemRowActions
                        title={t('common.moreActions')}
                        actions={props.headerActions}
                        layoutWidthPx={props.sidebarWidthPx ?? null}
                        compactThreshold={DESKTOP_SIDEBAR_CHROME_ACTIONS_COMPACT_THRESHOLD_PX}
                        compactActionIds={['projects', 'settings', 'newSession']}
                        pinnedActionIds={['projects', 'settings', 'newSession']}
                        overflowPosition="beforePinned"
                        overflowPlacement="bottom"
                        overflowPortal={{ anchorAlign: 'center' }}
                        overflowTriggerTestID="sidebar-header-actions-overflow"
                        popoverBoundaryRef={props.popoverBoundaryRef}
                        renderOverflowAnchorOverlay={props.renderHeaderOverflowVisual}
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
                                {props.renderHeaderOverflowVisual()}
                            </Pressable>
                        )}
                    />
                </View>
            </View>
        </View>
    );
});
