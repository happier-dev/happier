import * as React from 'react';
import { Platform, Pressable, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { COMPOSER_SURFACE_RADIUS } from '@/components/sessions/agentInput/composerContentInset';
import { ITEM_SUBTITLE_TEXT_METRICS, ITEM_TITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

export type SessionBannerTone = 'warning' | 'neutral';

type SessionBannerAction = Readonly<{
    key: string;
    accessibilityLabel: string;
    label: string;
    onPress: () => void | Promise<void>;
    testID: string;
    disabled?: boolean;
    variant?: 'secondary' | 'quiet';
}>;

type SessionWarningActionBannerProps = Readonly<{
    /** `neutral` covers informational notices; `warning` (default) covers actionable problems. */
    tone?: SessionBannerTone;
    iconName?: IconName | null;
    title?: string;
    body?: string;
    content?: React.ReactNode;
    /** On wide composers, align actions with the title instead of centering them beside all copy. */
    actionsPlacement?: 'body' | 'title';
    /** Primary action. Omitted for notice-style banners that carry no action. */
    actionAccessibilityLabel?: string;
    actionLabel?: string;
    actionTestID?: string;
    onActionPress?: () => void | Promise<void>;
    disabled?: boolean;
    /** Announced to assistive tech while the primary action's work is in flight. */
    actionBusy?: boolean;
    secondaryActions?: ReadonlyArray<SessionBannerAction>;
    style?: StyleProp<ViewStyle>;
    testID: string;
}>;

const INLINE_ACTIONS_MIN_WIDTH = 720;

/**
 * Share of the banner an inline action block may occupy. The block wraps within that share instead
 * of growing, so a long action run forms a right-aligned grid beside the copy rather than either
 * squeezing the message into a narrow column or dropping below it and leaving the row half empty.
 */
const INLINE_ACTIONS_MAX_WIDTH = '50%';

const BANNER_PADDING_HORIZONTAL = 14;
const BANNER_PADDING_VERTICAL = 10;

/**
 * Visual control minimum height. Banners sit in the composer stack where a full-height button
 * would out-weigh its copy, but a fixed height clips an action when the reader increases their
 * text size. The tappable area is extended to the platform minimum through `hitSlop` instead, so
 * pointer devices keep a refined control and touch devices still get a forgiving target.
 */
const ACTION_HEIGHT = 28;
const ACTION_TOUCH_TARGET = Platform.OS === 'android' ? 48 : 44;
const ACTION_HIT_SLOP_VERTICAL = Math.round((ACTION_TOUCH_TARGET - ACTION_HEIGHT) / 2);
const ACTION_HIT_SLOP = {
    top: ACTION_HIT_SLOP_VERTICAL,
    bottom: ACTION_HIT_SLOP_VERTICAL,
    left: 4,
    right: 4,
} as const;

// Concentric with the banner surface: inner radius = outer radius - the inset between them.
const ACTION_RADIUS = COMPOSER_SURFACE_RADIUS - BANNER_PADDING_VERTICAL;

const actionBaseStyle = {
    flexShrink: 0,
    maxWidth: '100%',
    minHeight: ACTION_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: ACTION_RADIUS,
} as const satisfies ViewStyle;

export function SessionWarningActionBanner(props: SessionWarningActionBannerProps): React.ReactElement {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const [measuredWidth, setMeasuredWidth] = React.useState<number | null>(null);
    const availableWidth = typeof measuredWidth === 'number' && measuredWidth > 0 ? measuredWidth : width;
    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        const nextWidth = Math.max(0, Math.round(event.nativeEvent.layout.width));
        setMeasuredWidth((current) => current === nextWidth ? current : nextWidth);
    }, []);

    const tone = props.tone ?? 'warning';
    // The tinted fill and the icon carry the state; the copy stays in normal text roles so the
    // banner reads as a sentence with a status, not as a block of coloured text.
    const toneTokens = tone === 'neutral'
        ? {
            background: theme.colors.state.neutral.background,
            icon: theme.colors.state.neutral.foreground,
            border: theme.colors.state.neutral.border,
        }
        : {
            background: theme.colors.state.warning.background,
            icon: theme.colors.state.warning.foreground,
            border: theme.colors.state.warning.border,
        };
    const iconName = props.iconName === null
        ? null
        : props.iconName ?? (tone === 'neutral' ? 'info' : 'warning');

    const hasPrimaryAction = typeof props.onActionPress === 'function'
        && typeof props.actionLabel === 'string'
        && typeof props.actionTestID === 'string';
    const secondaryActions = props.secondaryActions ?? [];
    const hasActions = hasPrimaryAction || secondaryActions.length > 0;
    const inlineActions = availableWidth >= INLINE_ACTIONS_MIN_WIDTH;
    const actionsInTitle = props.actionsPlacement === 'title' && inlineActions;

    const actionsNode = hasActions ? (
        <View
            testID={`${props.testID}-actions-row`}
            style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                flexShrink: 1,
                alignItems: 'center',
                columnGap: 4,
                rowGap: 6,
                justifyContent: 'flex-end',
                maxWidth: inlineActions ? INLINE_ACTIONS_MAX_WIDTH : '100%',
                width: inlineActions ? undefined : '100%',
            }}
        >
            {secondaryActions.map((action) => (
                <Pressable
                    key={action.key}
                    testID={action.testID}
                    accessibilityRole="button"
                    accessibilityLabel={action.accessibilityLabel}
                    disabled={action.disabled}
                    hitSlop={ACTION_HIT_SLOP}
                    onPress={action.disabled ? undefined : action.onPress}
                    style={({ pressed }) => ({
                        ...actionBaseStyle,
                        paddingHorizontal: 10,
                        backgroundColor: theme.colors.button.secondary.background,
                        opacity: action.disabled ? 0.45 : pressed ? 0.6 : 1,
                    })}
                >
                    <Text style={{
                        fontSize: 12,
                        color: action.variant === 'quiet'
                            ? theme.colors.text.secondary
                            : theme.colors.button.secondary.tint,
                        fontWeight: '600',
                    }}>
                        {action.label}
                    </Text>
                </Pressable>
            ))}
            {hasPrimaryAction ? (
                <Pressable
                    testID={props.actionTestID}
                    accessibilityRole="button"
                    accessibilityLabel={props.actionAccessibilityLabel ?? props.actionLabel}
                    accessibilityState={{ busy: props.actionBusy, disabled: props.disabled }}
                    disabled={props.disabled}
                    hitSlop={ACTION_HIT_SLOP}
                    onPress={props.disabled ? undefined : props.onActionPress}
                    style={({ pressed }) => ({
                        ...actionBaseStyle,
                        backgroundColor: theme.colors.button.primary.background,
                        opacity: props.disabled ? 0.45 : pressed ? 0.8 : 1,
                    })}
                >
                    <Text style={{ fontSize: 12, color: theme.colors.button.primary.tint, fontWeight: '600' }}>
                        {props.actionLabel}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    ) : null;

    return (
        <View
            testID={props.testID}
            role={tone === 'warning' ? 'alert' : 'status'}
            accessibilityLiveRegion={tone === 'warning' ? 'assertive' : 'polite'}
            onLayout={handleLayout}
            style={[
                {
                    flexDirection: inlineActions && !actionsInTitle ? 'row' : 'column',
                    alignItems: inlineActions && !actionsInTitle ? 'center' : 'stretch',
                    paddingHorizontal: BANNER_PADDING_HORIZONTAL,
                    paddingVertical: BANNER_PADDING_VERTICAL,
                    backgroundColor: toneTokens.background,
                    borderRadius: COMPOSER_SURFACE_RADIUS,
                    // Bounded exactly like the composer panel below it: hairline surface border,
                    // no cast shadow. The panel deliberately carries no drop shadow outside glass
                    // mode, so a shadow here would make the banner float off its own stack.
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: toneTokens.border,
                    gap: hasActions && !actionsInTitle ? (inlineActions ? 12 : 8) : 0,
                },
                props.style,
            ]}
        >
            <View
                testID={`${props.testID}-copy-row`}
                style={{
                    flexDirection: 'row',
                    // Anchored to the first line rather than the block's centre, so the icon stays
                    // beside the title as the body wraps to two or three lines.
                    alignItems: 'flex-start',
                    gap: 9,
                    flex: inlineActions && !actionsInTitle ? 1 : undefined,
                    minWidth: 0,
                    width: inlineActions && !actionsInTitle ? undefined : '100%',
                }}
            >
                {iconName ? (
                    // Optical nudge: the glyph's ink sits above its box centre next to the title.
                    <Icon name={iconName} size={16} color={toneTokens.icon} style={{ marginTop: 1 }} />
                ) : null}
                {/* Title/body separation matches `Item`: iOS needs a hair of space under the
                    title, elsewhere the subtitle line-height already provides it. */}
                <View style={{ flex: 1, minWidth: 0, gap: Platform.select({ ios: 2, default: 0 }) }}>
                    {props.title ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                            <Text
                                selectable
                                style={{
                                    ...ITEM_TITLE_TEXT_METRICS.compact,
                                    color: theme.colors.text.primary,
                                    fontWeight: '600',
                                    flexShrink: 1,
                                }}
                            >
                                {props.title}
                            </Text>
                            {actionsInTitle ? actionsNode : null}
                        </View>
                    ) : null}
                    {props.body ? (
                        <Text
                            selectable
                            style={{
                                ...ITEM_SUBTITLE_TEXT_METRICS.compact,
                                color: theme.colors.text.secondary,
                                // Quotas, reset times, and countdowns live in this copy; tabular
                                // figures keep it from twitching as they tick.
                                fontVariant: ['tabular-nums'],
                            }}
                        >
                            {props.body}
                        </Text>
                    ) : null}
                    {props.content}
                </View>
            </View>
            {hasActions && !actionsInTitle ? actionsNode : null}
        </View>
    );
}
