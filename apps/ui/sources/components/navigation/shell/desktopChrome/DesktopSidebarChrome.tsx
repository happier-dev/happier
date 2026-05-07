import { Ionicons, Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { ConnectionStatusControl } from '@/components/navigation/ConnectionStatusControl';
import { useDesktopWindowDragMouseProps } from '@/components/navigation/desktopWindowChrome/DesktopWindowDragRegion';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import {
    DESKTOP_SIDEBAR_CHROME_ACTIONS_COMPACT_THRESHOLD_PX,
    DESKTOP_SIDEBAR_CHROME_TOP_COLLAPSE_ICON_GLYPH_SIZE_PX,
    DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_GLYPH_SIZE_PX,
    DESKTOP_SIDEBAR_CHROME_TOP_SETTINGS_ICON_GLYPH_SIZE_PX,
} from './desktopChromeMetrics';
import { desktopSidebarChromeStyles } from './desktopSidebarChromeStyles';
import { DesktopShellUpdateIndicatorHost } from './DesktopShellUpdateIndicatorHost';
import { DesktopShellWindowControlsHost } from './DesktopShellWindowControlsHost';
import { SidebarCollapseIcon } from '../SidebarIcons';
import { SidebarLogoButton } from '../SidebarLogoButton';

type DesktopSidebarChromeProps = Readonly<{
    sidebarWidthPx?: number | null;
    headerHeightPx: number;
    onPressHome: () => void;
    onPressCollapse?: () => void;
    onPressBack?: () => void;
    onPressForward?: () => void;
    canNavigateBack?: boolean;
    canNavigateForward?: boolean;
    environmentBadge: string | null;
    headerActions: ItemAction[];
    topUtilityActions?: ItemAction[];
    renderHeaderOverflowVisual: () => React.ReactNode;
    popoverBoundaryRef: React.RefObject<any>;
    desktopWindowControls?: React.ReactNode;
    desktopUpdateIndicator?: React.ReactNode;
}>;

export const DesktopSidebarChrome = React.memo((props: DesktopSidebarChromeProps) => {
    const styles = desktopSidebarChromeStyles;
    const { theme } = useUnistyles();
    const hasDesktopWindowControls = props.desktopWindowControls != null;
    const topStripDragProps = useDesktopWindowDragMouseProps();
    const canNavigateBack = props.canNavigateBack ?? true;
    const canNavigateForward = props.canNavigateForward ?? true;
    const topUtilityActions = props.topUtilityActions ?? [];
    const topUtilityActionIds = React.useMemo(
        () => new Set(topUtilityActions.map((action) => action.id)),
        [topUtilityActions],
    );
    const contentHeaderActions = React.useMemo(() => {
        if (hasDesktopWindowControls) {
            return props.headerActions.filter((action) => !topUtilityActionIds.has(action.id));
        }

        return props.headerActions;
    }, [hasDesktopWindowControls, props.headerActions, topUtilityActionIds]);
    const compactContentActionIds = React.useMemo(() => {
        return hasDesktopWindowControls
            ? ['projects', 'newSession']
            : ['projects', 'settings', 'newSession'];
    }, [hasDesktopWindowControls]);

    const renderTopUtilityAction = React.useCallback((action: ItemAction) => {
        const color = action.color ?? theme.colors.header.tint;
        const isSettingsAction = action.id === 'settings';
        const iconSize = isSettingsAction
            ? DESKTOP_SIDEBAR_CHROME_TOP_SETTINGS_ICON_GLYPH_SIZE_PX
            : DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_GLYPH_SIZE_PX;
        const icon = typeof action.icon === 'string'
            ? action.id === 'inbox'
                ? <Octicons name="inbox" size={iconSize} color={color} />
                : <Ionicons name={action.icon} size={iconSize} color={color} />
            : action.icon;

        return (
            <Pressable
                key={action.id}
                testID={action.inlineTestID}
                onPress={action.onPress}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={action.title}
                style={isSettingsAction ? styles.topSettingsIconButton : styles.topIconButton}
            >
                {icon}
            </Pressable>
        );
    }, [styles.topIconButton, styles.topSettingsIconButton, theme.colors.header.tint]);

    const actionsRow = (
        <View testID="desktop-sidebar-chrome-actions-row" style={styles.rightContainer}>
            <DesktopShellUpdateIndicatorHost>
                {props.desktopUpdateIndicator}
            </DesktopShellUpdateIndicatorHost>
            <ItemRowActions
                title={t('common.moreActions')}
                actions={contentHeaderActions}
                layoutWidthPx={props.sidebarWidthPx ?? null}
                compactThreshold={DESKTOP_SIDEBAR_CHROME_ACTIONS_COMPACT_THRESHOLD_PX}
                compactActionIds={compactContentActionIds}
                pinnedActionIds={compactContentActionIds}
                overflowPosition="beforePinned"
                overflowTriggerTestID="sidebar-header-actions-overflow"
                popoverBoundaryRef={props.popoverBoundaryRef}
                gap={4}
                renderOverflowTrigger={({ open, toggle, testID, accessibilityLabel, accessibilityHint }) => (
                    <Pressable
                        testID={testID}
                        hitSlop={15}
                        style={open ? { opacity: 0 } : undefined}
                        pointerEvents={open ? 'none' : 'auto'}
                        onPress={open ? undefined : toggle}
                        focusable={!open}
                        accessibilityRole="button"
                        accessibilityLabel={accessibilityLabel}
                        accessibilityHint={accessibilityHint}
                        accessibilityState={{ expanded: open, disabled: open }}
                        accessibilityElementsHidden={open}
                        importantForAccessibility={open ? 'no-hide-descendants' : 'auto'}
                    >
                        {props.renderHeaderOverflowVisual()}
                    </Pressable>
                )}
            />
        </View>
    );

    return (
        <View testID="desktop-sidebar-chrome" style={styles.header}>
            {hasDesktopWindowControls ? (
                <View
                    {...topStripDragProps}
                    testID="desktop-sidebar-chrome-controls-row"
                    style={styles.windowControlsRow}
                >
                    <DesktopShellWindowControlsHost>
                        {props.desktopWindowControls}
                    </DesktopShellWindowControlsHost>
                    <View testID="desktop-sidebar-chrome-utility-row" style={styles.utilityRow}>
                        {props.onPressBack ? (
                            <Pressable
                                testID="sidebar-back-button"
                                onPress={props.onPressBack}
                                disabled={!canNavigateBack}
                                hitSlop={10}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.previous')}
                                accessibilityState={{ disabled: !canNavigateBack }}
                                style={[styles.topIconButton, !canNavigateBack ? styles.topIconButtonDisabled : null]}
                            >
                                <Ionicons
                                    name="arrow-back"
                                    size={DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_GLYPH_SIZE_PX}
                                    color={theme.colors.header.tint}
                                />
                            </Pressable>
                        ) : null}
                        {props.onPressForward ? (
                            <Pressable
                                testID="sidebar-forward-button"
                                onPress={props.onPressForward}
                                disabled={!canNavigateForward}
                                hitSlop={10}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.next')}
                                accessibilityState={{ disabled: !canNavigateForward }}
                                style={[styles.topIconButton, !canNavigateForward ? styles.topIconButtonDisabled : null]}
                            >
                                <Ionicons
                                    name="arrow-forward"
                                    size={DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_GLYPH_SIZE_PX}
                                    color={theme.colors.header.tint}
                                />
                            </Pressable>
                        ) : null}
                        {topUtilityActions.map(renderTopUtilityAction)}
                        {props.onPressCollapse ? (
                            <Pressable
                                testID="sidebar-collapse-button"
                                onPress={props.onPressCollapse}
                                hitSlop={10}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.collapse')}
                                style={styles.topIconButton}
                            >
                                <View style={styles.leftSidebarCollapseIcon}>
                                    <SidebarCollapseIcon
                                        size={DESKTOP_SIDEBAR_CHROME_TOP_COLLAPSE_ICON_GLYPH_SIZE_PX}
                                        color={theme.colors.header.tint}
                                    />
                                </View>
                            </Pressable>
                        ) : null}
                    </View>
                </View>
            ) : null}

            <View
                testID="desktop-sidebar-chrome-content-row"
                style={[
                    styles.contentRow,
                    hasDesktopWindowControls ? styles.compactContentRow : { minHeight: props.headerHeightPx },
                ]}
            >
                <View testID="desktop-sidebar-chrome-brand-group" style={styles.brandGroup}>
                    <SidebarLogoButton
                        testID="desktop-sidebar-brand-button"
                        onPress={props.onPressHome}
                        style={styles.brandButton}
                    />
                    <View testID="desktop-sidebar-title-container" style={styles.titleContainerLeft}>
                        <View style={styles.titleRow}>
                            <Text testID="desktop-sidebar-title-text" style={styles.titleText} numberOfLines={1}>
                                {t('sidebar.sessionsTitle')}
                            </Text>
                            {props.environmentBadge ? (
                                <View style={styles.envBadge}>
                                    <Text style={styles.envBadgeText}>{props.environmentBadge}</Text>
                                </View>
                            ) : null}
                        </View>
                        <View style={styles.statusControlWrapper}>
                            <ConnectionStatusControl
                                variant="sidebar"
                                alignSelf="stretch"
                            />
                        </View>
                    </View>
                </View>

                {actionsRow}
            </View>
        </View>
    );
});
