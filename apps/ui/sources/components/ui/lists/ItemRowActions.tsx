import React from 'react';
import { View, Pressable, useWindowDimensions, type GestureResponderEvent, Platform } from 'react-native';
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
import { Icon } from '@/components/ui/icons/Icon';

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
    /** Content that stays immediately before the pinned controls (after overflow in compact rows). */
    leadingPinnedContent?: React.ReactNode;
    /**
     * Where to render the overflow (ellipsis) trigger on compact layouts.
     * - 'end': after all inline actions (default)
     * - 'beforePinned': between inline actions and pinned actions
     */
    overflowPosition?: 'end' | 'beforePinned';
    overflowPlacement?: PopoverPlacement;
    overflowPortal?: Partial<PopoverPortalOptions>;
    iconSize?: number;
    /**
     * Opt-in override for the visible size of each action control.
     *
     * The default gives every control the platform's minimum interactive target as a visible box,
     * which is right for a list row but too loose for a dense chrome cluster that owns its own
     * rhythm. Overriding it only shrinks the *drawn* box: the press frame below grows back toward
     * the platform minimum as far as the row's own gap allows.
     */
    actionControlSizePx?: number;
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
                    ? <Icon name={action.icon} size={16} color={color} />
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
        props.actionControlSizePx
        ?? (Platform.OS === 'web' || Platform.OS === 'android'
            ? minimumActionTargetSize
            : DEFAULT_ACTION_CONTROL_SIZE),
        iconSize,
    );
    const gap = props.gap ?? 16;

    /**
     * The press frame, when the drawn control is smaller than the platform target.
     *
     * **Not `hitSlop`.** react-native-web 0.21 implements `hitSlop` only in its legacy
     * `Touchable` export — `Pressable` and `View` never read it — and the desktop app *is*
     * the web bundle, which the tablet drawer path also reaches by touch. A slop-declared
     * target there is a target that does not exist. So the frame is real box model: a larger
     * width/height plus an equal negative margin, which grows the pointer box on every
     * platform while the row still measures the drawn size.
     *
     * Two different budgets, because the two axes have different neighbours:
     *
     *  - **Vertical is free.** An icon row has nothing above or below it inside the row, so
     *    the frame takes the whole platform floor (44 on web/iOS, 48dp on Android).
     *  - **Horizontal is bounded by the gap.** Each control may reach at most half the row's
     *    gap on each side, so two adjacent targets meet exactly and never overlap — which
     *    DESIGN.md's accessibility rule forbids outright.
     *
     * CEILING: the desktop sidebar draws 32px controls at `gap: 4`, so its target is 36×44,
     * not 44×44. Four non-overlapping 44px targets need 176px and that cluster is deliberately
     * 140px wide; the requirement that actually governs a dense pointer layout is WCAG 2.2 AA
     * SC 2.5.8 (24×24 CSS px), which 36×44 clears with room. Raising the cluster's width budget
     * to 176px is the exact and only condition that would let the horizontal cap reach 44.
     */
    const targetDeficitPerSide = Math.max(0, (minimumActionTargetSize - actionControlSize) / 2);
    const targetExpandY = targetDeficitPerSide;
    const targetExpandX = Math.min(targetDeficitPerSide, gap / 2);
    const actionControlFrame = React.useMemo(() => {
        const width = actionControlSize + (targetExpandX * 2);
        const height = actionControlSize + (targetExpandY * 2);
        return {
            width,
            height,
            marginHorizontal: -targetExpandX,
            marginVertical: -targetExpandY,
            // The frame carries the focus ring, so it stays a capsule around the narrow axis
            // rather than a rounded rectangle.
            borderRadius: Math.min(width, height) / 2,
        };
    }, [actionControlSize, targetExpandX, targetExpandY]);
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
            <Icon
                name="dots-three"
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
                    <Icon
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
                onPressIn={() => props.onActionPressIn?.()}
                onPress={(e: GestureResponderEvent) => {
                    e?.stopPropagation?.();
                    action.onPress?.();
                }}
                style={(interactionState) => {
                    const webState = interactionState as typeof interactionState & { focused?: boolean };
                    return [
                        styles.actionControl,
                        actionControlFrame,
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
    }, [actionControlFrame, iconSize, props, theme.colors.button.secondary.tint, theme.colors.state.danger.foreground]);

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
                                style={(interactionState) => {
                                    const webState = interactionState as typeof interactionState & { focused?: boolean };
                                    return [
                                        styles.actionControl,
                                        actionControlFrame,
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
                                    <Icon
                                        name="dots-three"
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
    }, [actionControlFrame, blurTintOnWeb, iconSize, overflowActionItems, overflowAnchorOverlay, overflowPlacement, overflowPortal, props, showOverflow, theme.colors.button.secondary.tint]);

    return (
        <View style={[styles.container, { gap }]}>
            {compact ? nonPinnedInlineActions.map(renderInlineAction) : (
                inlineActions.map((action, index) => (
                    <React.Fragment key={action.id}>
                        {props.leadingPinnedContent != null
                            && pinnedIds.has(action.id)
                            && !inlineActions.slice(0, index).some((candidate) => pinnedIds.has(candidate.id))
                            ? <View>{props.leadingPinnedContent}</View>
                            : null}
                        {renderInlineAction(action)}
                    </React.Fragment>
                ))
            )}

            {compact && overflowActions.length > 0 && overflowPosition === 'beforePinned' ? (
                <>
                    {renderOverflow()}
                    {props.leadingPinnedContent != null ? <View>{props.leadingPinnedContent}</View> : null}
                    {pinnedActions.map(renderInlineAction)}
                </>
            ) : null}

            {compact && overflowActions.length > 0 && overflowPosition === 'end' ? (
                <>
                    {props.leadingPinnedContent != null ? <View>{props.leadingPinnedContent}</View> : null}
                    {pinnedActions.map(renderInlineAction)}
                    {renderOverflow()}
                </>
            ) : null}

            {compact && overflowActions.length === 0 && pinnedActions.length > 0 ? (
                <>
                    {props.leadingPinnedContent != null ? <View>{props.leadingPinnedContent}</View> : null}
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
                outlineColor: theme.colors.border.focus,
                outlineOffset: -2,
            },
            default: {},
        }) as object),
    },
}));
