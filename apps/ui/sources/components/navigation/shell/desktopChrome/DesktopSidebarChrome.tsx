import * as React from 'react';
import { View } from 'react-native';
import { PressableSurface } from '@/components/ui/interaction/PressableSurface';
import { useUnistyles } from 'react-native-unistyles';
import { ConnectionStatusControl } from '@/components/navigation/ConnectionStatusControl';
import { useDesktopWindowDragMouseProps } from '@/components/navigation/desktopWindowChrome/DesktopWindowDragRegion';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import {
    DESKTOP_SIDEBAR_CHROME_ACTIONS_COMPACT_THRESHOLD_PX,
    DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX,
    DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_BUTTON_SIZE_PX,
} from './desktopChromeMetrics';
import { desktopSidebarChromeStyles } from './desktopSidebarChromeStyles';
import { DesktopShellWindowControlsHost } from './DesktopShellWindowControlsHost';
import { SidebarCollapseIcon } from '../SidebarIcons';
import { SidebarLogoButton } from '../SidebarLogoButton';
import { Icon } from '@/components/ui/icons/Icon';
import { ActionOperationActivityButton } from '@/components/inbox/actionOperations/ActionOperationActivityButton';
import { InboxPopoverButton } from '@/components/inbox/InboxPopoverButton';
import { DirectSessionsBrowseButton } from '@/components/sessions/directSessions/browse/DirectSessionsBrowseButton';
import { UpdatesEntry } from '@/components/updates/UpdatesPopoverButton';
import type { InboxSummary } from '@/hooks/inbox/useInboxSummary';
import { ProviderUsageStrip } from '@/components/sessions/usage/ProviderUsageStrip';

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
    inboxSummary?: InboxSummary | null;
    inboxEnabled?: boolean;
}>;

