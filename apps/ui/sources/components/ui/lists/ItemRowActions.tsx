import React from 'react';
import { View, Pressable, useWindowDimensions, type GestureResponderEvent, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ITEM_ROW_ACTIONS_COMPACT_THRESHOLD_PX, type ItemAction } from '@/components/ui/lists/itemActions';
import { Popover, type PopoverPlacement, type PopoverPortalOptions } from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { resolveWebBlurTintColor } from '@/components/ui/overlays/resolveWebBlurTintColor';
import { ActionListSection, type ActionListItem } from '@/components/ui/lists/ActionListSection';
import { t } from '@/text';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Icon } from '@/components/ui/icons/Icon';
import type { FocusReturnTarget } from '@/keyboard/focusReturn';
import { resolveHappierFocusRingVisible } from '@happier-dev/plugin-ui/presentation';

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
    overflowTriggerAccessibilityLabel?: string;
    /** A mounted overflow control may own domain shortcuts; descendant text entry is untouched. */
    onOverflowTriggerKeyDown?: (key: string) => boolean;
    /** Replaces one open menu section without mounting custom content while the menu is shut. */
    renderOverflowSection?: (section: Readonly<{ id: string; title: string }>) => React.ReactNode | undefined;
    renderOverflowTrigger?: (props: Readonly<{
        open: boolean;
        toggle: () => void;
        testID?: string;
        accessibilityLabel: string;
        accessibilityHint: string;
        onKeyDown?: (event: OverflowTriggerKeyEvent) => void;
    }>) => React.ReactNode;
    renderOverflowAnchorOverlay?: () => React.ReactNode;
    /** Controlled overflow, for a row that also opens its actions another way (a long press on touch). */
    overflowOpen?: boolean;
    onOverflowOpenChange?: (open: boolean) => void;
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
    /** Exposes the default overflow trigger to an incumbent modal focus-return owner. */
    onOverflowTriggerFocusTargetChange?: (target: FocusReturnTarget) => void;
    /**
     * Optional explicit boundary ref for the popover. Useful when the row is rendered
     * inside a scroll container that should bound the popover sizing/placement.
     * If omitted, Popover falls back to PopoverBoundaryProvider context when present,
     * otherwise it clamps to the window/screen.
     */
    popoverBoundaryRef?: React.RefObject<any> | null;
}

type OverflowTriggerKeyEvent = Readonly<{
    key: string;
    target: unknown;
    currentTarget: unknown;
    preventDefault(): void;
    stopPropagation(): void;
}>;

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
    const compact = widthForCompact < (props.compactThreshold ?? ITEM_ROW_ACTIONS_COMPACT_THRESHOLD_PX);
    const [uncontrolledShowOverflow, setUncontrolledShowOverflow] = React.useState(false);
    const showOverflow = props.overflowOpen ?? uncontrolledShowOverflow;
    const onOverflowOpenChange = props.onOverflowOpenChange;
    const setShowOverflow = React.useCallback((next: boolean | ((current: boolean) => boolean)) => {
        const resolved = typeof next === 'function' ? next(showOverflow) : next;
        if (props.overflowOpen === undefined) setUncontrolledShowOverflow(resolved);
        onOverflowOpenChange?.(resolved);
    }, [onOverflowOpenChange, props.overflowOpen, showOverflow]);
    const overflowAnchorRef = React.useRef<View>(null);
    const onOverflowTriggerKeyDown = React.useCallback((event: OverflowTriggerKeyEvent) => {
        if (event.target !== event.currentTarget || !props.onOverflowTriggerKeyDown?.(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
    }, [props.onOverflowTriggerKeyDown]);

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
                accessibilityLabel: action.accessibilityLabel,
                subtitle: action.subtitle,
                icon: iconNode,
                onPress: onPress ? () => closeThen(onPress) : undefined,
                disabled: action.disabled,
                selected: action.selected,
            };
        });
    }, [closeThen, overflowActions, theme.colors.button.secondary.tint, theme.colors.state.danger.foreground]);

    const overflowActionSections = React.useMemo(() => {
        const sections: Array<Readonly<{
            id: string;
            title: string;
            actions: ActionListItem[];
        }>> = [];
        const sectionById = new Map<string, (typeof sections)[number]>();

        overflowActions.forEach((action, index) => {
            // Ungrouped menus preserve their incumbent single heading and row order.
            const group = action.group ?? { id: '__ungrouped__', title: props.title };
            let section = sectionById.get(group.id);
            if (!section) {
                section = { id: group.id, title: group.title, actions: [] };
                sectionById.set(group.id, section);
                sections.push(section);
            }
            section.actions.push(overflowActionItems[index]!);
        });

        return sections;
    }, [overflowActionItems, overflowActions, props.title]);

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
                    action.onPress?.(e);
                }}
                style={(interactionState) => {
                    const webState = interactionState as typeof interactionState & { focused?: boolean };
                    return [
                        styles.actionControl,
                        actionControlFrame,
                        resolveHappierFocusRingVisible(webState.focused) ? styles.actionControlFocused : null,
                    ];
                }}
                accessibilityRole="button"
                accessibilityLabel={action.accessibilityLabel ?? action.title}
                accessibilityState={{
                    ...(action.disabled || !action.onPress ? { disabled: true } : null),
                    ...(action.expanded !== undefined ? { expanded: action.expanded } : null),
                    ...(action.selected !== undefined ? { selected: action.selected } : null),
                }}
                {...(Platform.OS === 'web' && action.selected !== undefined
                    ? { 'aria-pressed': action.selected }
                    : {})}
            >
                {normalizeNodeForView(
                    iconNode,
                )}
            </Pressable>
        );
    }, [actionControlFrame, iconSize, props, theme.colors.button.secondary.tint, theme.colors.state.danger.foreground]);

    const renderOverflow = React.useCallback(() => {
        const accessibilityLabel = props.overflowTriggerAccessibilityLabel ?? t('common.moreActions');
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
                            ...(Platform.OS === 'web' ? { onKeyDown: onOverflowTriggerKeyDown } : {}),
                        })
                        : (
                            <Pressable
                                ref={(target) => props.onOverflowTriggerFocusTargetChange?.(target)}
                                testID={props.overflowTriggerTestID}
                                style={(interactionState) => {
                                    const webState = interactionState as typeof interactionState & { focused?: boolean };
                                    return [
                                        styles.actionControl,
                                        actionControlFrame,
                                        showOverflow ? { opacity: 0 } : null,
                                        resolveHappierFocusRingVisible(webState.focused) ? styles.actionControlFocused : null,
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
                                {...(Platform.OS === 'web' ? { onKeyDown: onOverflowTriggerKeyDown } : {})}
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
                                {overflowActionSections.map((section) => {
                                    const custom = props.renderOverflowSection?.(section);
                                    return <React.Fragment key={section.id}>{custom === undefined
                                        ? <ActionListSection title={section.title} actions={section.actions} />
                                        : custom}</React.Fragment>;
                                })}
                            </FloatingOverlay>
                        )}
                    </Popover>
                ) : null}
            </View>
        );
    }, [actionControlFrame, blurTintOnWeb, iconSize, onOverflowTriggerKeyDown, overflowActionSections, overflowAnchorOverlay, overflowPlacement, overflowPortal, props, showOverflow, theme.colors.button.secondary.tint]);

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
