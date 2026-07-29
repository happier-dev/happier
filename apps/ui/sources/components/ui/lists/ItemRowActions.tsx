import React from 'react';
import { View, Pressable, useWindowDimensions, type GestureResponderEvent, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { type ItemAction } from '@/components/ui/lists/itemActions';
import { Popover, type PopoverPlacement, type PopoverPortalOptions } from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { resolveWebBlurTintColor } from '@/components/ui/overlays/resolveWebBlurTintColor';
import { ActionListSection, type ActionListItem } from '@/components/ui/lists/ActionListSection';
import { t } from '@/text';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

export interface ItemRowActionsProps {
    title: string;
    actions: ItemAction[];
    /**
     * Optional override for the layout width used to decide whether the row is in "compact" mode.
     * When omitted, the current window width from `useWindowDimensions()` is used.
     *
     * This is useful for responsive icon rows that live inside a container that can be narrower
     * than the window (e.g. a resizable sidebar header).
     */
    layoutWidthPx?: number | null;
    overflowTriggerTestID?: string;
    renderOverflowTrigger?: (props: Readonly<{
        open: boolean;
        toggle: () => void;
        testID?: string;
        accessibilityLabel: string;
        accessibilityHint: string;
    }>) => React.ReactNode;
    renderOverflowAnchorOverlay?: () => React.ReactNode;
    compactThreshold?: number;
    compactActionIds?: string[];
    /**
     * Action IDs that should remain visible on compact layouts and be rendered
     * at the far right of the row.
     */
    pinnedActionIds?: string[];
    /**
     * Where to render the overflow (ellipsis) trigger on compact layouts.
     * - 'end': after all inline actions (default)
     * - 'beforePinned': between inline actions and pinned actions
     */
    overflowPosition?: 'end' | 'beforePinned';
    overflowPlacement?: PopoverPlacement;
    overflowPortal?: Partial<PopoverPortalOptions>;
    iconSize?: number;
    gap?: number;
    onActionPressIn?: () => void;
    /**
     * Optional explicit boundary ref for the popover. Useful when the row is rendered
     * inside a scroll container that should bound the popover sizing/placement.
     * If omitted, Popover falls back to PopoverBoundaryProvider context when present,
     * otherwise it clamps to the window/screen.
     */
    popoverBoundaryRef?: React.RefObject<any> | null;
}

const DEFAULT_ACTION_CONTROL_SIZE = 28;

export function ItemRowActions(props: ItemRowActionsProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { width: windowWidth } = useWindowDimensions();
    const widthForCompact =
        typeof props.layoutWidthPx === 'number'
        && Number.isFinite(props.layoutWidthPx)
        && props.layoutWidthPx > 0
            ? props.layoutWidthPx
            : windowWidth;
    const compact = widthForCompact < (props.compactThreshold ?? 450);
    const [showOverflow, setShowOverflow] = React.useState(false);
    const overflowAnchorRef = React.useRef<View>(null);

    const blurTintOnWeb = React.useMemo(() => {
        return resolveWebBlurTintColor({ surfaceColor: theme.colors.surface.base, dark: theme.dark });
    }, [theme.colors.surface.base, theme.dark]);

    const compactIds = React.useMemo(() => new Set(props.compactActionIds ?? []), [props.compactActionIds]);
    const pinnedIds = React.useMemo(() => new Set(props.pinnedActionIds ?? []), [props.pinnedActionIds]);
    const overflowPosition = props.overflowPosition ?? 'end';

    const inlineActions = React.useMemo(() => {
        if (!compact) return props.actions;
        return props.actions.filter((a) => compactIds.has(a.id));
    }, [compact, compactIds, props.actions]);

    const pinnedActions = React.useMemo(() => {
        if (!compact) return [] as ItemAction[];
        return inlineActions.filter((a) => pinnedIds.has(a.id));
    }, [compact, inlineActions, pinnedIds]);

    const nonPinnedInlineActions = React.useMemo(() => {
        if (!compact) return inlineActions;
        return inlineActions.filter((a) => !pinnedIds.has(a.id));
    }, [compact, inlineActions, pinnedIds]);
    const overflowActions = React.useMemo(() => {
        if (!compact) return [];
        return props.actions.filter((a) => !compactIds.has(a.id));
    }, [compact, compactIds, props.actions]);

    const closeThen = React.useCallback((fn: () => void) => {
        setShowOverflow(false);
        // InteractionManager can be delayed by long/continuous interactions (scroll, gestures).
        // Use an immediate fallback so the action still runs promptly.
        runAfterInteractionsWithFallback(fn, { fallbackDelayMs: 0 });
    }, []);

    const overflowActionItems = React.useMemo((): ActionListItem[] => {
        return overflowActions.map((action) => {
            const color = action.color ?? (action.destructive ? theme.colors.state.danger.foreground : theme.colors.button.secondary.tint);
            const iconNode =
                typeof action.icon === 'string'
                    ? <Ionicons name={action.icon} size={18} color={color} />
                    : action.icon;
            const onPress = action.onPress;
            return {
                id: action.id,
                testID: action.id,
                label: action.title,
                subtitle: action.subtitle,
                icon: iconNode,
                onPress: onPress ? () => closeThen(onPress) : undefined,
                disabled: action.disabled,
            };
        });
    }, [closeThen, overflowActions, theme.colors.button.secondary.tint, theme.colors.state.danger.foreground]);

    const iconSize = props.iconSize ?? 20;
    const minimumActionTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const actionControlSize = Math.max(
        Platform.OS === 'web' || Platform.OS === 'android'
            ? minimumActionTargetSize
            : DEFAULT_ACTION_CONTROL_SIZE,
        iconSize,
    );
    const actionHitSlop = Math.max(0, (minimumActionTargetSize - actionControlSize) / 2);
    const gap = props.gap ?? 16;
    const overflowPlacement = props.overflowPlacement ?? 'left';
    const overflowPortal = React.useMemo<PopoverPortalOptions>(() => ({
        web: true,
        native: true,
        matchAnchorWidth: false,
        anchorAlignVertical: 'center',
        ...props.overflowPortal,
    }), [props.overflowPortal]);
    const overflowAnchorOverlay = React.useMemo(() => {
        if (props.renderOverflowAnchorOverlay) {
            return props.renderOverflowAnchorOverlay();
        }
        return normalizeNodeForView(
            <Ionicons
                name="ellipsis-horizontal"
                size={iconSize + 2}
                color={theme.colors.button.secondary.tint}
            />,
        );
    }, [iconSize, props, theme.colors.button.secondary.tint]);

    const renderInlineAction = React.useCallback((action: ItemAction) => {
        const color = action.color ?? (action.destructive ? theme.colors.state.danger.foreground : theme.colors.button.secondary.tint);
        const iconNode =
            typeof action.icon === 'string'
                ? (
                    <Ionicons
                        name={action.icon}
                        size={iconSize}
                        color={color}
                    />
                )
                : action.icon;

        return (
            <Pressable
                key={action.id}
                testID={action.inlineTestID}
                disabled={action.disabled || !action.onPress}
                hitSlop={actionHitSlop}
                onPressIn={() => props.onActionPressIn?.()}
                onPress={(e: GestureResponderEvent) => {
                    e?.stopPropagation?.();
                    action.onPress?.();
                }}
                style={(interactionState) => {
                    const webState = interactionState as typeof interactionState & { focused?: boolean };
                    return [
                        styles.actionControl,
                        {
                            width: actionControlSize,
                            height: actionControlSize,
                            borderRadius: actionControlSize / 2,
                        },
                        webState.focused === true ? styles.actionControlFocused : null,
                    ];
                }}
                accessibilityRole="button"
                accessibilityLabel={action.title}
            >
                {normalizeNodeForView(
                    iconNode,
                )}
            </Pressable>
        );
    }, [actionControlSize, actionHitSlop, iconSize, props, theme.colors.button.secondary.tint, theme.colors.state.danger.foreground]);

    const renderOverflow = React.useCallback(() => {
        const accessibilityLabel = t('common.moreActions');
        const accessibilityHint = t('common.moreActionsHint');
        const toggleOverflow = () => setShowOverflow((v) => !v);

        return (
            <View key="overflow" style={{ position: 'relative' }}>
                <View ref={overflowAnchorRef}>
                    {props.renderOverflowTrigger
                        ? props.renderOverflowTrigger({
                            open: showOverflow,
                            toggle: toggleOverflow,
                            testID: props.overflowTriggerTestID,
                            accessibilityLabel,
                            accessibilityHint,
                        })
                        : (
                            <Pressable
                                testID={props.overflowTriggerTestID}
                                hitSlop={actionHitSlop}
                                style={(interactionState) => {
                                    const webState = interactionState as typeof interactionState & { focused?: boolean };
                                    return [
                                        styles.actionControl,
                                        {
                                            width: actionControlSize,
                                            height: actionControlSize,
                                            borderRadius: actionControlSize / 2,
                                        },
                                        showOverflow ? { opacity: 0 } : null,
                                        webState.focused === true ? styles.actionControlFocused : null,
                                    ];
                                }}
                                onPressIn={() => props.onActionPressIn?.()}
                                onPress={(e: GestureResponderEvent) => {
                                    e?.stopPropagation?.();
                                    toggleOverflow();
                                }}
                                accessibilityRole="button"
                                accessibilityLabel={accessibilityLabel}
                                accessibilityHint={accessibilityHint}
                                accessibilityState={{ expanded: showOverflow }}
                                // @ts-expect-error - react-native types do not model the web-only `title` attribute; RN Web forwards it.
                                title={accessibilityLabel}
                            >
                                {normalizeNodeForView(
                                    <Ionicons
                                        name="ellipsis-horizontal"
                                        size={iconSize + 2}
                                        color={theme.colors.button.secondary.tint}
                                    />,
                                )}
                            </Pressable>
                        )}
                </View>

                {showOverflow ? (
                    <Popover
                        open={showOverflow}
                        anchorRef={overflowAnchorRef}
                        placement={overflowPlacement}
                        gap={10}
                        maxHeightCap={280}
                        maxWidthCap={260}
                        edgePadding={{ vertical: 8, horizontal: 8 }}
                        portal={overflowPortal}
                        boundaryRef={props.popoverBoundaryRef}
                        onRequestClose={() => setShowOverflow(false)}
                        backdrop={{
                            effect: 'blur',
                            blurOnWeb: Platform.OS === 'web' ? { px: 3, tintColor: blurTintOnWeb } : undefined,
                            anchorOverlay: overflowAnchorOverlay,
                            closeOnPan: true,
                        }}
                    >
                        {({ maxHeight, placement }) => (
                            <FloatingOverlay
                                maxHeight={maxHeight}
                                arrow={{ placement }}
                                keyboardShouldPersistTaps="always"
                                edgeFades={{ top: true, bottom: true, size: 24 }}
                                edgeIndicators={true}
                            >
                                <ActionListSection
                                    title={props.title}
                                    actions={overflowActionItems}
                                />
                            </FloatingOverlay>
                        )}
                    </Popover>
                ) : null}
            </View>
        );
    }, [actionControlSize, actionHitSlop, blurTintOnWeb, overflowActionItems, overflowAnchorOverlay, overflowPlacement, overflowPortal, props, showOverflow]);

    return (
        <View style={[styles.container, { gap }]}>
            {(compact ? nonPinnedInlineActions : inlineActions).map(renderInlineAction)}

            {compact && overflowActions.length > 0 && overflowPosition === 'beforePinned' ? (
                <>
                    {renderOverflow()}
                    {pinnedActions.map(renderInlineAction)}
                </>
            ) : null}

            {compact && overflowActions.length > 0 && overflowPosition === 'end' ? (
                <>
                    {pinnedActions.map(renderInlineAction)}
                    {renderOverflow()}
                </>
            ) : null}

            {compact && overflowActions.length === 0 && pinnedActions.length > 0 ? (
                <>
                    {pinnedActions.map(renderInlineAction)}
                </>
            ) : null}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    actionControl: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionControlFocused: {
        ...(Platform.select({
            web: {
                outlineStyle: 'solid',
                outlineWidth: 2,
                outlineColor: theme.colors.border.strong,
                outlineOffset: -2,
            },
            default: {},
        }) as object),
    },
}));