export const DesktopSidebarChrome = React.memo((props: DesktopSidebarChromeProps) => {
    const styles = desktopSidebarChromeStyles;
    const { theme } = useUnistyles();
    const hasDesktopWindowControls = props.desktopWindowControls != null;
    const topStripDragProps = useDesktopWindowDragMouseProps();
    const canNavigateBack = props.canNavigateBack ?? true;
    const canNavigateForward = props.canNavigateForward ?? true;
    const topUtilityActions = props.topUtilityActions ?? [];
    const backLabel = t('common.previous');
    const forwardLabel = t('common.next');
    const collapseLabel = t('common.collapse');
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
        const color = action.color ?? theme.colors.chrome.header.foreground;
        const isSettingsAction = action.id === 'settings';
        const icon = typeof action.icon === 'string'
            ? <Icon name={action.icon} size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX} color={color} />
            : action.icon;

        return (
            <PressableSurface
                key={action.id}
                testID={action.inlineTestID}
                onPress={action.onPress}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={action.title}
                webTooltip={action.title}
                style={isSettingsAction ? styles.topSettingsIconButton : styles.topIconButton}
            >
                {icon}
            </PressableSurface>
        );
    }, [styles.topIconButton, styles.topSettingsIconButton, theme.colors.chrome.header.foreground]);

    const actionsRow = (
        <View testID="desktop-sidebar-chrome-actions-row" style={styles.rightContainer}>
            <ItemRowActions
                title={t('common.moreActions')}
                actions={contentHeaderActions}
                layoutWidthPx={props.sidebarWidthPx ?? null}
                compactThreshold={DESKTOP_SIDEBAR_CHROME_ACTIONS_COMPACT_THRESHOLD_PX}
                compactActionIds={compactContentActionIds}
                pinnedActionIds={compactContentActionIds}
                leadingPinnedContent={(
                    <View style={styles.inlineUtilityRow}>
                        {/* Without a desktop top rail, Updates joins this icon row; it leads so the
                            icons after it stay put when it appears. */}
                        {hasDesktopWindowControls ? null : (
                            <UpdatesEntry
                                variant="icon"
                                buttonSize={32}
                                iconSize={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                                testID="desktop-sidebar-updates-button"
                            />
                        )}
                        {/* Opens provider-session browsing; it replaced the large Browse block above the session list. */}
                        <DirectSessionsBrowseButton
                            testID="sidebar-direct-browse-button"
                            buttonSize={32}
                            iconSize={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                        />
                        {props.inboxEnabled && props.inboxSummary ? (
                            <InboxPopoverButton
                                summary={props.inboxSummary}
                                testID="sidebar-inbox-button"
                                buttonSize={32}
                                iconSize={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                            />
                        ) : null}
                        <ActionOperationActivityButton
                            testID="desktop-sidebar-action-operations"
                            buttonSize={32}
                            iconSize={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                        />
                    </View>
                )}
                overflowPosition="beforePinned"
                overflowTriggerTestID="sidebar-header-actions-overflow"
                popoverBoundaryRef={props.popoverBoundaryRef}
                gap={4}
                renderOverflowTrigger={({ open, toggle, testID, accessibilityLabel, accessibilityHint }) => (
                    <PressableSurface
                        testID={testID}
                        hitSlop={15}
                        style={open ? { opacity: 0 } : undefined}
                        pointerEvents={open ? 'none' : 'auto'}
                        disabled={open}
                        onPress={open ? undefined : toggle}
                        focusable={!open}
                        accessibilityRole="button"
                        accessibilityLabel={accessibilityLabel}
                        webTooltip={open ? undefined : accessibilityLabel}
                        accessibilityHint={accessibilityHint}
                        accessibilityState={{ expanded: open, disabled: open }}
                        accessibilityElementsHidden={open}
                        importantForAccessibility={open ? 'no-hide-descendants' : 'auto'}
                    >
                        {props.renderHeaderOverflowVisual()}
                    </PressableSurface>
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
                        {/* The desktop top rail holds window-level utilities; inbox and activity stay
                            in the sidebar's icon row. Back/forward lead; Updates follows them. */}
                        {props.onPressBack ? (
                            <PressableSurface
                                testID="sidebar-back-button"
                                onPress={props.onPressBack}
                                disabled={!canNavigateBack}
                                hitSlop={10}
                                accessibilityRole="button"
                                accessibilityLabel={backLabel}
                                webTooltip={backLabel}
                                accessibilityState={{ disabled: !canNavigateBack }}
                                style={[styles.topIconButton, !canNavigateBack ? styles.topIconButtonDisabled : null]}
                            >
                                <Icon
                                    name="arrow-left"
                                    size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                                    color={theme.colors.chrome.header.foreground}
                                />
                            </PressableSurface>
                        ) : null}
                        {props.onPressForward ? (
                            <PressableSurface
                                testID="sidebar-forward-button"
                                onPress={props.onPressForward}
                                disabled={!canNavigateForward}
                                hitSlop={10}
                                accessibilityRole="button"
                                accessibilityLabel={forwardLabel}
                                webTooltip={forwardLabel}
                                accessibilityState={{ disabled: !canNavigateForward }}
                                style={[styles.topIconButton, !canNavigateForward ? styles.topIconButtonDisabled : null]}
                            >
                                <Icon
                                    name="arrow-right"
                                    size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                                    color={theme.colors.chrome.header.foreground}
                                />
                            </PressableSurface>
                        ) : null}
                        <UpdatesEntry
                            variant="icon"
                            buttonSize={DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_BUTTON_SIZE_PX}
                            iconSize={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                            testID="desktop-sidebar-updates-button"
                        />
                        {topUtilityActions.map(renderTopUtilityAction)}
                        {props.onPressCollapse ? (
                            <PressableSurface
                                testID="sidebar-collapse-button"
                                onPress={props.onPressCollapse}
                                hitSlop={10}
                                accessibilityRole="button"
                                accessibilityLabel={collapseLabel}
                                webTooltip={collapseLabel}
                                style={styles.topIconButton}
                            >
                                <SidebarCollapseIcon
                                    size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                                    color={theme.colors.chrome.header.foreground}
                                />
                            </PressableSurface>
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
                    <ProviderUsageStrip />
                </View>

                {actionsRow}
            </View>
        </View>
    );
});
