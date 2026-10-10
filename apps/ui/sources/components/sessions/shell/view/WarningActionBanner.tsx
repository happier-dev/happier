import * as React from 'react';
import { Platform, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierBanner, HappierPressable, isHappierBannerUrgent } from '@happier-dev/plugin-ui/presentation';

import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';

import { ITEM_SUBTITLE_TEXT_METRICS, ITEM_TITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import type { Theme } from '@/theme';
import { motionTokens } from '@/components/ui/motion/motionTokens';

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

export type WarningActionBannerProps = Readonly<{
    /** `neutral` covers informational notices; `warning` (default) covers actionable problems. */
    tone?: SessionBannerTone;
    iconName?: IconName | null;
    title?: string;
    body?: string;
    /** Structured details rendered with the banner's copy while this owner retains surface semantics. */
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
    style?: React.ComponentProps<typeof HappierBanner>['style'];
    testID: string;
}>;

const INLINE_ACTIONS_MIN_WIDTH = 720;

/**
 * Share of the banner an inline action block may occupy. The block wraps within that share instead
 * of growing, so a long action run forms a right-aligned grid beside the copy rather than either
 * squeezing the message into a narrow column or dropping below it and leaving the row half empty.
 */
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

const actionBaseStyle = {
    flexShrink: 0,
    maxWidth: '100%',
    minHeight: ACTION_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
} as const satisfies ViewStyle;

export function resolveWarningActionBannerToneTokens(
    theme: Theme,
    tone: SessionBannerTone,
): Readonly<{ background: string; border: string; icon: string }> {
    return tone === 'neutral'
        ? {
            background: theme.colors.state.neutral.background,
            border: theme.colors.state.neutral.border,
            icon: theme.colors.state.neutral.foreground,
        }
        : {
            background: theme.colors.state.warning.background,
            border: theme.colors.state.warning.border,
            icon: theme.colors.state.warning.foreground,
        };
}

export function WarningActionBanner(props: WarningActionBannerProps): React.ReactElement {
    const { theme } = useUnistyles();
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
    const { width } = useWindowDimensions();
    const [measuredWidth, setMeasuredWidth] = React.useState<number | null>(null);
    const availableWidth = typeof measuredWidth === 'number' && measuredWidth > 0 ? measuredWidth : width;
    const handleLayout = React.useCallback((
        event: Parameters<NonNullable<React.ComponentProps<typeof HappierBanner>['onLayout']>>[0],
    ) => {
        const nextWidth = Math.max(0, Math.round(event.nativeEvent.layout.width));
        setMeasuredWidth((current) => current === nextWidth ? current : nextWidth);
    }, []);

    const tone = props.tone ?? 'warning';
    const urgent = isHappierBannerUrgent(tone === 'warning' ? 'warning' : 'neutral');
    // The tinted fill and the icon carry the state; the copy stays in normal text roles so the
    // banner reads as a sentence with a status, not as a block of coloured text.
    const toneTokens = resolveWarningActionBannerToneTokens(theme, urgent ? 'warning' : 'neutral');
    const iconName = props.iconName === null
        ? null
        : props.iconName ?? (tone === 'neutral' ? 'info' : 'warning');

    const hasPrimaryAction = typeof props.onActionPress === 'function'
        && typeof props.actionLabel === 'string'
        && typeof props.actionTestID === 'string';
    const secondaryActions = props.secondaryActions ?? [];
    const inlineActions = availableWidth >= INLINE_ACTIONS_MIN_WIDTH;
    const actionsInTitle = props.actionsPlacement === 'title' && inlineActions && Boolean(props.title);

    const actionsNode = hasPrimaryAction || secondaryActions.length > 0 ? (
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
                maxWidth: inlineActions ? availableWidth / 2 : '100%',
                width: inlineActions ? undefined : '100%',
            }}
        >
            {secondaryActions.map((action) => (
                // The shared pressable owns press, keyboard focus ring and the busy lifecycle of an
                // async action; the banner owns only its compact chrome.
                <HappierPressable
                    key={action.key}
                    testID={action.testID}
                    accessibilityLabel={action.accessibilityLabel}
                    disabled={action.disabled}
                    hitSlop={ACTION_HIT_SLOP}
                    onPress={action.onPress}
                    style={({ pressed, focused }) => [{
                        ...actionBaseStyle,
                        // Concentric with the banner surface: inner radius = outer radius - the inset between them.
                        borderRadius: theme.parts.composer.radius - BANNER_PADDING_VERTICAL,
                        paddingHorizontal: 10,
                        backgroundColor: theme.colors.button.secondary.background,
                        opacity: action.disabled ? 0.45 : pressed ? motionTokens.press.opacity : 1,
                    }, focusRingStyle({ focused, color: theme.colors.border.focus })]}
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
                </HappierPressable>
            ))}
            {hasPrimaryAction ? (
                <HappierPressable
                    testID={props.actionTestID}
                    accessibilityLabel={props.actionAccessibilityLabel ?? props.actionLabel}
                    busy={props.actionBusy}
                    disabled={props.disabled}
                    hitSlop={ACTION_HIT_SLOP}
                    onPress={props.onActionPress!}
                    style={({ pressed, focused }) => [{
                        ...actionBaseStyle,
                        // Concentric with the banner surface: inner radius = outer radius - the inset between them.
                        borderRadius: theme.parts.composer.radius - BANNER_PADDING_VERTICAL,
                        backgroundColor: theme.colors.button.primary.background,
                        opacity: props.disabled ? 0.45 : pressed ? motionTokens.press.opacitySubtle : 1,
                    }, focusRingStyle({ focused, color: theme.colors.border.focus })]}
                >
                    <Text style={{ fontSize: 12, color: theme.colors.button.primary.tint, fontWeight: '600' }}>
                        {props.actionLabel}
                    </Text>
                </HappierPressable>
            ) : null}
        </View>
    ) : null;

    return (
        <HappierBanner
            testID={props.testID}
            onLayout={handleLayout}
            title={props.title ?? props.body ?? ''}
            description={props.body}
            tone={tone === 'warning' ? 'warning' : 'neutral'}
            theme={presentationTheme}
            backgroundColor={toneTokens.background}
            borderColor={toneTokens.border}
            icon={iconName ? <Icon name={iconName} size={16} color={toneTokens.icon} /> : undefined}
            style={[
                {
                    paddingHorizontal: BANNER_PADDING_HORIZONTAL,
                    paddingVertical: BANNER_PADDING_VERTICAL,
                    // The composer stack's radius: the banner and the panel below it round alike.
                    borderRadius: theme.parts.composer.radius,
                },
                props.style,
            ]}
            titleContent={props.title ? (
                <View testID={`${props.testID}-title-row`} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
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
            ) : <></>}
            descriptionContent={props.body ? (
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
            ) : undefined}
            details={<>{props.content}{!inlineActions ? actionsNode : null}</>}
            action={inlineActions && !actionsInTitle ? actionsNode : undefined}
        />
    );
}
