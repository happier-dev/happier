import { HAPPIER_FRESHNESS_LINE_METRICS, HappierFreshnessLine, resolveHappierFreshnessText } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { SurfaceStateAction } from './SurfaceStateCard';

const LINK_MIN_TARGET_PX = resolveMinimumInteractiveTargetSize(Platform.OS);

/**
 * Stale content, told honestly (pane-states lab 0, "Stale"): the last-known content stays at full
 * strength and this one quiet line sits under the surface's header — as of when, why, and one Retry.
 *
 * It never sits over an empty body: a surface that has nothing retained is loading or failed and shows
 * `SurfaceStateCard` instead. Rows never dim. Render it only while the content is stale.
 */
export function SurfaceFreshnessLine(props: Readonly<{
    testID?: string;
    /** When the retained content was last read. Omit when the reason alone says it ("Reconnecting…"). */
    asOf?: number | null;
    /** Already-translated reason: "devbox isn't answering", "reconnecting to MacBook Pro…". */
    reason: string;
    /** A reconnect or refresh is in flight: a small ring replaces the glyph. */
    busy?: boolean;
    /** `warning` tints the strip when retained work needs attention. */
    tone?: 'neutral' | 'warning';
    /** The one recovery (Retry). */
    action?: SurfaceStateAction;
    animationEnabled?: boolean;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const text = resolveHappierFreshnessText({
        asOf: props.asOf,
        reason: props.reason,
        formatAsOf: (time) => t('surfaceState.asOf', { time }),
    });
    return (
        <HappierFreshnessLine
            testID={props.testID}
            busy={props.busy}
            colors={props.tone === 'warning'
                ? { background: theme.colors.state.warning.background, border: theme.colors.state.warning.border }
                : { background: theme.colors.surface.inset, border: theme.colors.border.default }}
            icon={props.busy ? (
                <ActivitySpinner
                    testID={props.testID ? `${props.testID}-spinner` : undefined}
                    size={HAPPIER_FRESHNESS_LINE_METRICS.glyphPx - 1}
                    color={theme.colors.text.tertiary}
                    animationEnabled={props.animationEnabled !== false}
                />
            ) : (
                <Icon
                    name={props.tone === 'warning' ? 'warning' : 'arrow-clockwise'}
                    size={HAPPIER_FRESHNESS_LINE_METRICS.glyphPx}
                    color={props.tone === 'warning' ? theme.colors.state.warning.foreground : theme.colors.text.tertiary}
                />
            )}
            action={props.action ? (
                <Pressable
                    testID={props.testID ? `${props.testID}-action` : undefined}
                    accessibilityRole="button"
                    accessibilityLabel={props.action.label}
                    hitSlop={6}
                    onPress={() => { void props.action!.onPress(); }}
                    style={stylesheet.link}
                >
                    <Text style={stylesheet.linkLabel}>{props.action.label}</Text>
                </Pressable>
            ) : null}
        >
            <Text testID={props.testID ? `${props.testID}-text` : undefined} style={stylesheet.text} numberOfLines={2}>
                {text}
            </Text>
        </HappierFreshnessLine>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    text: {
        ...Typography.default(),
        ...HAPPIER_FRESHNESS_LINE_METRICS.text,
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    link: {
        minHeight: Math.min(LINK_MIN_TARGET_PX, HAPPIER_FRESHNESS_LINE_METRICS.minHeightPx),
        justifyContent: 'center',
        paddingHorizontal: 4,
    },
    linkLabel: {
        ...Typography.default('semiBold'),
        ...HAPPIER_FRESHNESS_LINE_METRICS.text,
        color: theme.colors.text.secondary,
        textDecorationLine: 'underline',
    },
}));
